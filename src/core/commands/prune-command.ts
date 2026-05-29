import type { CommandHandler, CommandEvent } from '../../types/commands.js';
import type { Run } from '../../types/runs.js';
import type { ChannelRepoMap } from '../../types/config.js';
import type { CommandConfirmationRegistry } from '../command-confirmations.js';
import type { WorkspacePruner } from '../workspace-pruner.js';
import { WorkspacePathGuardError, assertDirectWorkspaceChild } from '../workspace-pruner.js';
import type { ThreadPruner } from '../../types/thread-pruner.js';
import type pino from 'pino';

export interface PruneConfirmationPayload {
  mode: 'completed' | 'explicit';
  request_ids: string[];
  allow_active: boolean;
}

export interface PruneCommandDeps {
  runs: Map<string, Run>;
  confirmationRegistry: CommandConfirmationRegistry<PruneConfirmationPayload>;
  workspacePruner: WorkspacePruner;
  threadPruner?: ThreadPruner;
  channelRepoMap: ChannelRepoMap;
  persist: () => void;
  logger: Pick<pino.Logger, 'info' | 'warn' | 'error'>;
}

const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const TERMINAL_PRUNE_STAGES = new Set<string>(['done', 'failed']);

function usage(): string {
  return 'Usage: `:ac-prune: completed` or `:ac-prune: <run-id> [...] [--active]`';
}

function sameChannel(run: Run, event: CommandEvent): boolean {
  return run.channel?.provider === event.channel.provider && run.channel?.id === event.channel.id;
}

function findRunByAnyId(runs: Map<string, Run>, id: string): Run | undefined {
  return runs.get(id) ?? [...runs.values()].find(run => run.id === id);
}

export function makePruneHandler(deps: PruneCommandDeps): CommandHandler {
  return async (event, reply) => {
    // Sweep expired confirmations
    const sweptCount = deps.confirmationRegistry.sweepExpired(new Date(event.received_at));
    if (sweptCount > 0) {
      deps.logger.info({ event: 'prune.expired', count: sweptCount }, 'Expired prune confirmations swept');
    }

    const { args } = event;
    const hasActive = args.includes('--active');
    const positional = args.filter(a => a !== '--active');

    if (positional.length === 0) {
      await reply(usage());
      deps.logger.info({ event: 'prune.preview_rejected' }, 'Prune preview rejected: no positional args');
      return;
    }

    let selectedRuns: Run[];

    if (positional[0] === 'completed') {
      // Completed mode: select done runs in this channel
      const candidates = [...deps.runs.values()].filter(
        run => run.stage === 'done' && sameChannel(run, event),
      );
      candidates.sort((a, b) => {
        const timeDiff = a.updated_at.localeCompare(b.updated_at);
        if (timeDiff !== 0) return timeDiff;
        return a.request_id.localeCompare(b.request_id);
      });

      if (candidates.length === 0) {
        await reply('No completed runs found to prune.');
        return;
      }

      selectedRuns = candidates;
    } else {
      // Explicit mode: resolve each ID
      const resolved: Run[] = [];
      const unknownIds: string[] = [];

      for (const id of positional) {
        const run = findRunByAnyId(deps.runs, id);
        if (!run) {
          unknownIds.push(id);
        } else {
          resolved.push(run);
        }
      }

      if (unknownIds.length > 0) {
        await reply(`Unknown run IDs: ${unknownIds.join(', ')}`);
        deps.logger.info({ event: 'prune.preview_rejected', unknown_ids: unknownIds }, 'Prune preview rejected: unknown IDs');
        return;
      }

      // Deduplicate by request_id, preserving argument order
      const seen = new Set<string>();
      const deduped: Run[] = [];
      for (const run of resolved) {
        if (!seen.has(run.request_id)) {
          seen.add(run.request_id);
          deduped.push(run);
        }
      }

      // Check for non-terminal runs without --active
      const nonTerminal = deduped.filter(run => !TERMINAL_PRUNE_STAGES.has(run.stage));
      if (nonTerminal.length > 0 && !hasActive) {
        const lines = nonTerminal.map(run => `  - \`${run.request_id}\` — stage \`${run.stage}\``).join('\n');
        await reply(`The following runs are not in a terminal stage. Use \`--active\` to include them:\n${lines}`);
        deps.logger.info({ event: 'prune.preview_rejected', non_terminal: nonTerminal.map(r => r.request_id) }, 'Prune preview rejected: non-terminal runs');
        return;
      }

      selectedRuns = deduped;
    }

    // Create pending confirmation
    const expiresAt = new Date(new Date(event.received_at).getTime() + CONFIRMATION_TTL_MS).toISOString();
    const mode = positional[0] === 'completed' ? 'completed' : 'explicit';
    deps.confirmationRegistry.create({
      command: 'prune',
      conversation: event.conversation,
      requested_by: event.author,
      expires_at: expiresAt,
      payload: {
        mode,
        request_ids: selectedRuns.map(r => r.request_id),
        allow_active: hasActive,
      },
    });

    // Format preview text
    const runLines = selectedRuns.map(run => {
      const shortId = run.id.slice(0, 7);
      const isActive = !TERMINAL_PRUNE_STAGES.has(run.stage);
      const activeMarker = isActive ? ' — ACTIVE stage' : '';
      const workspacePath = run.workspace_path ? run.workspace_path : '(none)';
      const channelId = run.conversation?.channel_id ?? '(unknown)';
      const conversationId = run.conversation?.conversation_id ?? '(unknown)';
      return `• run \`${shortId}...\` (\`${run.request_id}\`) — stage \`${run.stage}\`${activeMarker}\n  workspace: \`${workspacePath}\`\n  conversation thread: ${channelId} / ${conversationId}`;
    }).join('\n\n');

    const previewText = `Prune preview — reply \`Yes\` in this thread to delete these resources. Anything else cancels.\n\n${runLines}\n\nThis will delete workspace directories, attempt to delete conversation thread messages, and remove the listed run records from runs.json. This cannot be undone.`;

    deps.logger.info(
      { event: 'prune.preview_created', mode, count: selectedRuns.length, author: event.author, channel_id: event.channel.id },
      'Prune preview created',
    );

    await reply(previewText);
  };
}

