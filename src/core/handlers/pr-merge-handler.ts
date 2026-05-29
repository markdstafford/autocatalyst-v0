import type pino from 'pino';
import type { PRManager } from '../../types/issue-tracker.js';
import type { ThreadMessage } from '../../types/events.js';
import type { Run, RunStage } from '../../types/runs.js';
import type { ConversationRef } from '../../types/channel.js';
import type { WorkspacePruner } from '../workspace-pruner.js';

export interface PrMergeDeps {
  prManager: Pick<PRManager, 'mergePR'>;
  postMessage: (conversation: ConversationRef, text: string) => Promise<void>;
  transition: (run: Run, stage: RunStage) => void;
  failRun: (run: Run, conversation: ConversationRef, error: unknown) => Promise<void>;
  reactToRunMessage?: (run: Run, reaction: string) => Promise<void>;
  reacjiComplete?: string | null;
  logger: Pick<pino.Logger, 'warn' | 'error' | 'info'>;
  autoPruneWorkspace?: boolean;
  workspacePruner?: Pick<WorkspacePruner, 'prune'>;
  workspaceRootForRun?: (run: Run) => string | undefined;
  persist?: () => void;
}

export type PrMergeResult =
  | { status: 'done' }
  | { status: 'missing_pr_url' }
  | { status: 'failed' };

export class PrMergeHandler {
  constructor(private readonly deps: PrMergeDeps) {}

  async handle(run: Run, feedback: ThreadMessage): Promise<PrMergeResult> {
    if (!run.pr_url) {
      this.deps.logger.warn(
        { event: 'pr.merge_missing_url', run_id: run.id, request_id: run.request_id },
        'pr_url is undefined on run; cannot merge',
      );
      try {
        await this.deps.postMessage(
          feedback.conversation,
          'Cannot merge: no PR URL is associated with this run.',
        );
      } catch (notifyErr) {
        this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(notifyErr) }, 'Failed to post PR URL missing error');
      }
      return { status: 'missing_pr_url' };
    }

    try {
      await this.deps.prManager.mergePR(run.workspace_path, run.pr_url);
    } catch (err) {
      await this.deps.failRun(run, feedback.conversation, err);
      return { status: 'failed' };
    }

    try {
      await this.deps.postMessage(feedback.conversation, 'PR merged.');
    } catch (err) {
      this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post PR merged notification');
    }

    this.deps.transition(run, 'done');
    if (this.deps.reacjiComplete) {
      this.deps.reactToRunMessage?.(run, this.deps.reacjiComplete).catch(err => {
        this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post completion reaction');
      });
    }
    // Auto-prune workspace after successful merge - fire and forget (non-blocking)
    this.autoPruneWorkspace(run).catch(err => {
      this.deps.logger.error({ event: 'workspace.auto_prune_failed', run_id: run.id, error: String(err) }, 'Auto-prune threw unexpectedly');
    });
    return { status: 'done' };
  }

  private async autoPruneWorkspace(run: Run): Promise<void> {
    if (this.deps.autoPruneWorkspace === false) return;
    if (!this.deps.workspacePruner || !this.deps.workspaceRootForRun || !this.deps.persist) return;

    const workspaceRoot = this.deps.workspaceRootForRun(run);
    if (!workspaceRoot) {
      this.deps.logger.warn(
        { event: 'workspace.auto_prune_failed', run_id: run.id, request_id: run.request_id },
        'Could not determine workspace root for auto-prune',
      );
      return;
    }

    this.deps.logger.info(
      { event: 'workspace.auto_prune_started', run_id: run.id, request_id: run.request_id, workspace_path: run.workspace_path },
      'Auto-pruning workspace after merge',
    );

    const result = await this.deps.workspacePruner.prune({
      run_id: run.id,
      request_id: run.request_id,
      workspace_root: workspaceRoot,
      workspace_path: run.workspace_path,
      mode: 'auto',
      allowEmpty: true,
    });

    if (result.status === 'deleted' || result.status === 'missing' || result.status === 'skipped') {
      run.workspace_path = '';
      run.updated_at = new Date().toISOString();
      this.deps.persist();
      this.deps.logger.info(
        { event: 'workspace.auto_pruned', run_id: run.id, request_id: run.request_id, prune_status: result.status },
        'Workspace auto-pruned after merge',
      );
    } else {
      this.deps.logger.warn(
        { event: 'workspace.auto_prune_failed', run_id: run.id, request_id: run.request_id, prune_status: result.status },
        'Workspace auto-prune failed after merge',
      );
    }
  }
}
