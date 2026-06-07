import type pino from 'pino';
import type { PRManager, PRManagerOptions } from '../../types/issue-tracker.js';
import type { PRTitleGenerator } from '../ai/pr-title-generator.js';
import type { SpecCommitter } from '../spec-committer.js';
import type { ThreadMessage } from '../../types/events.js';
import type { ImplementationReviewPublisher } from '../../types/impl-feedback-page.js';
import type { ArtifactPublisher } from '../../types/publisher.js';
import type { Run, RunStage } from '../../types/runs.js';
import type { ConversationRef } from '../../types/channel.js';
import { markArtifactStatus, artifactPath, artifactPublisherId } from '../run-refs.js';
import { getArtifactLifecyclePolicy } from '../../types/artifact.js';
import type { BranchGuard } from '../git-branch-guard.js';
import type { ImplementationReviewCoordinator } from '../ai/implementation-review-coordinator.js';
import type { AgentSessionCaptureFn, GateReviewExchange, ImplementationResult, ImplementationReviewExchange } from '../../types/ai.js';
import { makeRunAgentRequestRecorder } from '../run-ai-context.js';
import type { RunJournal } from '../journal/run-journal.js';

export interface ImplementationApprovalDeps {
  specCommitter?: Pick<SpecCommitter, 'updateStatus'>;
  artifactPublisher: Pick<ArtifactPublisher, 'updateStatus'>;
  prManager: Pick<PRManager, 'createPR'>;
  prTitleGenerator: PRTitleGenerator;
  implFeedbackPage?: Pick<ImplementationReviewPublisher, 'setPRLink' | 'updateStatus' | 'update'>;
  postMessage: (conversation: ConversationRef, text: string) => Promise<void>;
  transition: (run: Run, stage: RunStage) => void;
  failRun: (run: Run, conversation: ConversationRef, error: unknown) => Promise<void>;
  persist: () => void;
  logger: Pick<pino.Logger, 'error' | 'info'>;
  now?: () => Date;
  branchGuard?: BranchGuard;
  reviewCoordinator?: Pick<ImplementationReviewCoordinator, 'runFinalReview'>;
  journal?: Pick<RunJournal, 'captureSession' | 'captureFeedback'>;
}

export type ImplementationApprovalResult =
  | { status: 'pr_open' }
  | { status: 'reviewing_implementation' }
  | { status: 'needs_input' }
  | { status: 'failed' };

export class ImplementationApprovalHandler {
  constructor(private readonly deps: ImplementationApprovalDeps) {}

