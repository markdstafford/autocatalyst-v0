import type pino from 'pino';
import type { ImplementationAgent, AgentSessionCaptureFn, GateReviewExchange, ImplementationReviewExchange } from '../../types/ai.js';
import type { ThreadMessage } from '../../types/events.js';
import type { ImplementationReviewPublisher } from '../../types/impl-feedback-page.js';
import { titleFromArtifactPath } from '../../types/publisher.js';
import type { Run, RunStage } from '../../types/runs.js';
import type { ConversationRef } from '../../types/channel.js';
import { requireArtifactRefs, artifactPublishedUrl } from '../run-refs.js';
import type { BranchGuard } from '../git-branch-guard.js';
import type { ImplementationReviewCoordinator } from '../ai/implementation-review-coordinator.js';
import { makeRunAgentRequestRecorder } from '../run-ai-context.js';
import type { RunJournal } from '../journal/run-journal.js';
import {
  altitudesForDepth,
  type ResolvedImplementationConvergencePolicy,
} from '../ai/layered-convergence-policy.js';
import { ModelSessionBudget, type BudgetWriter } from '../journal/model-session-budget.js';

export interface ImplementationStartDeps {
  implementer: Pick<ImplementationAgent, 'implement'>;
  implFeedbackPage?: Pick<ImplementationReviewPublisher, 'create' | 'updateStatus'>;
  postMessage: (conversation: ConversationRef, text: string) => Promise<void>;
  transition: (run: Run, stage: RunStage) => void;
  failRun: (run: Run, conversation: ConversationRef, error: unknown) => Promise<void>;
  persist: () => void;
  logger: Pick<pino.Logger, 'info' | 'warn' | 'error'>;
  branchGuard?: BranchGuard;
  reviewCoordinator?: Pick<ImplementationReviewCoordinator, 'runInitialReview' | 'runLayeredImplementation'>;
  convergencePolicy?: ResolvedImplementationConvergencePolicy;
  journal?: Pick<RunJournal, 'captureSession' | 'captureFeedback'>;
  budgetWriter?: BudgetWriter;
}

export type ImplementationStartResult =
  | { status: 'reviewing_implementation' }
  | { status: 'needs_input' }
  | { status: 'failed' };

export class ImplementationStartHandler {
  constructor(private readonly deps: ImplementationStartDeps) {}

