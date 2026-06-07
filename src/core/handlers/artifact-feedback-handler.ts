import { readFile, writeFile } from 'node:fs/promises';
import type pino from 'pino';
import type { ArtifactAuthoringAgent, AgentSessionCaptureFn } from '../../types/ai.js';
import type { ThreadMessage } from '../../types/events.js';
import type { FeedbackSource } from '../../types/feedback-source.js';
import type { ArtifactContentSource, ArtifactPublisher } from '../../types/publisher.js';
import type { Run, RunStage } from '../../types/runs.js';
import type { ConversationRef } from '../../types/channel.js';
import { requireArtifactRefs } from '../run-refs.js';
import type { BranchGuard } from '../git-branch-guard.js';
import type { SpecReviewCoordinator } from '../ai/spec-review-coordinator.js';
import { makeRunAgentRequestRecorder } from '../run-ai-context.js';
import type { RunJournal } from '../journal/run-journal.js';
import { removeConvergedApiSection } from '../ai/authoring-api-artifact.js';

export interface ArtifactFeedbackDeps {
  artifactAuthoringAgent: Pick<ArtifactAuthoringAgent, 'revise'>;
  artifactPublisher: Pick<ArtifactPublisher, 'updateArtifact' | 'updateStatus'>;
  artifactContentSource?: Pick<ArtifactContentSource, 'getContent'>;
  feedbackSource?: Pick<FeedbackSource, 'fetch' | 'reply'>;
  postMessage: (conversation: ConversationRef, text: string) => Promise<void>;
  transition: (run: Run, stage: RunStage) => void;
  failRun: (run: Run, conversation: ConversationRef, error: unknown) => Promise<void>;
  persist: () => void;
  logger: Pick<pino.Logger, 'debug' | 'warn' | 'error' | 'info'>;
  branchGuard?: BranchGuard;
  specReviewCoordinator?: Pick<SpecReviewCoordinator, 'runSpecReview'>;
  journal?: Pick<RunJournal, 'captureSession'>;
  readFile?: (path: string, encoding: 'utf-8') => Promise<string>;
  writeFile?: (path: string, content: string, encoding: 'utf-8') => Promise<void>;
}

export type ArtifactFeedbackResult = { status: 'revised' } | { status: 'failed' };

export class ArtifactFeedbackHandler {
  constructor(private readonly deps: ArtifactFeedbackDeps) {}

