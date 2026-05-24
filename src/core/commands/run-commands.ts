import type { CommandHandler } from '../../types/commands.js';
import type { Run } from '../../types/runs.js';
import { isAiActiveStage } from '../run-ai-context.js';

function findRun(runs: Map<string, Run>, requestId: string | undefined, idArg: string | undefined): Run | undefined {
  if (requestId) {
    return runs.get(requestId);
  }
  if (idArg) {
    // Try by request_id first, then by run.id
    const byRequestId = runs.get(idArg);
    if (byRequestId) return byRequestId;
    return [...runs.values()].find(r => r.id === idArg);
  }
  return undefined;
}

function formatTimeSince(isoDate: string): string {
  const ms = Math.max(0, Date.now() - new Date(isoDate).getTime());
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatWorkspacePath(workspacePath: string): string {
  const trimmed = workspacePath.trim();
  return trimmed ? `\`${trimmed}\`` : 'not yet allocated';
}

function formatLastRequest(isoDate: string | undefined): string {
  if (!isoDate) return 'not yet requested';
  return `${formatTimeSince(isoDate)} ago`;
}

export function makeRunStatusHandler(runs: Map<string, Run>): CommandHandler {
  return async (event, reply) => {
    const requestId = event.inferred_context?.request_id;
    const idArg = event.args[0];

    if (!requestId && !idArg) {
      await reply('No run found in this thread. Use `:ac-run-list:` to see all active runs, or provide a run ID as an argument.');
      return;
    }

    const run = findRun(runs, requestId, idArg);
    if (!run) {
      await reply('no active run found with that ID. Use `:ac-run-list:` to see all active runs.');
      return;
    }

    const timeInStage = formatTimeSince(run.updated_at);
    const stageSuffix = run.stage === 'done' ? ' ✓ (complete)' : run.stage === 'failed' ? ' ✗ (failed)' : '';

    const lines = [
      `*Run:* \`${run.id}\``,
      `*Workspace:* ${formatWorkspacePath(run.workspace_path)}`,
      `*Intent:* \`${run.intent}\``,
      `*Stage:* \`${run.stage}\`${stageSuffix}`,
      `*Time in stage:* ${timeInStage}`,
    ];

    if (isAiActiveStage(run.stage)) {
      lines.push(`*Model:* ${run.current_model ? `\`${run.current_model}\`` : 'not yet requested'}`);
      lines.push(`*Last request:* ${formatLastRequest(run.last_agent_request_at)}`);
    }

    await reply(lines.join('\n'));
  };
}

export function makeRunListHandler(runs: Map<string, Run>): CommandHandler {
  return async (_event, reply) => {
    const active = [...runs.values()].filter(r => r.stage !== 'done' && r.stage !== 'failed');
    if (active.length === 0) {
      await reply('No active runs.');
      return;
    }
    const lines = active.map(r => `• \`${r.id}\` — \`${r.stage}\` (${r.intent})`);
    await reply(`*Active runs (${active.length}):*\n${lines.join('\n')}`);
  };
}

export function makeRunCancelHandler(
  runs: Map<string, Run>,
  cancelRun: (requestId: string) => 'cancelled' | 'already_terminal' | 'not_found',
): CommandHandler {
  return async (event, reply) => {
    const requestId = event.inferred_context?.request_id;
    const idArg = event.args[0];

    if (!requestId && !idArg) {
      await reply('No run found in this thread. Provide a run ID as an argument or use this command inside a run thread.');
      return;
    }

    const run = findRun(runs, requestId, idArg);
    if (!run) {
      await reply('no active run found with that ID. Use `:ac-run-list:` to see active runs.');
      return;
    }

    const result = cancelRun(run.request_id);
    if (result === 'cancelled') {
      await reply(`Run \`${run.id}\` has been cancelled.`);
    } else if (result === 'already_terminal') {
      await reply(`Run \`${run.id}\` is no longer active (current stage: \`${run.stage}\`).`);
    } else {
      await reply('No active run found. Use `:ac-run-list:` to see active runs.');
    }
  };
}

export function makeRunLogsHandler(
  runs: Map<string, Run>,
  getRunLogs: (requestId: string) => string[],
): CommandHandler {
  return async (event, reply) => {
    const requestId = event.inferred_context?.request_id;
    const idArg = event.args[0];

    if (!requestId && !idArg) {
      await reply('No run found in this thread. Provide a run ID as an argument or use this command inside a run thread.');
      return;
    }

    const run = findRun(runs, requestId, idArg);
    if (!run) {
      await reply('no active run found with that ID. Use `:ac-run-list:` to see active runs.');
      return;
    }

    const logs = getRunLogs(run.request_id);
    if (logs.length === 0) {
      await reply(`No log entries found for run \`${run.id}\`.`);
      return;
    }

    const tail = logs.slice(-20);
    await reply(`*Log tail for run \`${run.id}\`:*\n\`\`\`\n${tail.join('\n')}\n\`\`\``);
  };
}