  async handle(run: Run, feedback: ThreadMessage, additionalContext?: string): Promise<ImplementationStartResult> {
    const refs = requireArtifactRefs(run);
    if (!refs) {
      await this.deps.failRun(run, feedback.conversation, new Error('Run missing artifact local path or publisher ref for implementation'));
      return { status: 'failed' };
    }
    const planPath = additionalContext ? undefined : run.implementation_plan_path;
    if (!additionalContext && !planPath) {
      await this.deps.failRun(run, feedback.conversation, new Error('Run missing implementation plan path for implementation'));
      return { status: 'failed' };
    }

    const onProgress = (message: string): Promise<void> =>
      this.deps.postMessage(feedback.conversation, message).catch(err => {
        this.deps.logger.warn(
          { event: 'progress_failed', phase: 'implementation', run_id: run.id, error: String(err) },
          'Failed to post progress update',
        );
      });

    const sessionBudget = this.deps.convergencePolicy
      ? new ModelSessionBudget({
          runId: run.id,
          requestId: run.request_id,
          limit: this.deps.convergencePolicy.max_model_sessions_per_run,
          writer: this.deps.budgetWriter ?? { append: async () => {} },
        })
      : undefined;

    if (run.impl_feedback_ref) {
      await this.deps.implFeedbackPage?.updateStatus?.(run.impl_feedback_ref, 'in_progress').catch(err =>
        this.deps.logger.error(
          { event: 'run.status_update_failed', run_id: run.id, status: 'in_progress', error: String(err) },
          'Failed to update testing guide status',
        ),
      );
    }

    const onAgentRequest = makeRunAgentRequestRecorder(run, this.deps.persist, this.deps.logger);
    const captureSession: AgentSessionCaptureFn | undefined = this.deps.journal
      ? (data) => { void this.deps.journal!.captureSession({ ...data, run, round: data.round ?? 1, role: data.role ?? null, gate: data.gate ?? null }).catch(() => {}); }
      : undefined;

    let implReservationId: string | undefined;
    if (sessionBudget) {
      try {
        const r = await sessionBudget.reserve({ gate: 'initial', role: 'proposer', round: 1, passKind: 'initial' });
        implReservationId = r.session_id;
      } catch (err) {
        await this.deps.failRun(run, feedback.conversation, err);
        return { status: 'failed' };
      }
    }

    let result;
    try {
      result = await this.deps.implementer.implement(
        refs.local_path,
        run.workspace_path,
        additionalContext,
        onProgress,
        { run_id: run.id, request_id: run.request_id, onAgentRequest, captureSession },
        planPath,
      );
      if (sessionBudget && implReservationId) {
        await sessionBudget.complete(implReservationId, 'ok').catch(() => {});
      }
    } catch (err) {
      if (sessionBudget && implReservationId) {
        await sessionBudget.complete(implReservationId, 'failed').catch(() => {});
      }
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
        artifact_path: refs.local_path,
        implementation_result: result,
        working_directory: run.workspace_path,
        onProgress,
        onAgentRequest,
        captureSession,
        captureFeedback,
        sessionBudget,
      };
      const policy = this.deps.convergencePolicy;
      const useLayered =
        policy?.enabled &&
        policy.depth !== 'build_only' &&
        typeof this.deps.reviewCoordinator.runLayeredImplementation === 'function';
      reviewedResult = useLayered
        ? await this.deps.reviewCoordinator.runLayeredImplementation!(reviewParams, { altitudes: altitudesForDepth(policy!.depth) })
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
      this.deps.logger.info({ event: 'implementation.needs_input', run_id: run.id, request_id: run.request_id }, 'Implementation needs input');
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

    this.deps.logger.info({ event: 'implementation.complete', run_id: run.id, request_id: run.request_id, attempt: run.attempt }, 'Implementation complete');
    run.last_impl_result = {
      summary: reviewedResult.summary ?? '',
      testing_instructions: reviewedResult.testing_instructions ?? '',
      ...(reviewedResult.review_summary ? { review_summary: reviewedResult.review_summary } : {}),
      ...(reviewedResult.testing_steps ? { testing_steps: reviewedResult.testing_steps } : {}),
    };
    this.deps.persist();

    let feedbackPageUrl: string | undefined;
    let feedbackPageLabel: string | undefined;
    try {
      // Log legacy warning if structured output is missing
      if (!reviewedResult.review_summary || !reviewedResult.testing_steps) {
        this.deps.logger.warn(
          { event: 'implementation.review_contract_legacy', run_id: run.id },
          'Implementation result missing structured review_summary or testing_steps; using legacy fields',
        );
      }
      const publishedReview = await this.deps.implFeedbackPage!.create({
        artifact_ref: refs.publication_ref,
        artifact_url: artifactPublishedUrl(run),
        title: titleFromArtifactPath(refs.local_path),
        workspace_path: run.workspace_path,
        branch: run.branch,
        summary: reviewedResult.summary ?? '',
        testing_instructions: reviewedResult.testing_instructions ?? '',
        review_summary: reviewedResult.review_summary,
        testing_steps: reviewedResult.testing_steps,
        review_exchanges: run.review_exchanges,
        gate_exchanges: run.gate_exchanges,
      });
      run.impl_feedback_ref = publishedReview.id;
      this.deps.persist();
      feedbackPageUrl = publishedReview.url;
      feedbackPageLabel = publishedReview.label;
    } catch (err) {
      this.deps.logger.error(
        { event: 'run.feedback_page_failed', run_id: run.id, error: String(err) },
        'Failed to create implementation feedback page; continuing in degraded state',
      );
    }

    const completionMsg = feedbackPageUrl
      ? feedbackPageLabel
        ? `Implementation complete. ${feedbackPageLabel} \u2014 ${feedbackPageUrl}`
        : `Implementation complete. Feedback page: ${feedbackPageUrl}`
      : 'Implementation complete. (Could not create feedback page \u2014 check logs.)';
    try {
      await this.deps.postMessage(feedback.conversation, completionMsg);
    } catch (err) {
      this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post completion notification');
    }

    if (run.impl_feedback_ref) {
      await this.deps.implFeedbackPage?.updateStatus?.(run.impl_feedback_ref, 'waiting_on_feedback').catch(err =>
        this.deps.logger.error(
          { event: 'run.status_update_failed', run_id: run.id, status: 'waiting_on_feedback', error: String(err) },
          'Failed to update testing guide status',
        ),
      );
    }

    this.deps.transition(run, 'reviewing_implementation');
    return { status: 'reviewing_implementation' };
  }
}