  async handle(run: Run, feedback: ThreadMessage): Promise<ArtifactFeedbackResult> {
    const refs = requireArtifactRefs(run);
    if (!refs) {
      await this.deps.failRun(run, feedback.conversation, new Error('Run in review state is missing artifact local path or publisher ref'));
      return { status: 'failed' };
    }

    this.deps.transition(run, 'speccing');
    await this.deps.artifactPublisher.updateStatus?.(refs.publication_ref, 'drafting').catch(err =>
      this.deps.logger.error(
        { event: 'run.status_update_failed', run_id: run.id, status: 'drafting', error: String(err) },
        'Failed to update spec status',
      ),
    );
    run.attempt += 1;

    const publisherComments = await this.fetchPublisherComments(run, feedback, refs.publication_ref);
    if (!publisherComments) return { status: 'failed' };

    let pageMarkdown = await this.getContent(run, refs.publication_ref);
    this.deps.logger.debug({
      event: 'spec_revision.enriched',
      run_id: run.id,
      request_id: run.request_id,
      message_feedback: feedback.content.length > 0,
      publisher_comment_count: publisherComments.length,
      has_published_content: !!pageMarkdown,
    }, 'Revision enriched with feedback sources');

    const onProgress = (message: string): Promise<void> =>
      this.deps.postMessage(feedback.conversation, message).catch(err => {
        this.deps.logger.warn(
          { event: 'progress_failed', phase: 'spec_generation', run_id: run.id, error: String(err) },
          'Failed to post progress update',
        );
      });

    const onAgentRequest = makeRunAgentRequestRecorder(run, this.deps.persist, this.deps.logger);

    // Only for feature specs: remove any stale generated ## Converged API section
    let staleApiRemoved = false;
    if (refs.artifact.kind === 'feature_spec') {
      const readFileFn = this.deps.readFile ?? ((p: string, e: 'utf-8') => readFile(p, e));
      const writeFileFn = this.deps.writeFile ?? ((p: string, c: string, e: 'utf-8') => writeFile(p, c, e));
      try {
        const localContent = await readFileFn(refs.local_path, 'utf-8');
        const cleaned = removeConvergedApiSection(localContent);
        if (cleaned !== localContent) {
          await writeFileFn(refs.local_path, cleaned, 'utf-8');
          staleApiRemoved = true;
          this.deps.logger.warn({
            event: 'artifact.api_convergence.stale_section_removed',
            run_id: run.id,
            request_id: run.request_id,
          }, 'Removed stale generated API section before feedback revision');
        }
      } catch (err) {
        this.deps.logger.warn({
          event: 'artifact.api_convergence.stale_section_cleanup_failed',
          run_id: run.id,
          error: String(err),
        }, 'Failed to check/remove stale converged API section');
      }
      // Also clean page markdown if available
      if (pageMarkdown && staleApiRemoved) {
        pageMarkdown = removeConvergedApiSection(pageMarkdown);
      }
    }

    let result;
    try {
      const captureSession: AgentSessionCaptureFn | undefined = this.deps.journal
        ? (data) => { void this.deps.journal!.captureSession({ ...data, run, round: 1 }).catch(() => {}); }
        : undefined;
      result = await this.deps.artifactAuthoringAgent.revise(feedback, publisherComments, refs.local_path, run.workspace_path, pageMarkdown, onProgress, { run_id: run.id, request_id: run.request_id, onAgentRequest, captureSession }, { staleConvergedApiRemoved: staleApiRemoved });
    } catch (err) {
      await this.deps.failRun(run, feedback.conversation, err);
      return { status: 'failed' };
    }

    // Guard: fail if the agent drifted to another branch
    if (this.deps.branchGuard) {
      try {
        await this.deps.branchGuard.check(run.workspace_path, run.branch);
      } catch (err) {
        await this.deps.failRun(run, feedback.conversation, err);
        return { status: 'failed' };
      }
    }

    const { comment_responses: commentResponses, page_content } = result;
    this.deps.logger.debug(
      {
        event: 'spec_revision.responses',
        run_id: run.id,
        request_id: run.request_id,
        comment_response_count: commentResponses?.length ?? 0,
        comment_response_ids: commentResponses?.map(r => r.comment_id) ?? [],
      },
      'Comment responses returned from revise()',
    );

    // Spec review (feature_spec only, after branch guard, before publish)
    let reviewedPageContent = page_content;
    if (refs.artifact.kind === 'feature_spec' && this.deps.specReviewCoordinator) {
      const captureSessionForReview: AgentSessionCaptureFn | undefined = this.deps.journal
        ? (data) => { void this.deps.journal!.captureSession({ ...data, run, round: 1 }).catch(() => {}); }
        : undefined;
      const reviewResult = await this.deps.specReviewCoordinator.runSpecReview({
        run,
        artifact_path: refs.local_path,
        working_directory: run.workspace_path,
        artifact_kind: refs.artifact.kind,
        current_page_markdown: pageMarkdown,
        onProgress: (message: string) => this.deps.postMessage(feedback.conversation, message).catch(err => {
          this.deps.logger.warn(
            { event: 'progress_failed', phase: 'spec_review', run_id: run.id, error: String(err) },
            'Failed to post spec review progress update',
          );
        }),
        onAgentRequest,
        captureSession: captureSessionForReview,
      });

      if (reviewResult.status !== 'complete') {
        await this.deps.failRun(run, feedback.conversation, new Error(reviewResult.question ?? reviewResult.error ?? 'Spec review did not complete'));
        return { status: 'failed' };
      }
      if (reviewResult.page_content) reviewedPageContent = reviewResult.page_content;

      // Second branch guard after review-driven edits
      if (this.deps.branchGuard) {
        try {
          await this.deps.branchGuard.check(run.workspace_path, run.branch);
        } catch (err) {
          await this.deps.failRun(run, feedback.conversation, err);
          return { status: 'failed' };
        }
      }
    }

    try {
      await this.deps.artifactPublisher.updateArtifact(refs.publication_ref, refs.artifact, reviewedPageContent);
    } catch (err) {
      await this.deps.failRun(run, feedback.conversation, err);
      return { status: 'failed' };
    }

    if (this.deps.feedbackSource && commentResponses && commentResponses.length > 0) {
      for (const cr of commentResponses) {
        try {
          await this.deps.feedbackSource.reply(refs.publication_ref, cr.comment_id, cr.response);
        } catch (err) {
          this.deps.logger.error(
            { event: 'run.reply_failed', run_id: run.id, comment_id: cr.comment_id, error: String(err) },
            'Failed to reply to publisher comment',
          );
        }
      }
    }

    await this.notifyRevisionComplete(run, feedback, commentResponses?.length ?? 0);
    this.deps.transition(run, 'reviewing_spec');
    return { status: 'revised' };
  }

  private async fetchPublisherComments(run: Run, feedback: ThreadMessage, publication_ref: string) {
    if (!this.deps.feedbackSource) return [];
    try {
      return await this.deps.feedbackSource.fetch(publication_ref);
    } catch (err) {
      await this.deps.failRun(run, feedback.conversation, err);
      return undefined;
    }
  }

  private async getContent(run: Run, publication_ref: string): Promise<string | undefined> {
    try {
      if (!this.deps.artifactContentSource) return undefined;
      const pageMarkdown = await this.deps.artifactContentSource.getContent(publication_ref);
      return pageMarkdown || undefined;
    } catch (err) {
      this.deps.logger.warn(
        { event: 'published_content.failed', run_id: run.id, request_id: run.request_id, error: String(err) },
        'Failed to get published content; spans will not be preserved',
      );
      return undefined;
    }
  }

  private async notifyRevisionComplete(run: Run, feedback: ThreadMessage, count: number): Promise<void> {
    const noun = count === 1 ? 'comment' : 'comments';
    const summary = count > 0
      ? `Done \u2014 responded to ${count} ${noun}. The spec is ready for another look.`
      : `Done \u2014 the spec has been updated. Ready for another look.`;
    try {
      await this.deps.postMessage(feedback.conversation, summary);
    } catch (err) {
      this.deps.logger.error(
        { event: 'run.notify_failed', run_id: run.id, error: String(err) },
        'Failed to post completion notification',
      );
    }
  }
}
