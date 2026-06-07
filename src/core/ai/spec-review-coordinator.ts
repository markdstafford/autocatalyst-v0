import { join } from 'node:path';
import { readFile as _readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type pino from 'pino';
import type {
  AgentDrainSummary,
  AgentInvocationMetadata,
  AgentProfile,
  AgentRunner,
  AgentRoutingPolicy,
  AgentSessionCaptureFn,
  ArtifactAuthoringAgent,
  SpecReviewAuthorResponseResult,
  SpecReviewFinding,
  SpecReviewResult,
} from '../../types/ai.js';
import type { ArtifactKind } from '../../types/artifact.js';
import type { SpecReviewPolicy } from '../../types/config.js';
import type { Run } from '../../types/runs.js';
import {
  buildSpecReviewPrompt,
  buildSpecAuthorResponsePrompt,
  parseSpecReviewResult,
  drainAgentRunner,
} from './agent-services.js';
import { agentProfileSummary } from './routing-policy.js';

type ReadFileFn = (path: string, encoding: 'utf-8') => Promise<string>;

export interface SpecReviewCoordinatorDeps {
  runner: AgentRunner;
  artifactAuthoringAgent: Pick<ArtifactAuthoringAgent, 'respondToSpecReview'>;
  routingPolicy: AgentRoutingPolicy;
  policy: Required<SpecReviewPolicy>;
  logger: Pick<pino.Logger, 'info' | 'warn' | 'debug' | 'error'>;
  readFile?: ReadFileFn;
}

export interface SpecReviewRunParams {
  run: Run;
  artifact_path: string;
  working_directory: string;
  artifact_kind: ArtifactKind;
  current_page_markdown?: string;
  onProgress?: (message: string) => Promise<void>;
  onAgentRequest?: (metadata: AgentInvocationMetadata) => void;
  captureSession?: AgentSessionCaptureFn;
}

export interface SpecReviewRunResult {
  status: 'complete' | 'needs_input' | 'failed';
  artifact_path: string;
  page_content?: string;
  summary?: string;
  question?: string;
  error?: string;
}

export class SpecReviewCoordinator {
  private readonly readFileFn: ReadFileFn;

  constructor(private readonly deps: SpecReviewCoordinatorDeps) {
    this.readFileFn = deps.readFile ?? ((path, enc) => _readFile(path, enc));
  }

  async runSpecReview(params: SpecReviewRunParams): Promise<SpecReviewRunResult> {
    const { run, artifact_path, working_directory, artifact_kind, current_page_markdown, onProgress, onAgentRequest, captureSession } = params;

    const reviewProfile = this.deps.routingPolicy.resolveOptional({ task: 'spec.review', artifact_kind });

    if (!reviewProfile) {
      this.deps.logger.warn(
        { event: 'spec.review.skipped', run_id: run.id },
        'No spec.review route configured — skipping spec review',
      );
      return { status: 'complete', artifact_path };
    }

    const reviewSummary = agentProfileSummary(reviewProfile);

    this.deps.logger.info(
      { event: 'spec.review.started', run_id: run.id, review_profile: reviewSummary.profile },
      'Starting spec review',
    );

    if (onProgress) {
      await onProgress(`Spec draft complete — starting AI spec review with ${reviewSummary.profile}`).catch(() => {});
    }

    if (onAgentRequest) {
      onAgentRequest({
        model: reviewProfile.model?.trim() || 'unknown',
        requested_at: new Date().toISOString(),
        route: { task: 'spec.review', artifact_kind },
      });
    }

    const reviewResultPath = join(working_directory, '.autocatalyst', 'spec-review-result.json');
    const prompt = buildSpecReviewPrompt({
      artifact_path,
      artifact_kind,
      working_directory,
      result_path: reviewResultPath,
      template_conformance: this.deps.policy.template_conformance,
      current_page_markdown,
    });

    try {
      await mkdir(dirname(reviewResultPath), { recursive: true });
    } catch { /* ignore */ }

    this.deps.logger.info(
      { event: 'spec.review.round_started', run_id: run.id, review_profile: reviewProfile.id },
      'Spec review round started',
    );

    let reviewResultContent: string;
    let reviewResult: SpecReviewResult;
    let drainSummary: AgentDrainSummary | undefined;
    const ts_start = new Date().toISOString();
    try {
      drainSummary = await drainAgentRunner(
        this.deps.runner.run({
          route: { task: 'spec.review', artifact_kind },
          profile: reviewProfile,
          working_directory,
          prompt,
          telemetry: {
            run_id: run.id,
            request_id: run.request_id,
            phase: 'spec_review',
            route_task: 'spec.review',
            handler: 'SpecReviewCoordinator',
          },
        }),
        onProgress,
        this.deps.logger,
        'spec_review',
        { run_id: run.id, request_id: run.request_id },
      );
      reviewResultContent = await this.readFileFn(reviewResultPath, 'utf-8');
      reviewResult = parseSpecReviewResult(reviewResultContent, reviewResultPath);
      this.emitSessionRecord(captureSession, reviewProfile, ts_start, 'ok', drainSummary);
    } catch (err) {
      this.emitSessionRecord(captureSession, reviewProfile, ts_start, 'failed', drainSummary);
      return this.handleReviewFailure(run, artifact_path, String(err), onProgress);
    }

    if (reviewResult.status === 'failed') {
      return this.handleReviewFailure(run, artifact_path, reviewResult.error ?? 'Review model reported failure', onProgress);
    }

    const blockerCount = reviewResult.findings.filter(f => f.severity === 'blocker').length;
    const warningCount = reviewResult.findings.filter(f => f.severity === 'warning').length;
    const infoCount = reviewResult.findings.filter(f => f.severity === 'info').length;
    this.deps.logger.info(
      {
        event: 'spec.review.round_completed',
        run_id: run.id,
        review_profile: reviewProfile.id,
        blocker_count: blockerCount,
        warning_count: warningCount,
        info_count: infoCount,
      },
      'Spec review round completed',
    );

    if (reviewResult.status === 'no_findings') {
      if (onProgress) {
        await onProgress('Spec review found no findings — publishing for review').catch(() => {});
      }
      this.deps.logger.info(
        { event: 'spec.review.completed', run_id: run.id, status: 'no_findings' },
        'Spec review completed with no findings',
      );
      return { status: 'complete', artifact_path };
    }

    if (onProgress) {
      await onProgress(`Spec review returned ${reviewResult.findings.length} finding(s) — asking the spec author to revise`).catch(() => {});
    }
    this.deps.logger.info(
      { event: 'spec.review.findings_returned', run_id: run.id, finding_count: reviewResult.findings.length },
      'Spec review findings returned to author',
    );

    const authorResponseResultPath = join(working_directory, '.autocatalyst', 'spec-review-author-response.json');
    const authorPrompt = buildSpecAuthorResponsePrompt({
      artifact_path,
      working_directory,
      result_path: authorResponseResultPath,
      findings: reviewResult.findings,
      current_page_markdown,
    });

    let authorResponse: SpecReviewAuthorResponseResult;
    const progressFn = onProgress ?? ((_msg: string) => Promise.resolve());
    try {
      authorResponse = await this.deps.artifactAuthoringAgent.respondToSpecReview(
        artifact_path,
        working_directory,
        authorPrompt,
        current_page_markdown,
        progressFn,
        { run_id: run.id, request_id: run.request_id, onAgentRequest },
      );
    } catch (err) {
      return { status: 'failed', artifact_path, error: `Spec author response failed: ${String(err)}` };
    }

    if (authorResponse.status === 'needs_input') {
      return { status: 'needs_input', artifact_path, question: authorResponse.question };
    }

    if (authorResponse.status === 'failed') {
      return { status: 'failed', artifact_path, error: authorResponse.error ?? 'Author response failed' };
    }

    const validationErrors = this.validateAuthorResponses(run, reviewResult.findings, authorResponse.responses ?? []);
    if (validationErrors.length > 0) {
      return {
        status: 'failed',
        artifact_path,
        error: `Author responses failed validation: ${validationErrors.join('; ')}`,
      };
    }

    this.deps.logger.info(
      { event: 'spec.review.author_response_completed', run_id: run.id, response_count: authorResponse.responses?.length ?? 0 },
      'Spec author response completed',
    );

    if (onProgress) {
      await onProgress('Spec author addressed review feedback — publishing for review').catch(() => {});
    }

    this.deps.logger.info(
      { event: 'spec.review.completed', run_id: run.id, status: 'findings_addressed' },
      'Spec review completed after author response',
    );

    return {
      status: 'complete',
      artifact_path,
      page_content: authorResponse.page_content,
      summary: reviewResult.summary,
    };
  }

  private emitSessionRecord(
    captureSession: AgentSessionCaptureFn | undefined,
    profile: AgentProfile,
    ts_start: string,
    outcome: 'ok' | 'failed',
    drainSummary: AgentDrainSummary | undefined,
  ): void {
    if (!captureSession) return;
    const runner = profile.provider === 'openai_agent_sdk' ? 'openai_agent' : 'anthropic_agent';
    captureSession({
      phase: 'spec_review',
      step: 'spec.review',
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
    run: Run,
    artifact_path: string,
    errorMsg: string,
    onProgress?: (message: string) => Promise<void>,
  ): SpecReviewRunResult {
    this.deps.logger.warn(
      { event: 'spec.review.degraded', run_id: run.id, error: errorMsg },
      'Spec review failed',
    );
    if (this.deps.policy.on_review_failure === 'block') {
      this.deps.logger.error(
        { event: 'spec.review.failed', run_id: run.id, error: errorMsg },
        'Spec review failed and policy is block',
      );
      return { status: 'failed', artifact_path, error: errorMsg };
    }
    if (onProgress) {
      onProgress('Spec review failed; continuing because on_review_failure is warn').catch(() => {});
    }
    return { status: 'complete', artifact_path };
  }

  private validateAuthorResponses(
    run: Run,
    findings: SpecReviewFinding[],
    responses: Array<{ id: string; disposition: string; response: string }>,
  ): string[] {
    const errors: string[] = [];
    const findingIds = new Set(findings.map(f => f.id));
    const seenResponseIds = new Set<string>();
    const validDispositions = new Set(['fixed', 'declined', 'needs_input']);

    for (const finding of findings) {
      if (!responses.some(r => r.id === finding.id)) {
        const msg = `No response for finding ID: ${finding.id}`;
        errors.push(msg);
        this.deps.logger.warn(
          { event: 'spec.review.response_invalid', run_id: run.id, missing_id: finding.id },
          msg,
        );
      }
    }

    for (const response of responses) {
      if (seenResponseIds.has(response.id)) {
        const msg = `Duplicate response for finding ID: ${response.id}`;
        errors.push(msg);
        this.deps.logger.warn(
          { event: 'spec.review.response_invalid', run_id: run.id, duplicate_id: response.id },
          msg,
        );
      }
      seenResponseIds.add(response.id);

      if (!findingIds.has(response.id)) {
        const msg = `Response references unknown finding ID: ${response.id}`;
        errors.push(msg);
        this.deps.logger.warn(
          { event: 'spec.review.response_invalid', run_id: run.id, unknown_id: response.id },
          msg,
        );
      }

      if (!validDispositions.has(response.disposition)) {
        const msg = `Invalid disposition '${response.disposition}' for finding ${response.id}`;
        errors.push(msg);
        this.deps.logger.warn(
          { event: 'spec.review.response_invalid', run_id: run.id, invalid_disposition: response.disposition, id: response.id },
          msg,
        );
      }

      if (!response.response?.trim()) {
        const msg = `Empty response explanation for finding ${response.id}`;
        errors.push(msg);
        this.deps.logger.warn(
          { event: 'spec.review.response_invalid', run_id: run.id, empty_response_id: response.id },
          msg,
        );
      }

      if (response.disposition === 'declined' && !response.response?.trim()) {
        // already caught by empty response check above
      } else if (response.disposition === 'declined' && response.response.trim().toLowerCase() === 'no action needed') {
        const msg = `Finding ${response.id} declined without a concrete reason`;
        errors.push(msg);
        this.deps.logger.warn(
          { event: 'spec.review.response_invalid', run_id: run.id, invalid_id: response.id },
          msg,
        );
      }
    }

    return errors;
  }
}