  async handle(run: Run, feedback: ThreadMessage): Promise<ImplementationApprovalResult> {
    const today = (this.deps.now?.() ?? new Date()).toISOString().slice(0, 10);
    const localPath = artifactPath(run);
    const publisherRef = artifactPublisherId(run);

    const shouldCommitArtifactStatus = run.artifact
      ? getArtifactLifecyclePolicy(run.artifact.kind).commit_on_approval
      : Boolean(localPath);

    if (localPath && shouldCommitArtifactStatus) {
      try {
        await this.deps.specCommitter!.updateStatus(run.workspace_path, localPath, {
          status: 'complete',
          last_updated: today,
        });
      } catch (err) {
        this.deps.logger.error(
          { event: 'spec.status_update_failed', run_id: run.id, error: String(err) },
          'Failed to update spec status to complete; continuing',
        );
      }
    }

    if (publisherRef) {
      try {
        await this.deps.artifactPublisher.updateStatus?.(publisherRef, 'complete');
      } catch (err) {
        this.deps.logger.error(
          { event: 'spec.publisher_update_failed', run_id: run.id, error: String(err) },
          'Failed to update spec publisher status to complete; continuing',
        );
      }
    }
    // Guard: fail early if run.branch has drifted — avoids a confusing PR creation error
    if (this.deps.branchGuard) {
      try {
        await this.deps.branchGuard.check(run.workspace_path, run.branch);
      } catch (err) {
        await this.deps.failRun(run, feedback.conversation, err);
        return { status: 'failed' };
      }
    }

    // Run final review before PR creation
    if (this.deps.reviewCoordinator) {
      const onAgentRequest = makeRunAgentRequestRecorder(run, this.deps.persist, this.deps.logger);
      const captureSessionForReview: AgentSessionCaptureFn | undefined = this.deps.journal
        ? (data) => { void this.deps.journal!.captureSession({ ...data, run, round: data.round ?? 1, role: data.role ?? null, gate: data.gate ?? null }).catch(() => {}); }
        : undefined;
      const currentResult: ImplementationResult = {
        status: 'complete',
        summary: run.last_impl_result?.summary,
        testing_instructions: run.last_impl_result?.testing_instructions,
        review_summary: run.last_impl_result?.review_summary,
        testing_steps: run.last_impl_result?.testing_steps,
      };
      const captureFeedbackForReview = this.deps.journal
        ? (exchange: ImplementationReviewExchange | GateReviewExchange, captureRun: Run) => {
            if ('gate' in exchange && 'round' in exchange) {
              // GateReviewExchange — emit feedback per finding with gate-aware disposition
              const criticProfile = exchange.critic_profile;
              for (const finding of exchange.findings) {
                const response = exchange.responses.find(r => r.id === finding.id);
                const isBlocking = finding.severity === 'blocker' || finding.severity === 'warning';
                const disposition =
                  response?.disposition === 'fixed' ? 'addressed' as const
                  : response?.disposition === 'declined' ? 'wont_fix' as const
                  : exchange.converged || finding.severity === 'info' ? 'addressed' as const
                  : isBlocking ? 'open' as const
                  : 'addressed' as const;
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
      const reviewedResult = await this.deps.reviewCoordinator.runFinalReview({
        run,
        artifact_path: localPath ?? '',
        implementation_result: currentResult,
        working_directory: run.workspace_path,
        onAgentRequest,
        captureSession: captureSessionForReview,
        captureFeedback: captureFeedbackForReview,
      });

      if (reviewedResult.status === 'needs_input') {
        try {
          await this.deps.postMessage(feedback.conversation, `I need input \u2014 ${reviewedResult.question ?? 'please provide more context'}`);
        } catch (err) {
          this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post question');
        }
        this.deps.transition(run, 'awaiting_impl_input');
        return { status: 'needs_input' };
      }

      if (reviewedResult.status === 'failed') {
        await this.deps.failRun(run, feedback.conversation, new Error(reviewedResult.error ?? 'Final review failed'));
        return { status: 'failed' };
      }

      if (reviewedResult.requires_human_retest) {
        this.deps.logger.info(
          { event: 'implementation.review.retest_required', run_id: run.id },
          'Final review requires human retest — returning to reviewing_implementation',
        );
        if (run.impl_feedback_ref) {
          try {
            await this.deps.implFeedbackPage?.update?.(run.impl_feedback_ref, {
              summary: reviewedResult.summary,
              review_exchanges: run.review_exchanges,
              gate_exchanges: run.gate_exchanges,
            });
          } catch (err) {
            this.deps.logger.error(
              { event: 'run.feedback_page_update_failed', run_id: run.id, error: String(err) },
              'Failed to update testing guide after final review retest requirement',
            );
          }
        }
        this.deps.transition(run, 'reviewing_implementation');
        return { status: 'reviewing_implementation' };
      }

      // Update last_impl_result with reviewed result
      if (
        reviewedResult.summary !== undefined
        || reviewedResult.testing_instructions !== undefined
        || reviewedResult.review_summary !== undefined
        || reviewedResult.testing_steps !== undefined
      ) {
        run.last_impl_result = {
          summary: reviewedResult.summary ?? run.last_impl_result?.summary ?? '',
          testing_instructions: reviewedResult.testing_instructions ?? run.last_impl_result?.testing_instructions ?? '',
          ...(reviewedResult.review_summary ?? run.last_impl_result?.review_summary
            ? { review_summary: reviewedResult.review_summary ?? run.last_impl_result?.review_summary }
            : {}),
          ...(reviewedResult.testing_steps ?? run.last_impl_result?.testing_steps
            ? { testing_steps: reviewedResult.testing_steps ?? run.last_impl_result?.testing_steps }
            : {}),
        };
        this.deps.persist();
      }
    }

    this.markArtifactComplete(run);

    const prTitleTs = new Date().toISOString();
    let generatedTitle: string | null;
    let prTitleOutcome: 'ok' | 'failed' = 'ok';
    try {
      generatedTitle = await this.deps.prTitleGenerator.generate({
        intent: run.intent,
        spec_path: localPath ?? '',
        impl_summary: run.last_impl_result?.summary,
      });
    } catch (err) {
      prTitleOutcome = 'failed';
      generatedTitle = null;
    }
    if (this.deps.journal) {
      void this.deps.journal.captureSession({
        run,
        ts_start: prTitleTs,
        ts_end: new Date().toISOString(),
        phase: run.stage,
        step: 'pr.title_generate',
        round: 1,
        model: { provider: 'anthropic_direct', name: null },
        inference: { effort: null, thinking: null },
        tokens: null,
        assistant_turns: null,
        tool_calls: null,
        tool_results: null,
        outcome: prTitleOutcome,
        runner: 'anthropic_direct',
      }).catch(() => {});
    }

    const prOptions: PRManagerOptions = {
      impl_result: run.last_impl_result,
      run_intent: run.intent,
      ...(run.issue !== undefined ? { issue_number: run.issue } : {}),
      ...(generatedTitle !== null ? { title: generatedTitle } : {}),
    };

    let prUrl: string;
    try {
      prUrl = await this.deps.prManager.createPR(
        run.workspace_path,
        run.branch,
        localPath ?? '',
        prOptions,
      );
    } catch (err) {
      await this.deps.failRun(run, feedback.conversation, err);
      return { status: 'failed' };
    }

    run.pr_url = prUrl;
    this.deps.persist();

    try {
      await this.deps.postMessage(feedback.conversation, `PR opened: ${prUrl}`);
    } catch (err) {
      this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post PR link');
    }

    if (run.impl_feedback_ref) {
      await Promise.allSettled([
        this.deps.implFeedbackPage?.setPRLink?.(run.impl_feedback_ref, prUrl),
        this.deps.implFeedbackPage?.updateStatus?.(run.impl_feedback_ref, 'approved'),
      ]).then(results => {
        for (const r of results) {
          if (r.status === 'rejected') {
            this.deps.logger.error(
              { event: 'run.status_update_failed', run_id: run.id, error: String(r.reason) },
              'Failed to update impl feedback page on implementation approval',
            );
          }
        }
      });
    }

    this.deps.transition(run, 'pr_open');
    return { status: 'pr_open' };
  }

  private markArtifactComplete(run: Run): void {
    markArtifactStatus(run, 'complete');
    this.deps.persist();
  }
}
