import { randomUUID } from 'node:crypto';
import { mkdir, readFile as _readFile, writeFile as _writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type pino from 'pino';
import type {
  AgentInvocationMetadata,
  AgentProfile,
  AgentRoute,
  AgentRunner,
  AgentRoutingPolicy,
  AgentSessionCaptureFn,
  AuthoringApiConvergenceResult,
  AuthoringApiCritiqueResult,
  ConvergedApiArtifact,
  GateReviewExchange,
  ImplementationReviewFinding,
} from '../../types/ai.js';
import type { Run } from '../../types/runs.js';
import {
  buildAuthoringApiProposePrompt,
  buildAuthoringApiCritiquePrompt,
  buildAuthoringApiRevisePrompt,
  drainAgentRunner,
} from './agent-services.js';
import { parseConvergedApiArtifact, renderConvergedApiMarkdown } from './authoring-api-artifact.js';
import { agentProfileSummary } from './routing-policy.js';

export interface AuthoringApiConvergencePolicy {
  enabled: boolean;
  max_rounds: number;
  allow_same_model: boolean;
}

export interface AuthoringApiConvergenceCoordinatorDeps {
  runner: AgentRunner;
  routingPolicy: AgentRoutingPolicy;
  policy: AuthoringApiConvergencePolicy;
  logger: Pick<pino.Logger, 'info' | 'warn' | 'debug' | 'error'>;
  readFile?: (path: string, encoding: 'utf-8') => Promise<string>;
  writeFile?: (path: string, content: string, encoding: 'utf-8') => Promise<void>;
}

export interface AuthoringApiConvergenceParams {
  run: Run;
  artifact_path: string;
  working_directory: string;
  onProgress?: (message: string) => Promise<void>;
  onAgentRequest?: (metadata: AgentInvocationMetadata) => void;
  captureSession?: AgentSessionCaptureFn;
  captureFeedback?: (exchange: GateReviewExchange, run: Run) => void;
}

export class AuthoringApiConvergenceCoordinator {
  private readonly readFileFn: (path: string, encoding: 'utf-8') => Promise<string>;
  private readonly writeFileFn: (path: string, content: string, encoding: 'utf-8') => Promise<void>;

  constructor(private readonly deps: AuthoringApiConvergenceCoordinatorDeps) {
    this.readFileFn = deps.readFile ?? ((path, enc) => _readFile(path, enc));
    this.writeFileFn = deps.writeFile ?? ((path, content, enc) => _writeFile(path, content, enc));
  }

  async run(params: AuthoringApiConvergenceParams): Promise<AuthoringApiConvergenceResult> {
    const { run, artifact_path, working_directory, onProgress, onAgentRequest, captureSession, captureFeedback } = params;
    const { routingPolicy, policy, logger, runner } = this.deps;
    const maxRounds = policy.max_rounds;

    // 1. Resolve profiles (all before any async work)
    const proposerProfile =
      routingPolicy.resolveOptional({ task: 'artifact.api.propose', role: 'proposer' }) ??
      routingPolicy.resolveOptional({ task: 'artifact.create', role: 'proposer' }) ??
      routingPolicy.resolveOptional({ task: 'artifact.create' });

    const criticProfile =
      routingPolicy.resolveOptional({ task: 'artifact.api.critique', role: 'critic' }) ??
      routingPolicy.resolveOptional({ task: 'spec.review', role: 'critic' }) ??
      routingPolicy.resolveOptional({ task: 'spec.review' });

    if (!proposerProfile) {
      throw new Error('Authoring API convergence requires a proposer profile. Configure artifact.api.propose:proposer, artifact.create:proposer, or artifact.create.');
    }
    if (!criticProfile) {
      throw new Error('Authoring API convergence requires a critic profile. Configure artifact.api.critique:critic, spec.review:critic, or spec.review.');
    }

    // 2. Same-model guard
    if (proposerProfile.id === criticProfile.id) {
      if (!policy.allow_same_model) {
        throw new Error(
          'Authoring API convergence requires distinct proposer and critic profiles. Set spec_authoring.api_convergence.allow_same_model: true to allow same profile.',
        );
      }
    } else if (proposerProfile.provider === criticProfile.provider && proposerProfile.model === criticProfile.model) {
      logger.warn(
        {
          event: 'artifact.api_convergence.same_model_alias_warning',
          proposer_id: proposerProfile.id,
          critic_id: criticProfile.id,
          run_id: run.id,
        },
        'Proposer and critic have different profile IDs but same provider/model',
      );
    }

    const proposerSummary = agentProfileSummary(proposerProfile);
    const criticSummary = agentProfileSummary(criticProfile);

    // 3. Log started
    logger.info(
      {
        event: 'artifact.api_convergence.started',
        run_id: run.id,
        max_rounds: maxRounds,
        proposer_profile: proposerSummary.profile,
        critic_profile: criticSummary.profile,
      },
      'Authoring API convergence started',
    );

    const artifactResultPath = join(working_directory, '.autocatalyst', 'authoring-api-artifact.json');
    const critiqueResultPath = join(working_directory, '.autocatalyst', 'authoring-api-critique-result.json');

    let currentArtifact: ConvergedApiArtifact | null = null;

    // 4. Convergence loop
    for (let round = 1; round <= maxRounds; round++) {
      // a. Emit progress
      const roundAction = round === 1 ? 'proposer drafting API artifact' : 'critic reviewing revised API artifact';
      try {
        await onProgress?.(`API convergence round ${round} started — ${roundAction}`);
      } catch { /* ignore */ }

      // b. Log round started
      logger.info(
        { event: 'artifact.api_convergence.round_started', run_id: run.id, round },
        'API convergence round started',
      );

      // c. Read current spec
      const specMarkdown = await this.readFileFn(artifact_path, 'utf-8');

      // d+e. Run proposer on round 1 to get initial artifact
      if (round === 1) {
        try {
          await mkdir(dirname(artifactResultPath), { recursive: true });
        } catch { /* ignore */ }

        const proposePrompt = buildAuthoringApiProposePrompt(specMarkdown, artifactResultPath, round);
        const proposeRoute: AgentRoute = { task: 'artifact.api.propose', role: 'proposer' };
        const ts_start = new Date().toISOString();

        if (onAgentRequest) {
          onAgentRequest({
            model: proposerProfile.model?.trim() || 'unknown',
            requested_at: ts_start,
            route: proposeRoute,
          });
        }

        let drainSummary;
        try {
          drainSummary = await drainAgentRunner(
            runner.run({
              route: proposeRoute,
              profile: proposerProfile,
              working_directory,
              prompt: proposePrompt,
              telemetry: {
                run_id: run.id,
                request_id: run.request_id,
                phase: 'artifact_api_propose',
                route_task: proposeRoute.task,
                handler: 'AuthoringApiConvergenceCoordinator',
              },
            }),
            onProgress,
            logger,
            'artifact_api_propose',
            { run_id: run.id, request_id: run.request_id },
          );
          this.emitSessionRecord(captureSession, proposerProfile, proposeRoute, ts_start, 'ok', drainSummary, { role: 'proposer', round, gate: 'api' });
        } catch (err) {
          this.emitSessionRecord(captureSession, proposerProfile, proposeRoute, ts_start, 'failed', undefined, { role: 'proposer', round, gate: 'api' });
          throw new Error(`Authoring API convergence proposer failed at round ${round}: ${String(err)}`);
        }

        // f. Parse artifact
        try {
          const content = await this.readFileFn(artifactResultPath, 'utf-8');
          currentArtifact = parseConvergedApiArtifact(content, artifactResultPath);
        } catch (err) {
          if (round === maxRounds) {
            logger.error(
              { event: 'artifact.api_convergence.failed', run_id: run.id, round, error: String(err) },
              'Authoring API convergence failed: proposer produced invalid JSON artifact at max rounds',
            );
            throw new Error(`Authoring API convergence failed at max rounds: proposer produced invalid JSON artifact: ${String(err)}`);
          }
          // Synthetic finding for parse failure before max rounds — consume this round
          logger.warn(
            { event: 'artifact.api_convergence.parse_failed', run_id: run.id, round, error: String(err) },
            'Proposer returned invalid JSON artifact, consuming round',
          );
          continue;
        }
      }

      // At this point currentArtifact must be non-null (either from round 1 propose or from revision)
      if (!currentArtifact) {
        // This shouldn't happen after round 1 succeeds, but be safe
        continue;
      }

      // g. Run critic
      try {
        await mkdir(dirname(critiqueResultPath), { recursive: true });
      } catch { /* ignore */ }

      const critiquePrompt = buildAuthoringApiCritiquePrompt(specMarkdown, currentArtifact, critiqueResultPath, round);
      const critiqueRoute: AgentRoute = { task: 'artifact.api.critique', role: 'critic' };
      const critic_ts_start = new Date().toISOString();

      if (onAgentRequest) {
        onAgentRequest({
          model: criticProfile.model?.trim() || 'unknown',
          requested_at: critic_ts_start,
          route: critiqueRoute,
        });
      }

      let criticDrainSummary;
      try {
        criticDrainSummary = await drainAgentRunner(
          runner.run({
            route: critiqueRoute,
            profile: criticProfile,
            working_directory,
            prompt: critiquePrompt,
            telemetry: {
              run_id: run.id,
              request_id: run.request_id,
              phase: 'artifact_api_critique',
              route_task: critiqueRoute.task,
              handler: 'AuthoringApiConvergenceCoordinator',
            },
          }),
          onProgress,
          logger,
          'artifact_api_critique',
          { run_id: run.id, request_id: run.request_id },
        );
        this.emitSessionRecord(captureSession, criticProfile, critiqueRoute, critic_ts_start, 'ok', criticDrainSummary, { role: 'critic', round, gate: 'api' });
      } catch (err) {
        this.emitSessionRecord(captureSession, criticProfile, critiqueRoute, critic_ts_start, 'failed', undefined, { role: 'critic', round, gate: 'api' });
        throw new Error(`Authoring API convergence critic failed at round ${round}: ${String(err)}`);
      }

      // h. Parse critique
      let critique: AuthoringApiCritiqueResult;
      try {
        const content = await this.readFileFn(critiqueResultPath, 'utf-8');
        const parsed = JSON.parse(content) as Record<string, unknown>;
        critique = {
          status: (typeof parsed['status'] === 'string' ? parsed['status'] : 'failed') as AuthoringApiCritiqueResult['status'],
          summary: typeof parsed['summary'] === 'string' ? parsed['summary'] : '',
          findings: Array.isArray(parsed['findings']) ? (parsed['findings'] as ImplementationReviewFinding[]) : [],
          error: typeof parsed['error'] === 'string' ? parsed['error'] : undefined,
        };
        if (critique.status === 'failed') {
          logger.warn(
            { event: 'artifact.api_convergence.critique_status_failed', run_id: run.id, round, error: critique.error },
            'Critic reported status failed, treating as no findings',
          );
          critique = { status: 'no_findings', summary: critique.summary || critique.error || '', findings: [] };
        }
      } catch (err) {
        logger.warn(
          { event: 'artifact.api_convergence.critique_parse_failed', run_id: run.id, round, error: String(err) },
          'Critique result parse failed, treating as no findings',
        );
        critique = { status: 'no_findings', summary: '', findings: [] };
      }

      const blockingFindings = critique.findings.filter(f => f.severity === 'blocker' || f.severity === 'warning');

      // i. Log round completed
      logger.info(
        {
          event: 'artifact.api_convergence.round_completed',
          run_id: run.id,
          round,
          finding_count: critique.findings.length,
          blocker_count: blockingFindings.filter(f => f.severity === 'blocker').length,
          warning_count: blockingFindings.filter(f => f.severity === 'warning').length,
        },
        'API convergence round completed',
      );

      // j. Converged?
      if (critique.status === 'no_findings' || blockingFindings.length === 0) {
        const markdown = renderConvergedApiMarkdown(currentArtifact);
        const exchange: GateReviewExchange = {
          id: randomUUID(),
          gate: 'api',
          round,
          created_at: new Date().toISOString(),
          proposer_profile: proposerSummary,
          critic_profile: criticSummary,
          review_status: 'converged',
          review_summary: critique.summary,
          findings: critique.findings,
          responses: [],
          converged: true,
          requires_human_retest: false,
        };
        this.appendGateExchange(run, exchange);
        captureFeedback?.(exchange, run);

        try {
          await onProgress?.(`API convergence complete — ${currentArtifact.files.length} file(s), ${currentArtifact.public_api.length} public API item(s)`);
        } catch { /* ignore */ }

        logger.info(
          { event: 'artifact.api_convergence.converged', run_id: run.id, round },
          'Authoring API convergence converged',
        );

        return { artifact: currentArtifact, markdown, converged: true };
      }

      // k. Max rounds reached?
      if (round === maxRounds) {
        const markdown = renderConvergedApiMarkdown(currentArtifact);
        const exchange: GateReviewExchange = {
          id: randomUUID(),
          gate: 'api',
          round,
          created_at: new Date().toISOString(),
          proposer_profile: proposerSummary,
          critic_profile: criticSummary,
          review_status: 'non_converged',
          review_summary: critique.summary,
          findings: critique.findings,
          responses: [],
          converged: false,
          non_convergence_reason: 'max_rounds',
          requires_human_retest: false,
        };
        this.appendGateExchange(run, exchange);
        captureFeedback?.(exchange, run);

        try {
          await onProgress?.(`API convergence reached round cap — proceeding with current API`);
        } catch { /* ignore */ }

        logger.info(
          { event: 'artifact.api_convergence.non_converged', run_id: run.id, round, reason: 'max_rounds' },
          'Authoring API convergence did not converge: max_rounds reached',
        );

        return { artifact: currentArtifact, markdown, converged: false, non_convergence_reason: 'max_rounds' };
      }

      // l. More rounds: revise
      const findingCount = blockingFindings.length;
      try {
        await onProgress?.(`API critic returned ${findingCount} finding(s) — revising API artifact`);
      } catch { /* ignore */ }

      const revisePrompt = buildAuthoringApiRevisePrompt(specMarkdown, currentArtifact, critique.findings, artifactResultPath, round);
      const reviseRoute: AgentRoute = { task: 'artifact.api.propose', role: 'proposer' };
      const revise_ts_start = new Date().toISOString();

      if (onAgentRequest) {
        onAgentRequest({
          model: proposerProfile.model?.trim() || 'unknown',
          requested_at: revise_ts_start,
          route: reviseRoute,
        });
      }

      let reviseDrainSummary;
      try {
        reviseDrainSummary = await drainAgentRunner(
          runner.run({
            route: reviseRoute,
            profile: proposerProfile,
            working_directory,
            prompt: revisePrompt,
            telemetry: {
              run_id: run.id,
              request_id: run.request_id,
              phase: 'artifact_api_revise',
              route_task: reviseRoute.task,
              handler: 'AuthoringApiConvergenceCoordinator',
            },
          }),
          onProgress,
          logger,
          'artifact_api_revise',
          { run_id: run.id, request_id: run.request_id },
        );
        this.emitSessionRecord(captureSession, proposerProfile, reviseRoute, revise_ts_start, 'ok', reviseDrainSummary, { role: 'proposer', round, gate: 'api' });
      } catch (err) {
        this.emitSessionRecord(captureSession, proposerProfile, reviseRoute, revise_ts_start, 'failed', undefined, { role: 'proposer', round, gate: 'api' });
        throw new Error(`Authoring API convergence proposer revision failed at round ${round}: ${String(err)}`);
      }

      // Parse revised artifact (used in next round's critique)
      try {
        const content = await this.readFileFn(artifactResultPath, 'utf-8');
        currentArtifact = parseConvergedApiArtifact(content, artifactResultPath);
      } catch (err) {
        logger.warn(
          { event: 'artifact.api_convergence.revision_parse_failed', run_id: run.id, round, error: String(err) },
          'Revision artifact parse failed, keeping old artifact for next round',
        );
        // Keep currentArtifact unchanged — next round will critique with the old artifact
      }
    }

    // Should not reach here but TypeScript needs a return
    throw new Error('Authoring API convergence loop exited unexpectedly');
  }

  private appendGateExchange(run: Run, exchange: GateReviewExchange): void {
    if (!run.gate_exchanges) run.gate_exchanges = [];
    run.gate_exchanges.push(exchange);
  }

  private emitSessionRecord(
    captureSession: AgentSessionCaptureFn | undefined,
    profile: AgentProfile,
    route: AgentRoute,
    ts_start: string,
    outcome: 'ok' | 'failed',
    drainSummary: Awaited<ReturnType<typeof drainAgentRunner>> | undefined,
    meta: { role: 'proposer' | 'critic'; round: number; gate: string },
  ): void {
    if (!captureSession) return;
    const runner = profile.provider === 'openai_agent_sdk' ? 'openai_agent' : 'anthropic_agent';
    captureSession({
      phase: `artifact_api_convergence`,
      step: route.task,
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
      ...meta,
    });
  }
}
