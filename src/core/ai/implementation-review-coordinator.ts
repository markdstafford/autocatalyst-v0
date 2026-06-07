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
  AgentRoute,
  AgentRunner,
  AgentRoutingPolicy,
  AgentServiceTelemetry,
  AgentSessionCaptureFn,
  GateReviewExchange,
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
  buildLayeredCritiquePrompt,
  buildLayeredRevisePrompt,
  parseImplementationReviewResult,
  drainAgentRunner,
} from './agent-services.js';
import { agentProfileSummary } from './routing-policy.js';
import { allowedCategoriesForGate, gateLabel, type LayeredConvergenceGate } from './layered-convergence-policy.js';
import { filterLayeredFindings } from './layered-finding-filter.js';
import { type ModelSessionBudget } from '../journal/model-session-budget.js';
import { buildGateContext } from './gate-context.js';
import { createGitSnapshotCheckpoint } from '../git-checkpoints.js';
import { validateAltitudeContract } from './altitude-contract-validator.js';
import { compareBuildToAcceptedContracts, type AcceptedAltitudeCheckpoint } from './build-contract-preservation.js';

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
  /** Injectable for testing: replaces buildGateContext from gate-context.ts */
  buildGateContext?: typeof buildGateContext;
  /** Injectable for testing: replaces createGitSnapshotCheckpoint from git-checkpoints.ts */
  createGitSnapshotCheckpoint?: typeof createGitSnapshotCheckpoint;
  /** Injectable for testing: replaces validateAltitudeContract from altitude-contract-validator.ts */
  validateAltitudeContract?: typeof validateAltitudeContract;
  /** Injectable for testing: replaces compareBuildToAcceptedContracts from build-contract-preservation.ts */
  compareBuildToAcceptedContracts?: typeof compareBuildToAcceptedContracts;
}

