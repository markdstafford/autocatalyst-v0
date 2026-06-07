import { join } from 'node:path';
import { readFile as _readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type pino from 'pino';
import type {
  AgentInvocationMetadata,
  AgentProfile,
  AgentRunner,
  AgentRoutingPolicy,
  AgentSessionCaptureFn,
  ImplementationAgent,
  ImplementationResult,
  ImplementationReviewExchange,
  ImplementationReviewFinding,
} from '../../types/ai.js';
import type { Run } from '../../types/runs.js';
import type { BranchGuard } from '../git-branch-guard.js';
import type { AgentDrainSummary } from '../../types/ai.js';
import {
  buildInitialReviewPrompt,
  buildFinalReviewPrompt,
  buildImplementerResponsePrompt,
  parseImplementationReviewResult,
  drainAgentRunner,
} from './agent-services.js';
import { agentProfileSummary } from './routing-policy.js';

type ReadFileFn = (path: string, encoding: 'utf-8') => Promise<string>;

export interface ImplementationReviewPolicy {
  max_initial_rounds: number;
  max_final_rounds: number;
  on_review_failure: 'warn' | 'block';
  retest_on_behavior_change: boolean;
  convergence: {
    enabled: boolean;
    allow_same_model: boolean;
  };
}

export interface ImplementationReviewCoordinatorDeps {
  runner: AgentRunner;
  implementer: Pick<ImplementationAgent, 'implement'>;
  routingPolicy: AgentRoutingPolicy;
  policy: ImplementationReviewPolicy;
  branchGuard?: BranchGuard;
  logger: Pick<pino.Logger, 'info' | 'warn' | 'debug' | 'error'>;
  readFile?: ReadFileFn;
}

export interface ReviewRunParams {
  run: Run;
  artifact_path: string;
  implementation_result: ImplementationResult;
  working_directory: string;
  onProgress?: (message: string) => Promise<void>;
  onAgentRequest?: (metadata: AgentInvocationMetadata) => void;
  captureSession?: AgentSessionCaptureFn;
  captureFeedback?: (exchange: ImplementationReviewExchange, run: Run) => void;
}

export class ImplementationReviewCoordinator {
  private readonly readFileFn: ReadFileFn;

  constructor(private readonly deps: ImplementationReviewCoordinatorDeps) {
    this.readFileFn = deps.readFile ?? ((path, enc) => _readFile(path, enc));
  }

  async runInitialReview(params: ReviewRunParams): Promise<ImplementationResult> {
    return this.runReview('initial', 'implementation.review.initial', params);
  }

  async runFinalReview(params: ReviewRunParams): Promise<ImplementationResult> {
    return this.runReview('final', 'implementation.review.final', params);
  }

  private async runReview(
    phase: 'initial' | 'final',
    routeTask: 'implementation.review.initial' | 'implementation.review.final',
    params: ReviewRunParams,
  ): Promise<ImplementationResult> {
    if (!this.deps.policy.convergence.enabled) {
      return this.runSinglePassReview(phase, routeTask, params);
    }
    return this.runConvergenceReview(phase, routeTask, params);
  }

  private async runSinglePassReview(
    phase: 'initial' | 'final',
    routeTask: 'implementation.review.initial' | 'implementation.review.final',
    { run, artifact_path, implementation_result, working_directory, onProgress, onAgentRequest, captureSession, captureFeedback }: ReviewRunParams,
  ): Promise<ImplementationResult> {
    // Resolve review profile — fall back to initial when final is absent
    let reviewProfile = this.deps.routingPolicy.resolveOptional({ task: routeTask });
    if (!reviewProfile && phase === 'final') {
      reviewProfile = this.deps.routingPolicy.resolveOptional({ task: 'implementation.review.initial' });
    }

    if (!reviewProfile) {
      this.deps.logger.warn(
        { event: 'implementation.review.skipped', phase, run_id: run.id },
        'No review route configured — skipping review',
      );
      return implementation_result;
    }

    const implProfile = this.deps.routingPolicy.resolveOptional({ task: 'implementation.run' });
    const implSummary = implProfile ? agentProfileSummary(implProfile) : { profile: 'implementation.run', provider: 'unknown' };
    const reviewSummary = agentProfileSummary(reviewProfile);

    this.deps.logger.info(
      { event: 'implementation.review.started', phase, run_id: run.id, review_profile: reviewSummary.profile, implementation_profile: implSummary.profile },
      'Starting implementation review',
    );

    // Get git diff and changed files
    const diffContext = await this.getGitDiff(working_directory);
    const changedFiles = await this.getChangedFiles(working_directory);

    // Build prompt and run review
    const reviewResultPath = join(working_directory, '.autocatalyst', 'impl-review-result.json');
    const prompt = phase === 'initial'
      ? buildInitialReviewPrompt(artifact_path, working_directory, implementation_result, diffContext, changedFiles)
      : buildFinalReviewPrompt(artifact_path, working_directory, implementation_result, diffContext, changedFiles);

    try {
      await mkdir(dirname(reviewResultPath), { recursive: true });
    } catch { /* ignore */ }

    let round = 0;
    round++;
    const roundStart = performance.now();
    this.deps.logger.info(
      {
        event: 'implementation.review.round_started',
        phase,
        round,
        run_id: run.id,
        review_profile: reviewProfile.id,
      },
      'Review round started',
    );

    let reviewResultContent: string;
    let reviewResult: ReturnType<typeof parseImplementationReviewResult>;
    let drainSummary: AgentDrainSummary | undefined;
    const ts_start = new Date().toISOString();
    try {
      if (onAgentRequest && reviewProfile) {
        onAgentRequest({
          model: reviewProfile.model?.trim() || 'unknown',
          requested_at: new Date().toISOString(),
          route: { task: routeTask },
        });
      }

      const progressWithHeartbeat: typeof onProgress =
        onProgress && onAgentRequest && reviewProfile
          ? async (msg: string) => {
              onAgentRequest({
                model: reviewProfile.model?.trim() || 'unknown',
                requested_at: new Date().toISOString(),
                route: { task: routeTask },
                is_heartbeat: true,
              });
              return onProgress(msg);
            }
          : onProgress;

      drainSummary = await drainAgentRunner(
        this.deps.runner.run({
          route: { task: routeTask },
          profile: reviewProfile,
          working_directory,
          prompt,
          telemetry: {
            run_id: run.id,
            request_id: run.request_id,
            phase: `implementation_review_${phase}`,
            route_task: routeTask,
            handler: 'ImplementationReviewCoordinator',
          },
        }),
        progressWithHeartbeat,
        this.deps.logger,
        `implementation_review_${phase}`,
        { run_id: run.id, request_id: run.request_id },
      );

      reviewResultContent = await this.readFileFn(reviewResultPath, 'utf-8');
      reviewResult = parseImplementationReviewResult(reviewResultContent, reviewResultPath);
      this.emitSessionRecord(captureSession, reviewProfile, routeTask, ts_start, 'ok', drainSummary);
    } catch (err) {
      this.emitSessionRecord(captureSession, reviewProfile, routeTask, ts_start, 'failed', drainSummary);
      this.deps.logger.error(
        {
          event: 'implementation.review.round_failed',
          phase,
          round,
          run_id: run.id,
          error: String(err),
          duration_ms: Math.round(performance.now() - roundStart),
        },
        'Review round failed',
      );
      return this.handleReviewFailure(phase, run, implementation_result, implSummary, reviewSummary, String(err), captureFeedback);
    }

    if (reviewResult.status === 'failed') {
      const duration_ms = Math.round(performance.now() - roundStart);
      this.deps.logger.error(
        {
          event: 'implementation.review.round_failed',
          phase,
          round,
          run_id: run.id,
          reason: 'review_agent_status_failed',
          duration_ms,
          error: reviewResult.error,
        },
        'Review round failed: review agent reported failure',
      );
      return this.handleReviewFailure(phase, run, implementation_result, implSummary, reviewSummary, reviewResult.error ?? 'Review model reported failure', captureFeedback);
    }

    const duration_ms = Math.round(performance.now() - roundStart);
    const blockerCount = reviewResult.findings.filter(f => f.severity === 'blocker').length;
    const warningCount = reviewResult.findings.filter(f => f.severity === 'warning').length;
    const infoCount = reviewResult.findings.filter(f => f.severity === 'info').length;
    this.deps.logger.info(
      {
        event: 'implementation.review.round_completed',
        phase,
        round,
        run_id: run.id,
        review_profile: reviewProfile.id,
        duration_ms,
        blocker_count: blockerCount,
        warning_count: warningCount,
        info_count: infoCount,
      },
      'Review round completed',
    );

    this.deps.logger.info(
      { event: 'implementation.review.completed', phase, run_id: run.id, status: reviewResult.status, finding_count: reviewResult.findings.length, requires_human_retest: reviewResult.requires_human_retest ?? false },
      'Implementation review completed',
    );

    if (reviewResult.status === 'no_findings') {
      this.appendExchange(run, {
        id: randomUUID(),
        phase,
        created_at: new Date().toISOString(),
        implementation_profile: implSummary,
        review_profile: reviewSummary,
        review_status: 'no_findings',
        review_summary: reviewResult.summary,
        findings: [],
        responses: [],
        requires_human_retest: false,
      }, captureFeedback);
      return implementation_result;
    }

    // Findings: call implementer with review context
    if (onProgress) {
      await onProgress(`Review returned ${reviewResult.findings.length} finding(s) — asking implementation model to respond`).catch(() => {});
    }

    const responsePrompt = buildImplementerResponsePrompt(artifact_path, working_directory, implementation_result, reviewResult.findings);
    const progressFn = onProgress ?? ((_msg: string) => Promise.resolve());
    let implementerResult: ImplementationResult;
    try {
      implementerResult = await this.deps.implementer.implement(
        artifact_path,
        working_directory,
        responsePrompt,
        progressFn,
        { run_id: run.id, onAgentRequest },
      );
    } catch (err) {
      return { status: 'failed', error: `Implementer response to review failed: ${String(err)}` };
    }

    if (implementerResult.status !== 'complete') {
      return implementerResult;
    }

    // Branch guard after implementer response
    if (this.deps.branchGuard) {
      try {
        await this.deps.branchGuard.check(working_directory, run.branch);
      } catch (err) {
        return { status: 'failed', error: `Branch guard failed after review response: ${String(err)}` };
      }
    }

    // Validate responses
    const responses = implementerResult.review_responses ?? [];
    this.validateResponses(run, reviewResult.findings, responses);

    this.appendExchange(run, {
      id: randomUUID(),
      phase,
      created_at: new Date().toISOString(),
      implementation_profile: implSummary,
      review_profile: reviewSummary,
      review_status: 'addressed',
      review_summary: reviewResult.summary,
      findings: reviewResult.findings,
      responses,
      requires_human_retest: implementerResult.requires_human_retest ?? false,
    }, captureFeedback);

    return implementerResult;
  }

  private async runConvergenceReview(
    phase: 'initial' | 'final',
    routeTask: 'implementation.review.initial' | 'implementation.review.final',
    params: ReviewRunParams,
  ): Promise<ImplementationResult> {
    this.deps.logger.warn({ event: 'implementation.review.convergence_unimplemented', phase, run_id: params.run.id }, 'Convergence path is not implemented yet');
    return { status: 'failed', error: `Implementation review ${phase} convergence path is not implemented` };
  }

  private emitSessionRecord(
    captureSession: AgentSessionCaptureFn | undefined,
    profile: AgentProfile,
    routeTask: 'implementation.review.initial' | 'implementation.review.final',
    ts_start: string,
    outcome: 'ok' | 'failed',
    drainSummary: AgentDrainSummary | undefined,
  ): void {
    if (!captureSession) return;
    const runner = profile.provider === 'openai_agent_sdk' ? 'openai_agent' : 'anthropic_agent';
    captureSession({
      phase: `implementation_review`,
      step: routeTask,
      ts_start,
      ts_end: new Date().toISOString(),
      model: { provider: profile.provider, name: profile.model ?? null },
      inference: { effort: profile.effort ?? null, thinking: profile.thinking ?? null },
      tokens: drainSummary?.terminal_usage ?? null,
      assistant_turns: drainSummary?.assistant_turn_count ?? null,
      tool_calls: drainSummary?.tool_call_count ?? null,
      tool_results: drainSummary?.tool_result_count ?? null,
      outcome,
      runner,
    });
  }

  private handleReviewFailure(
    phase: 'initial' | 'final',
    run: Run,
    original: ImplementationResult,
    implSummary: ReturnType<typeof agentProfileSummary>,
    reviewSummary: ReturnType<typeof agentProfileSummary>,
    errorMsg: string,
    captureFeedback?: (exchange: ImplementationReviewExchange, run: Run) => void,
  ): ImplementationResult {
    this.deps.logger.warn(
      { event: 'implementation.review.failed', phase, run_id: run.id, error: errorMsg },
      'Implementation review failed',
    );
    if (this.deps.policy.on_review_failure === 'block') {
      return { status: 'failed', error: `Implementation review (${phase}) failed: ${errorMsg}` };
    }
    // warn: degraded exchange, continue
    this.appendExchange(run, {
      id: randomUUID(),
      phase,
      created_at: new Date().toISOString(),
      implementation_profile: implSummary,
      review_profile: reviewSummary,
      review_status: 'degraded',
      review_summary: errorMsg,
      findings: [],
      responses: [],
      requires_human_retest: false,
    }, captureFeedback);
    return original;
  }

  private validateResponses(run: Run, findings: ImplementationReviewFinding[], responses: NonNullable<ImplementationResult['review_responses']>): void {
    const responseIds = new Set(responses.map(r => r.id));
    for (const finding of findings) {
      if (!responseIds.has(finding.id)) {
        this.deps.logger.warn(
          { event: 'implementation.review.response_invalid', run_id: run.id, missing_id: finding.id },
          `Implementer did not respond to finding ID: ${finding.id}`,
        );
      }
    }
  }

  private appendExchange(run: Run, exchange: ImplementationReviewExchange, captureFeedback?: (exchange: ImplementationReviewExchange, run: Run) => void): void {
    if (!run.review_exchanges) run.review_exchanges = [];
    run.review_exchanges.push(exchange);
    captureFeedback?.(exchange, run);
  }

  private async getGitDiff(working_directory: string): Promise<string> {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);
      const { stdout } = await exec('git', ['diff', 'HEAD~1..HEAD', '--stat', '--patch', '--', '.'], { cwd: working_directory, maxBuffer: 100_000 });
      return stdout.trim();
    } catch {
      return '';
    }
  }

  private async getChangedFiles(working_directory: string): Promise<string[]> {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);
      const { stdout } = await exec('git', ['diff', 'HEAD~1..HEAD', '--name-only'], { cwd: working_directory });
      return stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}
