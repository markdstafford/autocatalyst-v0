import type pino from 'pino';
import type { IssueFiler, FilingResult } from '../../types/issue-filing.js';
import type { WorkspaceManager } from '../workspace-manager.js';
import type { ChannelRepoMap } from '../../types/config.js';
import type { Request } from '../../types/events.js';
import type { Run, RunStage } from '../../types/runs.js';
import { channelKey, type ConversationRef } from '../../types/channel.js';
import { makeRunAgentRequestRecorder } from '../run-ai-context.js';
import type { AgentSessionCaptureFn } from '../../types/ai.js';
import type { RunJournal } from '../journal/run-journal.js';

export interface IssueFilingDeps {
  workspaceManager: Pick<WorkspaceManager, 'create' | 'destroy'>;
  issueFiler: Pick<IssueFiler, 'file'>;
  channelRepoMap: ChannelRepoMap;
  postMessage: (conversation: ConversationRef, text: string) => Promise<void>;
  transition: (run: Run, stage: RunStage) => void;
  failRun: (run: Run, conversation: ConversationRef, error: unknown) => Promise<void>;
  persist?: () => void;
  reactToRunMessage?: (run: Run, reaction: string) => Promise<void>;
  reacjiComplete?: string | null;
  logger: Pick<pino.Logger, 'info' | 'warn' | 'error'>;
  journal?: Pick<RunJournal, 'captureSession'>;
}

export type IssueFilingResult = { status: 'done' } | { status: 'failed' };

export class IssueFilingHandler {
  constructor(private readonly deps: IssueFilingDeps) {}

  async handle(run: Run, request: Request): Promise<IssueFilingResult> {
    this.deps.transition(run, 'speccing');
    this.deps.logger.info(
      { event: 'filing.started', run_id: run.id, request_id: run.request_id },
      'Filing pipeline started',
    );

    let workspace_path: string;
    let branch: string;
    try {
      const repoEntry = this.deps.channelRepoMap.get(channelKey(request.channel))!;
      ({ workspace_path, branch } = await this.deps.workspaceManager.create(request.id, repoEntry.repo_url, repoEntry.workspace_root));
      run.workspace_path = workspace_path;
      run.branch = branch;
    } catch (err) {
      await this.deps.failRun(run, request.conversation, err);
      return { status: 'failed' };
    }

    const onProgress = (message: string): Promise<void> =>
      this.deps.postMessage(request.conversation, message).catch(err => {
        this.deps.logger.warn(
          { event: 'progress_failed', phase: 'filing', run_id: run.id, error: String(err) },
          'Failed to post progress update',
        );
      });

    const onAgentRequest = this.deps.persist
      ? makeRunAgentRequestRecorder(run, this.deps.persist, this.deps.logger)
      : undefined;

    let result: FilingResult;
    try {
      const captureSession: AgentSessionCaptureFn | undefined = this.deps.journal
        ? (data) => { void this.deps.journal!.captureSession({ ...data, run, round: 1 }).catch(() => {}); }
        : undefined;
      result = await this.deps.issueFiler.file(request, workspace_path, onProgress, { run_id: run.id, request_id: run.request_id, onAgentRequest, captureSession });
    } catch (err) {
      await this.deps.workspaceManager.destroy(workspace_path);
      await this.deps.failRun(run, request.conversation, err);
      return { status: 'failed' };
    }

    for (const issue of result.filed_issues) {
      if (issue.action === 'filed') {
        this.deps.logger.info(
          { event: 'filing.issue_filed', run_id: run.id, request_id: run.request_id, issue_number: issue.number, issue_title: issue.title },
          'Issue filed',
        );
      } else {
        this.deps.logger.info(
          { event: 'filing.duplicate_detected', run_id: run.id, request_id: run.request_id, existing_issue_number: issue.number, existing_issue_title: issue.title },
          'Duplicate issue detected',
        );
      }
    }

    await this.deps.workspaceManager.destroy(workspace_path).catch(err =>
      this.deps.logger.warn({ event: 'workspace.destroy_failed', run_id: run.id, error: String(err) }, 'Failed to destroy workspace after filing'),
    );

    if (result.status === 'failed') {
      await this.deps.failRun(run, request.conversation, new Error(result.error ?? 'Filing failed'));
      return { status: 'failed' };
    }

    try {
      await this.deps.postMessage(request.conversation, result.summary);
    } catch (err) {
      this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post filing summary');
    }

    const filed_count = result.filed_issues.filter(i => i.action === 'filed').length;
    const duplicate_count = result.filed_issues.filter(i => i.action === 'duplicate').length;
    this.deps.logger.info(
      { event: 'filing.complete', run_id: run.id, request_id: run.request_id, filed_count, duplicate_count },
      'Filing pipeline complete',
    );
    this.deps.transition(run, 'done');
    if (this.deps.reacjiComplete) {
      this.deps.reactToRunMessage?.(run, this.deps.reacjiComplete).catch(err => {
        this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post completion reaction');
      });
    }
    return { status: 'done' };
  }
}