export function makePruneConfirmHandler(deps: PruneCommandDeps): CommandHandler {
  return async (event, reply) => {
    // Get the response text from messageText or args
    const response = event.messageText ?? event.args.join(' ');

    // Consume the pending confirmation
    const consumed = deps.confirmationRegistry.consume(
      event.conversation,
      event.author,
      response,
      new Date(event.received_at),
    );

    if (!consumed) {
      await reply('No pending prune confirmation.');
      return;
    }

    // If not exact 'Yes', cancel
    if (response !== 'Yes') {
      deps.logger.info({ event: 'prune.cancelled', author: event.author }, 'Prune cancelled');
      await reply('Prune cancelled.');
      return;
    }

    // Execute the prune
    deps.logger.info({ event: 'prune.confirmed', author: event.author, count: consumed.payload.request_ids.length }, 'Prune confirmed');

    const { payload } = consumed;
    const okItems: string[] = [];
    const failedItems: string[] = [];

    for (const requestId of payload.request_ids) {
      deps.logger.info({ event: 'prune.item_started', request_id: requestId }, 'Prune item started');

      // Re-read run from live runs map
      const run = deps.runs.get(requestId);
      if (!run) {
        failedItems.push(`\`${requestId}\` — run no longer found`);
        deps.logger.warn({ event: 'prune.item_failed', request_id: requestId, reason: 'not_found' }, 'Run not found');
        continue;
      }

      // Re-validate: completed mode runs must still be 'done'
      if (payload.mode === 'completed' && run.stage !== 'done') {
        failedItems.push(`\`${requestId}\` — stage changed from \`done\` to \`${run.stage}\``);
        deps.logger.warn({ event: 'prune.item_failed', request_id: requestId, reason: 'stage_changed' }, 'Run stage changed');
        continue;
      }

      // Re-validate: non-terminal runs require allow_active
      const isNonTerminal = !TERMINAL_PRUNE_STAGES.has(run.stage);
      if (isNonTerminal && !payload.allow_active) {
        failedItems.push(`\`${requestId}\` — run is non-terminal but --active not set`);
        deps.logger.warn({ event: 'prune.item_failed', request_id: requestId, reason: 'non_terminal' }, 'Run is non-terminal');
        continue;
      }

      // Validate workspace path and delete workspace
      let workspaceResult: Awaited<ReturnType<typeof deps.workspacePruner.prune>> | null = null;

      if (run.workspace_path) {
        // Resolve workspace root from channelRepoMap
        let workspaceRoot: string | undefined;
        if (run.channel) {
          const channelKey = `${run.channel.provider}:${run.channel.id}`;
          workspaceRoot = deps.channelRepoMap.get(channelKey)?.workspace_root;
        }

        if (!workspaceRoot) {
          // Legacy: try to find workspace_root from any configured root
          // Accept only if workspace_path is direct child of exactly one root
          const allRoots = [...new Set([...deps.channelRepoMap.values()].map(e => e.workspace_root))];
          const matchingRoots = allRoots.filter(root => {
            try {
              assertDirectWorkspaceChild(root, run.workspace_path!);
              return true;
            } catch {
              return false;
            }
          });
          if (matchingRoots.length === 1) {
            workspaceRoot = matchingRoots[0];
          }
        }

        if (!workspaceRoot) {
          failedItems.push(`\`${requestId}\` — could not determine workspace root for path validation`);
          deps.logger.warn({ event: 'prune.item_failed', request_id: requestId, reason: 'no_workspace_root' }, 'No workspace root found');
          continue;
        }

        workspaceResult = await deps.workspacePruner.prune({
          run_id: run.id,
          request_id: run.request_id,
          workspace_root: workspaceRoot,
          workspace_path: run.workspace_path,
          mode: 'manual',
        });

        if (workspaceResult.status === 'rejected' || workspaceResult.status === 'failed') {
          const errMsg = workspaceResult.status === 'rejected'
            ? workspaceResult.error.message
            : String(workspaceResult.error);
          failedItems.push(`\`${requestId}\` — workspace deletion failed: ${errMsg}`);
          deps.logger.warn({ event: 'prune.item_failed', request_id: requestId, reason: workspaceResult.status }, 'Workspace deletion failed');
          continue;
        }
      }

      // Best-effort conversation thread deletion
      let threadSummary = '';
      if (run.conversation && deps.threadPruner) {
        const threadResult = await deps.threadPruner.pruneThread(run.conversation);
        if (threadResult.status === 'partial') {
          threadSummary = `thread partially deleted: ${threadResult.failed_messages.length} message(s) failed`;
        } else if (threadResult.status === 'failed') {
          threadSummary = `thread deletion failed: ${threadResult.errors[0] ?? 'unknown error'}`;
        } else if (threadResult.status === 'ok') {
          threadSummary = 'conversation thread deleted';
        }
      }

      // Hard-delete run record
      deps.runs.delete(run.request_id);
      deps.persist();

      // Build OK summary line
      const parts: string[] = [];
      if (workspaceResult) {
        parts.push(workspaceResult.status === 'missing' ? 'workspace missing (skipped)' : 'workspace deleted');
      }
      if (threadSummary) parts.push(threadSummary);
      parts.push('run record removed');

      okItems.push(`\`${requestId}\` — ${parts.join(', ')}`);
      deps.logger.info({ event: 'prune.item_completed', request_id: requestId }, 'Prune item completed');
    }

    // Build summary
    const lines: string[] = ['Prune complete.'];
    if (okItems.length > 0) {
      lines.push('\nOK:');
      for (const item of okItems) lines.push(`• ${item}`);
    }
    if (failedItems.length > 0) {
      lines.push('\nFailed:');
      for (const item of failedItems) lines.push(`• ${item}`);
    }

    deps.logger.info({ event: 'prune.completed', ok: okItems.length, failed: failedItems.length }, 'Prune completed');
    await reply(lines.join('\n'));
  };
}
