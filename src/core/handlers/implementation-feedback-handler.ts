import type pino from 'pino';
import type { ImplementationAgent, AgentSessionCaptureFn, GateReviewExchange, ImplementationReviewExchange } from '../../types/ai.js';
import type { ThreadMessage } from '../../types/events.js';
import type { FeedbackItem, ImplementationReviewPublisher } from '../../types/impl-feedback-page.js';
import type { Run, RunStage } from '../../types/runs.js';
import type { ConversationRef } from '../../types/channel.js';
import { artifactPath } from '../run-refs.js';
import type { BranchGuard } from '../git-branch-guard.js';
import type { ImplementationReviewCoordinator } from '../ai/implementation-review-coordinator.js';
import { makeRunAgentRequestRecorder } from '../run-ai-context.js';
import type { RunJournal } from '../journal/run-journal.js';
import {
  altitudesForDepth,
  resolveFeedbackDepth,
  type ResolvedImplementationConvergencePolicy,
} from '../ai/layered-convergence-policy.js';

export interface ImplementationFeedbackDeps {
  implementer: Pick<ImplementationAgent, 'implement'>;
  implFeedbackPage?: Pick<ImplementationReviewPublisher, 'readFeedback' | 'update'>;
  postMessage: (conversation: ConversationRef, text: string) => Promise<void>;
  transition: (run: Run, stage: RunStage) => void;
  failRun: (run: Run, conversation: ConversationRef, error: unknown) => Promise<void>;
  persist: () => void;
  logger: Pick<pino.Logger, 'info' | 'warn' | 'error' | 'debug'>;
  branchGuard?: BranchGuard;
  reviewCoordinator?: Pick<ImplementationReviewCoordinator, 'runInitialReview' | 'runLayeredImplementation'>;
  convergencePolicy?: ResolvedImplementationConvergencePolicy;
  journal?: Pick<RunJournal, 'captureSession' | 'captureFeedback'>;
}

export type ImplementationFeedbackResult =
  | { status: 'updated' }
  | { status: 'needs_input' }
  | { status: 'failed' };

export class ImplementationFeedbackHandler {
  constructor(private readonly deps: ImplementationFeedbackDeps) {}