export interface ReviewRunParams {
  run: Run;
  artifact_path: string;
  implementation_result: ImplementationResult;
  working_directory: string;
  onProgress?: (message: string) => Promise<void>;
  onAgentRequest?: (metadata: AgentInvocationMetadata) => void;
  captureSession?: AgentSessionCaptureFn;
  captureFeedback?: (exchange: ImplementationReviewExchange | GateReviewExchange, run: Run) => void;
  sessionBudget?: ModelSessionBudget;
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
    return this.runConvergenceLoop(phase, phase, routeTask, params, params.implementation_result);
  }

  /**
   * Run the layered implementation review across altitudes. This is the public
   * entry point for the layered-diff convergence feature. Thin routing:
   *  - If convergence is disabled, delegate to the existing single-pass path.
   *  - If altitudes is exactly ['build'], delegate to the existing build
   *    convergence path (preserving gate: "initial" in exchanges).
   *  - For layered altitudes, run each altitude convergence in order and
   *    return failure if any altitude does not converge.
   */
  async runLayeredImplementation(
    params: ReviewRunParams,
    opts: { altitudes: readonly LayeredConvergenceGate[] },
  ): Promise<ImplementationResult> {
    const altitudes = opts.altitudes;

    // Convergence disabled → existing single-pass behavior.
    if (!this.deps.policy.convergence.enabled) {
      return this.runInitialReview(params);
    }

    // Build-only mode → existing convergence path (preserves gate: "initial").
    if (altitudes.length === 1 && altitudes[0] === 'build') {
      return this.runInitialReview(params);
    }

    // Layered altitudes: run each altitude convergence loop in order.
    const depth = altitudes.join('+');
    this.deps.logger.info(
      {
        event: 'implementation.layered.started',
        run_id: params.run.id,
        depth,
        enabled_altitudes: [...altitudes],
        model_session_budget: 24,
      },
      'Layered implementation enabled',
    );
    try {
      await params.onProgress?.(`Layered implementation enabled — depth ${depth}`);
    } catch (err) {
      this.deps.logger.warn(
        { event: 'progress_failed', run_id: params.run.id, error: String(err) },
        'Progress message failed to send',
      );
    }

    // Capture the pre-implementation pass base ref once. This ref is fixed for the
    // entire pass and is passed to buildGateContext for every altitude so that each
    // altitude sees a cumulative diff from the same original base through the current
    // working tree. Checkpoint refs are tracked separately for build contract preservation
    // and must never replace this pass base ref.
    let passBaseRef: string;
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);
      const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: params.working_directory });
      passBaseRef = stdout.trim();
    } catch {
      passBaseRef = 'HEAD';
    }

    const acceptedCheckpoints: AcceptedAltitudeCheckpoint[] = [];

    let currentResult = params.implementation_result;
    for (const altitude of altitudes) {
      const result = await this.runConvergenceLoop(
        altitude,
        'initial',
        'implementation.review.initial',
        { ...params, implementation_result: currentResult },
        currentResult,
        { base_ref: passBaseRef, acceptedCheckpoints: altitude === 'build' ? [...acceptedCheckpoints] : [] },
      );
      if (result.status !== 'complete') {
        return result;
      }
      currentResult = result;

      // After each non-build altitude converges, run branch guard then create a checkpoint.
      // Checkpoint refs are stored for build contract preservation; passBaseRef is never
      // updated — all altitudes always diff cumulatively from the original pass base.
      if (altitude !== 'build') {
        // Branch guard must run after convergence and before checkpoint creation so that
        // any drift caused by the last proposer revision is caught before snapshotting.
        if (this.deps.branchGuard) {
          try {
            await this.deps.branchGuard.check(params.working_directory, params.run.branch);
          } catch (err) {
            this.deps.logger.error(
              { event: 'implementation.layer.branch_guard_failed', run_id: params.run.id, gate: altitude, error: String(err) },
              'Branch guard rejected before checkpoint — failing run',
            );
            return { status: 'failed', error: `Branch guard failed before ${altitude} checkpoint: ${String(err)}` };
          }
        }

        this.deps.logger.info(
          { event: 'implementation.layer.checkpoint_started', run_id: params.run.id, gate: altitude, strategy: 'internal_ref' },
          'Creating altitude checkpoint',
        );
        try {
          const checkpoint = await (this.deps.createGitSnapshotCheckpoint ?? createGitSnapshotCheckpoint)({
            workingDirectory: params.working_directory,
            runId: params.run.id,
            gate: altitude,
          });
          this.deps.logger.info(
            { event: 'implementation.layer.checkpoint_completed', run_id: params.run.id, gate: altitude, checkpoint_ref: checkpoint.ref },
            'Altitude checkpoint created',
          );
          // Progress: emit only after checkpoint succeeds
          try {
            await params.onProgress?.(`${gateLabel(altitude as LayeredConvergenceGate)} converged — checkpointing layer`);
          } catch (progressErr) {
            this.deps.logger.warn({ event: 'progress_failed', run_id: params.run.id, gate: altitude, error: String(progressErr) }, 'Progress message failed to send');
          }
          acceptedCheckpoints.push({ gate: altitude as 'layout' | 'public_api' | 'private_api', ref: checkpoint.ref });
        } catch (err) {
          this.deps.logger.error(
            { event: 'implementation.layer.checkpoint_failed', run_id: params.run.id, gate: altitude, error: String(err) },
            'Checkpoint creation failed — failing run before next altitude',
          );
          return { status: 'failed', error: `Checkpoint creation failed for ${altitude}: ${String(err)}` };
        }
      }
    }
    return currentResult;
  }

  private async runConvergenceLoop(
    gate: 'initial' | 'final' | LayeredConvergenceGate,
    phase: 'initial' | 'final',
    routeTask: 'implementation.review.initial' | 'implementation.review.final',
    { run, artifact_path, working_directory, onProgress, onAgentRequest, captureSession, captureFeedback, sessionBudget }: ReviewRunParams,
    initialResult: ImplementationResult,
    loopOpts?: { base_ref?: string; acceptedCheckpoints?: AcceptedAltitudeCheckpoint[] },
  ): Promise<ImplementationResult> {
    const implementation_result = initialResult;
    // Resolve critic profile — fall back to initial when final is absent
    let criticProfile = this.deps.routingPolicy.resolveOptional({ task: routeTask, role: 'critic' });
    if (!criticProfile && phase === 'final') {
      criticProfile = this.deps.routingPolicy.resolveOptional({ task: 'implementation.review.initial', role: 'critic' });
    }
    // Also fall back to non-role route
    if (!criticProfile) {
      criticProfile = this.deps.routingPolicy.resolveOptional({ task: routeTask });
    }
    if (!criticProfile && phase === 'final') {
      criticProfile = this.deps.routingPolicy.resolveOptional({ task: 'implementation.review.initial' });
    }

    if (!criticProfile) {
      this.deps.logger.warn(
        { event: 'implementation.review.skipped', phase, run_id: run.id },
        'No review route configured — skipping review',
      );
      return implementation_result;
    }

    // Resolve proposer profile
    const proposerProfileOptional = this.deps.routingPolicy.resolveOptional({ task: 'implementation.run', role: 'proposer' });
    const proposerProfile = proposerProfileOptional ?? this.deps.routingPolicy.resolveOptional({ task: 'implementation.run' });
    const proposerRoute: AgentRoute = { task: 'implementation.run', role: 'proposer' };

    const criticSummary = agentProfileSummary(criticProfile);
    const proposerSummary = proposerProfile ? agentProfileSummary(proposerProfile) : { profile: 'implementation.run', provider: 'unknown' };

    // Same-model enforcement
    const sameModelResult = this.assertDistinctProfiles(phase, proposerProfile, criticProfile);
    if (sameModelResult) return sameModelResult;

    const maxRounds = phase === 'initial' ? this.deps.policy.max_initial_rounds : this.deps.policy.max_final_rounds;
    const reviewResultPath = join(working_directory, '.autocatalyst', 'impl-review-result.json');

    try {
      await mkdir(dirname(reviewResultPath), { recursive: true });
    } catch { /* ignore */ }

    this.deps.logger.info(
      { event: 'implementation.review.convergence_started', phase, gate, run_id: run.id, max_rounds: maxRounds, critic_profile: criticSummary.profile },
      'Starting convergence review',
    );

    // Layer-started telemetry and progress message for layered altitudes.
    const isNamedGate = gate !== 'initial' && gate !== 'final';
    if (isNamedGate) {
      const altLabel = gateLabel(gate as LayeredConvergenceGate);
      this.deps.logger.info(
        { event: 'implementation.layer.started', run_id: run.id, gate, proposer_profile: proposerSummary.profile },
        'Layer altitude started',
      );
      try {
        await onProgress?.(`${altLabel} pass started with ${proposerSummary.profile}`);
      } catch (err) {
        this.deps.logger.warn(
          { event: 'progress_failed', run_id: run.id, gate, error: String(err) },
          'Progress message failed to send',
        );
      }
    }

    let currentResult: ImplementationResult = implementation_result;
    const previousSignatures: Set<string>[] = [];
    const previousBlockingCounts: number[] = [];
    const layerStart = performance.now();

    for (let round = 1; round <= maxRounds; round++) {
      const roundStart = performance.now();

      this.deps.logger.info(
        { event: 'implementation.review.round_started', phase, gate, round, run_id: run.id, review_profile: criticProfile.id },
        'Convergence review round started',
      );

      // Re-derive git diff and changed files fresh inside the loop.
      // Named gates (layered altitudes) use gate-context cumulative diff from the
      // altitude base ref so each altitude sees only its own cumulative changes.
      // Legacy 'initial'/'final' gates keep the existing getGitDiff path.
      const isEarlyLayeredGate = gate === 'layout' || gate === 'public_api' || gate === 'private_api';
      const isNamedLayeredGate = isEarlyLayeredGate || gate === 'build';
      let diffContext: string;
      let changedFiles: string[];
      if (isNamedLayeredGate && loopOpts?.base_ref) {
        const gateCtx = await (this.deps.buildGateContext ?? buildGateContext)({ gate: String(gate), base_ref: loopOpts.base_ref, working_directory });
        diffContext = gateCtx.diff;
        changedFiles = gateCtx.changed_files;
        this.deps.logger.info(
          { event: 'implementation.review.context_built', run_id: run.id, gate, round, context_kind: 'cumulative', changed_file_count: changedFiles.length, diff_byte_count: gateCtx.diff_byte_count },
          'Gate context built from cumulative diff',
        );
      } else {
        diffContext = await this.getGitDiff(working_directory);
        changedFiles = await this.getChangedFiles(working_directory);
      }

      // For early layered altitudes, mechanically validate that the proposer has not
      // written lower-altitude work before running the critic.
      if (isEarlyLayeredGate && loopOpts?.base_ref) {
        const contractResult = await (this.deps.validateAltitudeContract ?? validateAltitudeContract)({
          gate: gate as 'layout' | 'public_api' | 'private_api',
          diff: diffContext,
          changedFiles,
          workingDirectory: working_directory,
        });
        if (contractResult.unsupported_files.length > 0) {
          this.deps.logger.info(
            { event: 'implementation.layer.contract_validation_unsupported', run_id: run.id, gate, round, unsupported_files: contractResult.unsupported_files },
            'Altitude contract: unsupported file types skipped (reviewed by prompts/critics)',
          );
        }
        if (!contractResult.valid) {
          this.deps.logger.info(
            { event: 'implementation.layer.contract_validation_failed', run_id: run.id, gate, round, violation_count: contractResult.violations.length },
            'Altitude contract validation failed — injecting synthetic findings for proposer revision',
          );
          const contractFindings: ImplementationReviewFinding[] = contractResult.violations.map(v => ({
            id: v.id,
            severity: 'blocker' as const,
            category: 'maintainability' as const,
            finding: v.message,
            scope: 'current_altitude' as const,
            reason_code: v.reason_code,
          } as ImplementationReviewFinding));

          if (round === maxRounds) {
            this.appendGateExchange(run, {
              id: randomUUID(), gate, round, created_at: new Date().toISOString(),
              proposer_profile: proposerSummary, critic_profile: criticSummary,
              review_status: 'non_converged', review_summary: 'Altitude contract violations persist after max rounds',
              findings: contractFindings, responses: [], converged: false,
              non_convergence_reason: 'max_rounds', requires_human_retest: false,
            }, captureFeedback);
            return { status: 'failed', error: `Altitude contract violations at ${String(gate)} gate persisted after ${maxRounds} rounds: ${contractResult.violations.map(v => v.message).join('; ')}` };
          }

          // Reserve budget for proposer revision
          let contractRevisionSessionId: string | undefined;
          if (sessionBudget) {
            try {
              const r = await sessionBudget.reserve({ gate: String(gate), role: 'proposer', round, passKind: 'initial' });
              contractRevisionSessionId = r.session_id;
            } catch (err) {
              this.deps.logger.warn({ event: 'implementation.review.budget_exhausted', run_id: run.id, gate, role: 'proposer', round, error: String(err) }, 'Budget exhausted before contract violation revision');
              return { status: 'failed', error: String(err) };
            }
          }

          const contractRevisePrompt = buildLayeredRevisePrompt({ gate, artifactPath: artifact_path, workingDirectory: working_directory, findings: contractFindings.map(f => ({ id: f.id, severity: f.severity, category: f.category, finding: f.finding })) });
          let contractReviseResult: ImplementationResult;
          try {
            contractReviseResult = await this.deps.implementer.implement(artifact_path, working_directory, contractRevisePrompt, onProgress ?? ((_msg: string) => Promise.resolve()), { run_id: run.id, request_id: run.request_id, phase: `implementation_review_${phase}_proposer`, route: { task: 'implementation.run', role: 'proposer' }, role: 'proposer', round, gate, captureSession, onAgentRequest });
          } catch (err) {
            if (sessionBudget && contractRevisionSessionId) await sessionBudget.complete(contractRevisionSessionId, 'failed').catch(() => {});
            return { status: 'failed', error: `Proposer revision for altitude contract violation failed: ${String(err)}` };
          }
          if (sessionBudget && contractRevisionSessionId) await sessionBudget.complete(contractRevisionSessionId, 'ok').catch(() => {});

          if (contractReviseResult.status !== 'complete') return contractReviseResult;

          this.appendGateExchange(run, {
            id: randomUUID(), gate, round, created_at: new Date().toISOString(),
            proposer_profile: proposerSummary, critic_profile: criticSummary,
            review_status: 'addressed', review_summary: 'Altitude contract violations — proposer asked to revise',
            findings: contractFindings, responses: contractReviseResult.review_responses ?? [], converged: false,
            requires_human_retest: false,
          }, captureFeedback);

          currentResult = contractReviseResult;
          previousSignatures.push(new Set(contractFindings.map(f => f.id)));
          previousBlockingCounts.push(contractFindings.length);
          continue; // Skip critic this round; re-validate next round
        }
      }

      // Build critic prompt with convergence context.
      // For early layered altitudes, use the altitude-aware critique prompt with
      // allowed-category guidance; build/initial/final keep the existing prompts.
      const convergenceContext = { gate, round };
      const prompt = isEarlyLayeredGate
        ? buildLayeredCritiquePrompt({
            gate,
            artifactPath: artifact_path,
            workingDirectory: working_directory,
            diffContext,
            changedFiles,
            round,
            allowedCategories: allowedCategoriesForGate(gate as LayeredConvergenceGate),
          })
        : phase === 'initial'
          ? buildInitialReviewPrompt(artifact_path, working_directory, currentResult, diffContext, changedFiles, convergenceContext)
          : buildFinalReviewPrompt(artifact_path, working_directory, currentResult, diffContext, changedFiles, convergenceContext);

      // Reserve model-session budget slot before critic call
      let criticSessionId: string | undefined;
      if (sessionBudget) {
        try {
          const r = await sessionBudget.reserve({ gate: String(gate), role: 'critic', round, passKind: phase === 'initial' ? 'initial' : 'final' });
          criticSessionId = r.session_id;
        } catch (err) {
          this.deps.logger.warn(
            { event: 'implementation.review.budget_exhausted', run_id: run.id, gate, role: 'critic', round, error: String(err) },
            'Model-session budget exhausted before critic call',
          );
          return { status: 'failed', error: String(err) };
        }
      }

      // Run critic
      let reviewResult: ReturnType<typeof parseImplementationReviewResult>;
      let drainSummary: AgentDrainSummary | undefined;
      const ts_start = new Date().toISOString();

      try {
        if (onAgentRequest) {
          onAgentRequest({
            model: criticProfile.model?.trim() || 'unknown',
            requested_at: new Date().toISOString(),
            route: { task: routeTask, role: 'critic' },
          });
        }

        const progressWithHeartbeat: typeof onProgress =
          onProgress && onAgentRequest
            ? async (msg: string) => {
                onAgentRequest({
                  model: criticProfile!.model?.trim() || 'unknown',
                  requested_at: new Date().toISOString(),
                  route: { task: routeTask, role: 'critic' },
                  is_heartbeat: true,
                });
                return onProgress(msg);
              }
            : onProgress;

        drainSummary = await drainAgentRunner(
          this.deps.runner.run({
            route: { task: routeTask, role: 'critic' },
            profile: criticProfile,
            working_directory,
            prompt,
            telemetry: {
              run_id: run.id,
              request_id: run.request_id,
              phase: `implementation_review_${phase}_critic`,
              route_task: routeTask,
              handler: 'ImplementationReviewCoordinator.convergence',
            },
          }),
          progressWithHeartbeat,
          this.deps.logger,
          `implementation_review_${phase}_critic`,
          { run_id: run.id, request_id: run.request_id },
        );

        const reviewResultContent = await this.readFileFn(reviewResultPath, 'utf-8');
        reviewResult = parseImplementationReviewResult(reviewResultContent, reviewResultPath);
        if (sessionBudget && criticSessionId) {
          await sessionBudget.complete(criticSessionId, 'ok').catch(() => {});
        }
        this.emitSessionRecord(captureSession, criticProfile, routeTask, ts_start, 'ok', drainSummary, { role: 'critic', round, gate });
      } catch (err) {
        if (sessionBudget && criticSessionId) {
          await sessionBudget.complete(criticSessionId, 'failed').catch(() => {});
        }
        this.emitSessionRecord(captureSession, criticProfile, routeTask, ts_start, 'failed', drainSummary, { role: 'critic', round, gate });
        this.deps.logger.error(
          { event: 'implementation.review.round_failed', phase, gate, round, run_id: run.id, error: String(err) },
          'Convergence review round failed',
        );
        return this.handleReviewFailure(phase, run, currentResult, proposerSummary, criticSummary, String(err), captureFeedback);
      }

      if (reviewResult.status === 'failed') {
        this.deps.logger.error(
          { event: 'implementation.review.round_failed', phase, gate, round, run_id: run.id, reason: 'review_agent_status_failed', error: reviewResult.error },
          'Convergence review round failed: review agent reported failure',
        );
        return this.handleReviewFailure(phase, run, currentResult, proposerSummary, criticSummary, reviewResult.error ?? 'Review model reported failure', captureFeedback);
      }

      const duration_ms = Math.round(performance.now() - roundStart);
      const blockerCount = reviewResult.findings.filter(f => f.severity === 'blocker').length;
      const warningCount = reviewResult.findings.filter(f => f.severity === 'warning').length;
      const infoCount = reviewResult.findings.filter(f => f.severity === 'info').length;

      this.deps.logger.info(
        { event: 'implementation.review.round_completed', phase, gate, round, run_id: run.id, review_profile: criticProfile.id, duration_ms, blocker_count: blockerCount, warning_count: warningCount, info_count: infoCount },
        'Convergence review round completed',
      );

      // For layered early altitudes, enrich findings with disposition metadata
      // and use the filter-derived blocking set; otherwise keep legacy behavior.
      let effectiveFindings = reviewResult.findings;
      let blockingFindings: ImplementationReviewFinding[];
      if (isEarlyLayeredGate) {
        const filterResult = filterLayeredFindings({ gate, round, findings: reviewResult.findings, runId: run.id });
        effectiveFindings = filterResult.findings;
        blockingFindings = filterResult.blockingFindings;
      } else {
        blockingFindings = this.blockingFindings(reviewResult.findings);
      }

      // Check for convergence
      if (reviewResult.status === 'no_findings' || blockingFindings.length === 0) {
        // For the build altitude, verify that converged upper-altitude contracts are
        // preserved before reporting convergence. Drift is treated as a synthetic blocker.
        if (gate === 'build' && loopOpts?.acceptedCheckpoints && loopOpts.acceptedCheckpoints.length > 0) {
          const driftResult = await (this.deps.compareBuildToAcceptedContracts ?? compareBuildToAcceptedContracts)({
            workingDirectory: working_directory,
            acceptedCheckpoints: loopOpts.acceptedCheckpoints,
          });
          if (!driftResult.valid) {
            this.deps.logger.info(
              { event: 'implementation.build.contract_drift_detected', run_id: run.id, gate, round, drift_count: driftResult.drift.length },
              'Build contract drift detected against accepted upper-altitude checkpoints',
            );
            const driftFindings: ImplementationReviewFinding[] = driftResult.drift.map((d, idx) => ({
              id: `BUILD-CONTRACT-DRIFT-${idx + 1}`,
              severity: 'blocker' as const,
              category: 'maintainability' as const,
              finding: d.message,
              ...(d.symbol ? { suggested_action: `Restore the reviewed ${d.kind} '${d.symbol}' or rerun the affected upper altitude.` } : {}),
            } as ImplementationReviewFinding));

            if (round === maxRounds) {
              this.appendGateExchange(run, {
                id: randomUUID(), gate, round, created_at: new Date().toISOString(),
                proposer_profile: proposerSummary, critic_profile: criticSummary,
                review_status: 'non_converged', review_summary: 'Build contract drift persists after max rounds',
                findings: [...effectiveFindings, ...driftFindings], responses: [], converged: false,
                non_convergence_reason: 'max_rounds', requires_human_retest: false,
              }, captureFeedback);
              return { status: 'failed', error: `Build gate: contract drift detected and no revision budget remaining. Drift: ${driftResult.drift.map(d => d.message).join('; ')}` };
            }

            // Reserve proposer budget for drift revision
            let driftRevisionSessionId: string | undefined;
            if (sessionBudget) {
              try {
                const r = await sessionBudget.reserve({ gate: String(gate), role: 'proposer', round, passKind: 'initial' });
                driftRevisionSessionId = r.session_id;
              } catch (err) {
                this.deps.logger.warn({ event: 'implementation.review.budget_exhausted', run_id: run.id, gate, role: 'proposer', round, error: String(err) }, 'Budget exhausted before contract drift revision');
                return { status: 'failed', error: String(err) };
              }
            }

            const driftRevisePrompt = buildImplementerResponsePrompt(artifact_path, working_directory, currentResult, driftFindings, { gate, round });
            let driftReviseResult: ImplementationResult;
            try {
              driftReviseResult = await this.deps.implementer.implement(artifact_path, working_directory, driftRevisePrompt, onProgress ?? ((_msg: string) => Promise.resolve()), { run_id: run.id, request_id: run.request_id, phase: `implementation_review_${phase}_proposer`, route: { task: 'implementation.run', role: 'proposer' }, role: 'proposer', round, gate, captureSession, onAgentRequest });
            } catch (err) {
              if (sessionBudget && driftRevisionSessionId) await sessionBudget.complete(driftRevisionSessionId, 'failed').catch(() => {});
              return { status: 'failed', error: `Proposer revision for build contract drift failed: ${String(err)}` };
            }
            if (sessionBudget && driftRevisionSessionId) await sessionBudget.complete(driftRevisionSessionId, 'ok').catch(() => {});

            if (driftReviseResult.status !== 'complete') return driftReviseResult;

            this.appendGateExchange(run, {
              id: randomUUID(), gate, round, created_at: new Date().toISOString(),
              proposer_profile: proposerSummary, critic_profile: criticSummary,
              review_status: 'addressed', review_summary: 'Build contract drift — proposer asked to revise',
              findings: [...effectiveFindings, ...driftFindings], responses: driftReviseResult.review_responses ?? [], converged: false,
              requires_human_retest: false,
            }, captureFeedback);

            currentResult = driftReviseResult;
            previousSignatures.push(new Set(driftFindings.map(f => f.id)));
            previousBlockingCounts.push(driftFindings.length);
            continue; // Loop back to re-run critic and re-check drift
          }
        }

        this.appendGateExchange(run, {
          id: randomUUID(),
          gate,
          round,
          created_at: new Date().toISOString(),
          proposer_profile: proposerSummary,
          critic_profile: criticSummary,
          review_status: 'converged',
          review_summary: reviewResult.summary,
          findings: effectiveFindings,
          responses: [],
          converged: true,
          requires_human_retest: reviewResult.requires_human_retest ?? false,
        }, captureFeedback);

        const layerElapsed_ms = Math.round(performance.now() - layerStart);
        this.deps.logger.info(
          { event: 'implementation.review.converged', phase, gate, round, run_id: run.id, rounds_used: round, finding_count: effectiveFindings.length, filtered_count: effectiveFindings.length - blockingFindings.length, elapsed_ms: layerElapsed_ms },
          'Implementation review converged',
        );
        if (isNamedGate) {
          this.deps.logger.info(
            { event: 'implementation.layer.completed', run_id: run.id, gate, elapsed_ms: layerElapsed_ms },
            'Layer altitude completed',
          );
        }

        const altLabel = isNamedGate ? gateLabel(gate as LayeredConvergenceGate) : (phase === 'initial' ? 'Initial review' : 'Final review');
        const convergedMsg = gate === 'build'
          ? `Build converged after ${round} round${round === 1 ? '' : 's'} — creating testing guide`
          : isNamedGate
            ? `${altLabel} converged after ${round} round${round === 1 ? '' : 's'}`
            : `${altLabel} converged after ${round} round${round === 1 ? '' : 's'}`;
        await this.sendProgress(onProgress, run, phase, round, gate, convergedMsg);

        return currentResult;
      }

      // Oscillation check (only after at least one proposer response)
      if (previousSignatures.length > 0 && this.isOscillating(previousSignatures, previousBlockingCounts, reviewResult.findings)) {
        this.appendGateExchange(run, {
          id: randomUUID(),
          gate,
          round,
          created_at: new Date().toISOString(),
          proposer_profile: proposerSummary,
          critic_profile: criticSummary,
          review_status: 'non_converged',
          review_summary: reviewResult.summary,
          findings: effectiveFindings,
          responses: [],
          converged: false,
          non_convergence_reason: 'oscillation',
          requires_human_retest: reviewResult.requires_human_retest ?? false,
        }, captureFeedback);

        const oscillationElapsed_ms = Math.round(performance.now() - layerStart);
        this.deps.logger.warn(
          { event: 'implementation.review.oscillation_detected', run_id: run.id, gate, round, rounds_used: round, elapsed_ms: oscillationElapsed_ms, signature_count: this.signatureSet(reviewResult.findings).size },
          'Implementation review did not converge: oscillation detected',
        );

        const oscillationLabel = isNamedGate ? gateLabel(gate as LayeredConvergenceGate) : (phase === 'initial' ? 'Initial review' : 'Final review');
        await this.sendProgress(onProgress, run, phase, round, gate, `${oscillationLabel} did not converge: oscillation detected after ${round} round${round === 1 ? '' : 's'}`);

        return { status: 'failed', error: `Implementation review ${phase} did not converge because oscillation was detected` };
      }

      // Max rounds check
      if (round === maxRounds) {
        this.appendGateExchange(run, {
          id: randomUUID(),
          gate,
          round,
          created_at: new Date().toISOString(),
          proposer_profile: proposerSummary,
          critic_profile: criticSummary,
          review_status: 'non_converged',
          review_summary: reviewResult.summary,
          findings: effectiveFindings,
          responses: [],
          converged: false,
          non_convergence_reason: 'max_rounds',
          requires_human_retest: reviewResult.requires_human_retest ?? false,
        }, captureFeedback);

        const maxRoundsElapsed_ms = Math.round(performance.now() - layerStart);
        this.deps.logger.warn(
          { event: 'implementation.review.non_converged', phase, gate, round, run_id: run.id, reason: 'max_rounds', rounds_used: round, elapsed_ms: maxRoundsElapsed_ms },
          'Implementation review did not converge: max_rounds reached',
        );

        const maxRoundsLabel = isNamedGate ? gateLabel(gate as LayeredConvergenceGate) : (phase === 'initial' ? 'Initial review' : 'Final review');
        await this.sendProgress(onProgress, run, phase, round, gate, `${maxRoundsLabel} did not converge after ${maxRounds} round${maxRounds === 1 ? '' : 's'}`);

        return { status: 'failed', error: `Implementation review ${phase} did not converge after ${maxRounds} rounds` };
      }

      // Run proposer response. Early layered altitudes use the altitude-aware
      // revise prompt so the proposer stays within the current altitude contract.
      const responsePrompt = isEarlyLayeredGate
        ? buildLayeredRevisePrompt({
            gate,
            artifactPath: artifact_path,
            workingDirectory: working_directory,
            findings: blockingFindings.map(f => ({
              id: f.id,
              severity: f.severity,
              category: f.category,
              finding: f.finding,
              ...(f.suggested_action ? { suggested_action: f.suggested_action } : {}),
            })),
          })
        : buildImplementerResponsePrompt(artifact_path, working_directory, currentResult, blockingFindings, convergenceContext);
      const proposerTelemetry: AgentServiceTelemetry = {
        run_id: run.id,
        request_id: run.request_id,
        phase: `implementation_review_${phase}_proposer`,
        route: proposerRoute,
        role: 'proposer',
        round,
        gate,
        captureSession,
        onAgentRequest,
      };

      // Reserve model-session budget slot before proposer revision call
      let proposerSessionId: string | undefined;
      if (sessionBudget) {
        try {
          const r = await sessionBudget.reserve({ gate: String(gate), role: 'proposer', round, passKind: phase === 'initial' ? 'initial' : 'final' });
          proposerSessionId = r.session_id;
        } catch (err) {
          this.deps.logger.warn(
            { event: 'implementation.review.budget_exhausted', run_id: run.id, gate, role: 'proposer', round, error: String(err) },
            'Model-session budget exhausted before proposer revision call',
          );
          return { status: 'failed', error: String(err) };
        }
      }

      let proposerResult: ImplementationResult;
      try {
        proposerResult = await this.deps.implementer.implement(
          artifact_path,
          working_directory,
          responsePrompt,
          onProgress ?? ((_msg: string) => Promise.resolve()),
          proposerTelemetry,
        );
      } catch (err) {
        if (sessionBudget && proposerSessionId) {
          await sessionBudget.complete(proposerSessionId, 'failed').catch(() => {});
        }
        return { status: 'failed', error: `Proposer response to review failed: ${String(err)}` };
      }
      if (sessionBudget && proposerSessionId) {
        await sessionBudget.complete(proposerSessionId, 'ok').catch(() => {});
      }

      if (proposerResult.status !== 'complete') {
        return proposerResult;
      }

      // Branch guard after proposer response
      if (this.deps.branchGuard) {
        try {
          await this.deps.branchGuard.check(working_directory, run.branch);
        } catch (err) {
          return { status: 'failed', error: `Branch guard failed after proposer response: ${String(err)}` };
        }
      }

      // Validate responses
      const responses = proposerResult.review_responses ?? [];
      this.validateResponses(run, blockingFindings, responses);

      // Append addressed gate exchange
      this.appendGateExchange(run, {
        id: randomUUID(),
        gate,
        round,
        created_at: new Date().toISOString(),
        proposer_profile: proposerSummary,
        critic_profile: criticSummary,
        review_status: 'addressed',
        review_summary: reviewResult.summary,
        findings: effectiveFindings,
        responses,
        converged: false,
        requires_human_retest: proposerResult.requires_human_retest ?? false,
      }, captureFeedback);

      currentResult = proposerResult;

      // Track signatures after proposer response for oscillation detection in next round
      previousSignatures.push(this.signatureSet(blockingFindings));
      previousBlockingCounts.push(blockingFindings.length);

      const reviseLabel = isNamedGate ? gateLabel(gate as LayeredConvergenceGate) : (phase === 'initial' ? 'Initial review' : 'Final review');
      await this.sendProgress(
        onProgress,
        run,
        phase,
        round,
        gate,
        `${reviseLabel} review round ${round} returned ${blockingFindings.length} finding${blockingFindings.length === 1 ? '' : 's'} — asking proposer to revise`,
      );
    }

    // Should not reach here
    return { status: 'failed', error: `Implementation review ${phase} did not converge` };
  }

  private assertDistinctProfiles(
    phase: 'initial' | 'final',
    proposerProfile: AgentProfile | null,
    criticProfile: AgentProfile,
  ): ImplementationResult | null {
    if (!proposerProfile) return null; // no proposer configured, cannot compare

    if (proposerProfile.id === criticProfile.id) {
      if (!this.deps.policy.convergence.allow_same_model) {
        this.deps.logger.warn(
          { event: 'implementation.review.same_model_rejected', gate: phase, profile_id: proposerProfile.id },
          'Same-profile proposer and critic rejected',
        );
        return {
          status: 'failed',
          error: `Implementation review convergence requires distinct proposer and critic profiles for ${phase} review. Both resolved to ${proposerProfile.id}. Configure implementation.run:proposer and implementation.review.${phase}:critic differently, or set implementation_review.convergence.allow_same_model: true.`,
        };
      }
      // allow_same_model: true — warn but continue
      this.deps.logger.warn(
        { event: 'implementation.review.same_model_allowed', gate: phase, profile_id: proposerProfile.id },
        'Same-profile proposer and critic allowed by configuration',
      );
    } else {
      // Different IDs — check for same provider/model alias and warn
      if (proposerProfile.provider === criticProfile.provider && proposerProfile.model === criticProfile.model) {
        this.deps.logger.warn(
          { event: 'implementation.review.same_model_alias_warning', gate: phase, proposer_id: proposerProfile.id, critic_id: criticProfile.id },
          'Proposer and critic have different profile IDs but same provider/model',
        );
      }
    }
    return null;
  }

  private emitSessionRecord(
    captureSession: AgentSessionCaptureFn | undefined,
    profile: AgentProfile,
    routeTask: 'implementation.review.initial' | 'implementation.review.final',
    ts_start: string,
    outcome: 'ok' | 'failed',
    drainSummary: AgentDrainSummary | undefined,
    convergenceMeta?: { role: 'critic' | 'proposer'; round: number; gate: 'initial' | 'final' | string },
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
      ...(convergenceMeta ?? {}),
    });
  }

  private handleReviewFailure(
    phase: 'initial' | 'final',
    run: Run,
    original: ImplementationResult,
    implSummary: ReturnType<typeof agentProfileSummary>,
    reviewSummary: ReturnType<typeof agentProfileSummary>,
    errorMsg: string,
    captureFeedback?: (exchange: ImplementationReviewExchange | GateReviewExchange, run: Run) => void,
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

  private appendExchange(run: Run, exchange: ImplementationReviewExchange, captureFeedback?: (exchange: ImplementationReviewExchange | GateReviewExchange, run: Run) => void): void {
    if (!run.review_exchanges) run.review_exchanges = [];
    run.review_exchanges.push(exchange);
    captureFeedback?.(exchange, run);
  }

  private blockingFindings(findings: ImplementationReviewFinding[]): ImplementationReviewFinding[] {
    return findings.filter(f => f.severity === 'blocker' || f.severity === 'warning');
  }

  private findingSignature(finding: ImplementationReviewFinding): string {
    const normalized = finding.finding
      .toLowerCase()
      .replace(/\b(?:[a-f0-9]{7,40}|[A-Z]+-\d+)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return `${finding.severity}|${finding.category}|${normalized}`;
  }

  private signatureSet(findings: ImplementationReviewFinding[]): Set<string> {
    const blocking = this.blockingFindings(findings);
    return new Set(blocking.map(f => this.findingSignature(f)));
  }

  private isOscillating(
    previousSignatures: Set<string>[],
    previousCounts: number[],
    currentFindings: ImplementationReviewFinding[],
  ): boolean {
    const currentBlocking = this.blockingFindings(currentFindings);
    const currentCount = currentBlocking.length;
    const currentSigs = this.signatureSet(currentFindings);

    // Check if same signature set appeared before with no shrink
    for (const prev of previousSignatures) {
      if (prev.size === currentSigs.size && [...prev].every(sig => currentSigs.has(sig))) {
        return true; // repeated non-shrinking signature set
      }
    }

    // Check two consecutive count increases
    if (previousCounts.length >= 2) {
      const last = previousCounts[previousCounts.length - 1]!;
      const secondLast = previousCounts[previousCounts.length - 2]!;
      if (currentCount > last && last > secondLast) {
        return true; // two consecutive increases
      }
    }

    return false;
  }

  private appendGateExchange(
    run: Run,
    exchange: GateReviewExchange,
    captureFeedback?: (exchange: ImplementationReviewExchange | GateReviewExchange, run: Run) => void,
  ): void {
    if (!run.gate_exchanges) run.gate_exchanges = [];
    run.gate_exchanges.push(exchange);
    captureFeedback?.(exchange, run);
  }

  private async sendProgress(
    onProgress: ((message: string) => Promise<void>) | undefined,
    run: Run,
    phase: 'initial' | 'final',
    round: number,
    gate: 'initial' | 'final' | LayeredConvergenceGate,
    message: string,
  ): Promise<void> {
    if (!onProgress) return;
    try {
      await onProgress(message);
    } catch (err) {
      this.deps.logger.warn(
        { event: 'progress_failed', phase, gate, round, run_id: run.id, error: String(err) },
        'Progress message failed to send',
      );
    }
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