  async handle(run: Run, feedback: ThreadMessage, routingStage: RunStage = run.stage): Promise<ImplementationFeedbackResult> {
    const localPath = artifactPath(run);
    if (!localPath) {
      await this.deps.failRun(run, feedback.conversation, new Error('Run missing artifact local path for implementation feedback'));
      return { status: 'failed' };
    }

    const additionalContext = await this.additionalContext(run, feedback, routingStage);
    if (additionalContext.status === 'failed') return { status: 'failed' };

    const onProgress = (message: string): Promise<void> =>
      this.deps.postMessage(feedback.conversation, message).catch(err => {
        this.deps.logger.warn(
          { event: 'progress_failed', phase: 'implementation_feedback', run_id: run.id, error: String(err) },
          'Failed to post progress update',
        );
      });

    this.deps.transition(run, 'implementing');
    run.attempt += 1;
    this.deps.persist();

    const onAgentRequest = makeRunAgentRequestRecorder(run, this.deps.persist, this.deps.logger);

    let result;
    try {
      const captureSession: AgentSessionCaptureFn | undefined = this.deps.journal
        ? (data) => { void this.deps.journal!.captureSession({ ...data, run, round: data.round ?? 1, role: data.role ?? null, gate: data.gate ?? null }).catch(() => {}); }
        : undefined;
      result = await this.deps.implementer.implement(
        localPath,
        run.workspace_path,
        additionalContext.value,
        onProgress,
        { run_id: run.id, request_id: run.request_id, onAgentRequest, captureSession },
      );
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

    // Run initial review if coordinator is configured
    let reviewedResult = result;
    if (this.deps.reviewCoordinator) {
      const captureSessionForReview: AgentSessionCaptureFn | undefined = this.deps.journal
        ? (data) => { void this.deps.journal!.captureSession({ ...data, run, round: data.round ?? 1, role: data.role ?? null, gate: data.gate ?? null }).catch(() => {}); }
        : undefined;
      const captureFeedback = this.deps.journal
        ? (exchange: ImplementationReviewExchange | GateReviewExchange, captureRun: Run) => {
            if ('gate' in exchange && 'round' in exchange) {
              // GateReviewExchange — emit feedback per finding with gate-aware disposition
              const criticProfile = exchange.critic_profile;
              for (const finding of exchange.findings) {
                const layered = finding.layered;
                const response = exchange.responses.find(r => r.id === finding.id);
                const isBlocking = finding.severity === 'blocker' || finding.severity === 'warning';
                let disposition: 'open' | 'addressed' | 'wont_fix';
                if (layered?.disposition === 'filtered_note' || layered?.disposition === 'info') {
                  disposition = 'addressed';
                } else {
                  disposition =
                    response?.disposition === 'fixed' ? 'addressed' as const
                    : response?.disposition === 'declined' ? 'wont_fix' as const
                    : exchange.converged || finding.severity === 'info' ? 'addressed' as const
                    : isBlocking ? 'open' as const
                    : 'addressed' as const;
                }
                void this.deps.journal!.captureFeedback({
                  id: `${exchange.id}:${finding.id}`,
                  run: captureRun,
                  target: 'implementation',
                  gate: exchange.gate,
                  author_principal: `review:${criticProfile.provider}:${criticProfile.profile}`,
                  text: finding.finding,
                  severity: finding.severity,
                  category: finding.category,
                  disposition,
                  ...(layered?.disposition === 'filtered_note' ? {
                    note_kind: 'filtered_layered_finding' as const,
                    filter_reason: layered.filter_reason,
                    scope: layered.scope,
                    reason_code: layered.reason_code,
                    original_severity: layered.original_severity,
                    original_category: layered.original_category,
                  } : {}),
                }).catch(() => {});
              }
            } else {
              // Legacy ImplementationReviewExchange — keep existing behavior
              const reviewProfile = exchange.review_profile;
              for (const finding of exchange.findings) {
                void this.deps.journal!.captureFeedback({
                  id: finding.id,
                  run: captureRun,
                  target: 'implementation',
                  author_principal: `review:${reviewProfile.provider}:${reviewProfile.profile}`,
                  text: finding.finding + (finding.suggested_action ? ' | ' + finding.suggested_action : ''),
                  severity: finding.severity,
                  category: finding.category,
                  disposition: exchange.responses.some(r => r.id === finding.id && r.disposition === 'fixed') ? 'addressed' : 'open',
                }).catch(() => {});
              }
            }
          }
        : undefined;
      const reviewParams = {
        run,
        artifact_path: localPath,
        implementation_result: result,
        working_directory: run.workspace_path,
        onProgress,
        onAgentRequest,
        captureSession: captureSessionForReview,
        captureFeedback,
      };
      const policy = this.deps.convergencePolicy;
      // Feedback uses feedback_depth (defaulting to build_only) to choose altitudes.
      const feedbackDepth = policy
        ? resolveFeedbackDepth(policy.feedback_depth, policy.depth)
        : 'build_only';
      const useLayered =
        policy?.enabled &&
        feedbackDepth !== 'build_only' &&
        typeof this.deps.reviewCoordinator.runLayeredImplementation === 'function';
      reviewedResult = useLayered
        ? await this.deps.reviewCoordinator.runLayeredImplementation!(reviewParams, { altitudes: altitudesForDepth(feedbackDepth) })
        : await this.deps.reviewCoordinator.runInitialReview(reviewParams);
      if (reviewedResult.status === 'needs_input') {
        this.deps.logger.info({ event: 'implementation.review.needs_input', run_id: run.id }, 'Review response needs input');
        try {
          await this.deps.postMessage(feedback.conversation, `I need input \u2014 ${reviewedResult.question ?? 'please provide more context'}`);
        } catch (err) {
          this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post question');
        }
        this.deps.transition(run, 'awaiting_impl_input');
        return { status: 'needs_input' };
      }
      if (reviewedResult.status === 'failed') {
        await this.deps.failRun(run, feedback.conversation, new Error(reviewedResult.error ?? 'Review failed'));
        return { status: 'failed' };
      }
    }

    if (result.status === 'needs_input') {
      this.deps.logger.info(
        { event: 'implementation.needs_input', run_id: run.id, request_id: run.request_id },
        'Implementation needs more input',
      );
      try {
        await this.deps.postMessage(feedback.conversation, `I need input \u2014 ${result.question ?? 'please provide more context'}`);
      } catch (err) {
        this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post question');
      }
      this.deps.transition(run, 'awaiting_impl_input');
      return { status: 'needs_input' };
    }

    if (result.status === 'failed') {
      await this.deps.failRun(run, feedback.conversation, new Error(result.error ?? 'Implementation failed'));
      return { status: 'failed' };
    }

    this.deps.logger.info(
      { event: 'implementation.complete', run_id: run.id, request_id: run.request_id, attempt: run.attempt },
      'Implementation complete',
    );

    // Log legacy warning if structured output is missing
    if (!reviewedResult.review_summary || !reviewedResult.testing_steps) {
      this.deps.logger.warn(
        { event: 'implementation.review_contract_legacy', run_id: run.id },
        'Implementation result missing structured review_summary or testing_steps; using legacy fields',
      );
    }

    run.last_impl_result = {
      summary: reviewedResult.summary ?? '',
      testing_instructions: reviewedResult.testing_instructions ?? '',
      ...(reviewedResult.review_summary ? { review_summary: reviewedResult.review_summary } : {}),
      ...(reviewedResult.testing_steps ? { testing_steps: reviewedResult.testing_steps } : {}),
    };
    this.deps.persist();

    if (run.impl_feedback_ref) {
      try {
        await this.deps.implFeedbackPage!.update(run.impl_feedback_ref, {
          summary: reviewedResult.summary,
          review_summary: reviewedResult.review_summary,
          testing_steps: reviewedResult.testing_steps,
          resolved_items: reviewedResult.resolved_feedback_items ?? [],
          review_exchanges: run.review_exchanges,
          gate_exchanges: run.gate_exchanges,
        });
      } catch (err) {
        this.deps.logger.error(
          { event: 'run.feedback_page_update_failed', run_id: run.id, error: String(err) },
          'Failed to update implementation feedback page; continuing in degraded state',
        );
      }
    }

    try {
      await this.deps.postMessage(feedback.conversation, 'Implementation updated \u2014 check the feedback page for the latest summary and testing instructions.');
    } catch (err) {
      this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post completion notification');
    }

    this.deps.transition(run, 'reviewing_implementation');
    return { status: 'updated' };
  }

  private async additionalContext(
    run: Run,
    feedback: ThreadMessage,
    routingStage: RunStage,
  ): Promise<{ status: 'ok'; value: string } | { status: 'failed' }> {
    const wasAwaiting = routingStage === 'awaiting_impl_input';

    if (wasAwaiting || !run.impl_feedback_ref) {
      return { status: 'ok', value: feedback.content };
    }

    let feedbackItems: FeedbackItem[];
    try {
      feedbackItems = await this.deps.implFeedbackPage!.readFeedback(run.impl_feedback_ref);
    } catch (err) {
      await this.deps.failRun(run, feedback.conversation, err);
      return { status: 'failed' };
    }

    const unresolved = feedbackItems.filter(item => !item.resolved);

    if (unresolved.length === 0) {
      this.deps.logger.info(
        { event: 'implementation.feedback_empty', run_id: run.id },
        'No unresolved feedback items found; using inbound message as context',
      );
      return { status: 'ok', value: feedback.content };
    }

    const serialized = [
      'Unresolved implementation feedback from the testing guide:',
      '',
      ...unresolved.map(item => {
        const lines = [`[FEEDBACK_ID: ${item.id}]`, item.text];
        if (item.conversation.length > 0) {
          lines.push('Conversation:');
          for (const line of item.conversation) {
            lines.push(`- ${line}`);
          }
        }
        return lines.join('\n');
      }),
    ].join('\n\n');

    this.deps.logger.debug(
      { event: 'implementation.feedback_context_built', run_id: run.id, unresolved_count: unresolved.length },
      'Serialized unresolved feedback for implementer',
    );

    return { status: 'ok', value: serialized };
  }
}
