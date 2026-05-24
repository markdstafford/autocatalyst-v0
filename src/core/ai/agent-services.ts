import { randomUUID } from 'node:crypto';
import { mkdir, readFile as _readFile, unlink } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type pino from 'pino';
import type { LoggerProvider } from '@opentelemetry/api-logs';
import { createLogger } from '../logger.js';
import type {
  AgentDrainSummary,
  AgentInvocationMetadata,
  AgentProfile,
  AgentRoute,
  AgentRunContentBlock,
  AgentRunEvent,
  AgentRunner,
  AgentRoutingPolicy,
  AgentServiceTelemetry,
  ArtifactAuthoringAgent,
  ArtifactComment,
  ArtifactCommentResponse,
  ArtifactCreateResult,
  ArtifactRevisionResult,
  ImplementationAgent,
  ImplementationPlanResult,
  ImplementationPlanningAgent,
  ImplementationResult,
  ImplementationReviewFinding,
  ImplementationReviewResult,
  ImplementationStatus,
  IssueTriageAgent,
  IssueTriageItem,
  IssueTriageResult,
  QuestionAnsweringAgent,
} from '../../types/ai.js';
import type { Request, ThreadMessage } from '../../types/events.js';
import type { FilingResult, FiledIssue, IssueFiler } from '../../types/issue-filing.js';
import type { IssueManager } from '../../types/issue-tracker.js';
import { artifactKindForIntent } from '../../types/artifact.js';
import type { ArtifactCommentAnchorCodec } from '../../types/publisher.js';

type ReadFileFn = (path: string, encoding: 'utf-8') => Promise<string>;

function notifyAgentRequest(
  telemetry: AgentServiceTelemetry | undefined,
  profile: AgentProfile,
  route: AgentRoute,
  is_heartbeat = false,
): void {
  telemetry?.onAgentRequest?.({
    model: profile.model?.trim() || 'unknown',
    requested_at: new Date().toISOString(),
    route,
    is_heartbeat,
  } satisfies AgentInvocationMetadata);
}

interface AgentServiceOptions {
  logDestination?: pino.DestinationStream;
  loggerProvider?: LoggerProvider;
  readFile?: ReadFileFn;
  commentAnchorCodec?: ArtifactCommentAnchorCodec;
}

export class AgentRunnerArtifactAuthoringAgent implements ArtifactAuthoringAgent {
  private readonly logger: pino.Logger;
  private readonly readFileFn: ReadFileFn;
  private readonly commentAnchorCodec: ArtifactCommentAnchorCodec | undefined;

  constructor(
    private readonly runner: AgentRunner,
    private readonly routingPolicy: AgentRoutingPolicy,
    options?: AgentServiceOptions,
  ) {
    this.logger = createLogger('artifact-authoring-agent', { destination: options?.logDestination, loggerProvider: options?.loggerProvider });
    this.readFileFn = options?.readFile ?? ((path, enc) => _readFile(path, enc));
    this.commentAnchorCodec = options?.commentAnchorCodec;
  }

  async create(
    request: Request,
    workspace_path: string,
    onProgress?: (message: string) => Promise<void>,
    intent: 'idea' | 'bug' | 'chore' = 'idea',
    telemetry?: AgentServiceTelemetry,
  ): Promise<ArtifactCreateResult> {
    const createResultPath = join(workspace_path, '.autocatalyst', 'spec-create-result.json');
    const artifactDir = (intent === 'bug' || intent === 'chore')
      ? join(workspace_path, '.autocatalyst', 'triage')
      : join(workspace_path, 'context-human', 'specs');
    const route = {
      task: 'artifact.create' as const,
      stage: 'new_thread' as const,
      intent,
      artifact_kind: artifactKindForIntent(intent),
    };
    const prompt = buildArtifactCreatePrompt(request, artifactDir, createResultPath, intent);

    this.logger.debug({ event: 'artifact.agent_invoked', request_id: request.id }, 'Invoking agent for artifact creation');

    const profile = this.routingPolicy.resolve(route);
    notifyAgentRequest(telemetry, profile, route);

    const progressWithHeartbeat: ((msg: string) => Promise<void>) | undefined =
      onProgress && telemetry?.onAgentRequest
        ? async (msg: string) => {
            notifyAgentRequest(telemetry, profile, route, true);
            return onProgress(msg);
          }
        : onProgress;

    let drainSummary: AgentDrainSummary | undefined;
    try {
      await ensureResultDir(createResultPath);
      drainSummary = await drainAgentRunner(
        this.runner.run({
          route,
          profile,
          working_directory: workspace_path,
          prompt,
          telemetry: {
            request_id: request.id,
            phase: 'artifact_generation',
            route_task: route.task,
            handler: 'AgentRunnerArtifactAuthoringAgent',
            ...(telemetry?.run_id ? { run_id: telemetry.run_id } : {}),
          },
        }),
        progressWithHeartbeat,
        this.logger,
        'artifact_generation',
        { run_id: telemetry?.run_id, request_id: telemetry?.request_id },
      );
    } catch (err) {
      this.logger.error(
        { event: 'artifact.agent_failed', request_id: request.id, error: String(err) },
        'Agent exited with error during artifact creation',
      );
      throw new Error(`Artifact creation failed: ${String(err)}`);
    }

    const content = await validateRequiredResultFile({
      readFileFn: this.readFileFn,
      path: createResultPath,
      label: 'Artifact creation',
      logger: this.logger,
      phase: 'artifact_generation',
      route_task: 'artifact.create',
      request_id: request.id,
      run_id: telemetry?.run_id,
      drainSummary,
    });
    const result = parseArtifactCreateResult(content, createResultPath);
    this.logger.info(
      { event: 'artifact.generated', request_id: request.id, artifact_path: result.artifact_path, existing_issue: result.existing_issue },
      'Artifact generated',
    );
    return result;
  }

  async revise(
    feedback: ThreadMessage,
    artifact_comments: ArtifactComment[],
    artifact_path: string,
    workspace_path: string,
    current_page_markdown?: string,
    onProgress?: (message: string) => Promise<void>,
    telemetry?: AgentServiceTelemetry,
  ): Promise<ArtifactRevisionResult> {
    const reviseResultPath = join(workspace_path, '.autocatalyst', 'spec-revise-result.json');
    const originalAnchors = current_page_markdown && this.commentAnchorCodec
      ? this.commentAnchorCodec.extract(current_page_markdown)
      : [];
    const hasAnchors = originalAnchors.length > 0;
    const currentArtifact = hasAnchors ? current_page_markdown! : readFileSync(artifact_path, 'utf-8');
    const route = {
      task: 'artifact.revise' as const,
      stage: 'reviewing_spec' as const,
      intent: 'feedback' as const,
    };
    const prompt = buildArtifactRevisePrompt(
      feedback,
      artifact_comments,
      artifact_path,
      reviseResultPath,
      currentArtifact,
      hasAnchors ? this.commentAnchorCodec?.promptInstructions(originalAnchors) ?? [] : [],
    );

    this.logger.debug(
      { event: 'artifact_revision.input', request_id: feedback.request_id, publisher_comment_count: artifact_comments.length },
      'Revise called with publisher comments',
    );

    const profile = this.routingPolicy.resolve(route);
    notifyAgentRequest(telemetry, profile, route);

    const progressWithHeartbeat: ((msg: string) => Promise<void>) | undefined =
      onProgress && telemetry?.onAgentRequest
        ? async (msg: string) => {
            notifyAgentRequest(telemetry, profile, route, true);
            return onProgress(msg);
          }
        : onProgress;

    let drainSummary: AgentDrainSummary | undefined;
    try {
      await ensureResultDir(reviseResultPath);
      drainSummary = await drainAgentRunner(
        this.runner.run({
          route,
          profile,
          working_directory: workspace_path,
          prompt,
          telemetry: {
            request_id: feedback.request_id,
            phase: 'artifact_generation',
            route_task: route.task,
            handler: 'AgentRunnerArtifactAuthoringAgent',
            ...(telemetry?.run_id ? { run_id: telemetry.run_id } : {}),
          },
        }),
        progressWithHeartbeat,
        this.logger,
        'artifact_generation',
        { run_id: telemetry?.run_id, request_id: telemetry?.request_id },
      );
    } catch (err) {
      this.logger.error(
        { event: 'artifact.agent_failed', request_id: feedback.request_id, error: String(err) },
        'Agent exited with error during artifact revision',
      );
      throw new Error(`Artifact revision failed: ${String(err)}`);
    }

    const content = await validateRequiredResultFile({
      readFileFn: this.readFileFn,
      path: reviseResultPath,
      label: 'Artifact revision',
      logger: this.logger,
      phase: 'artifact_generation',
      route_task: 'artifact.revise',
      request_id: feedback.request_id,
      run_id: telemetry?.run_id,
      drainSummary,
    });
    const commentResponses = parseCommentResponses(content, reviseResultPath);

    if (hasAnchors && this.commentAnchorCodec) {
      const agentArtifact = readFileSync(artifact_path, 'utf-8');
      const pageContent = this.commentAnchorCodec.preserve(agentArtifact, originalAnchors);
      writeFileSync(artifact_path, this.commentAnchorCodec.strip(pageContent), 'utf-8');
      return { comment_responses: commentResponses, page_content: pageContent };
    }

    return { comment_responses: commentResponses };
  }
}

export class AgentRunnerImplementationAgent implements ImplementationAgent {
  private readonly logger: pino.Logger;
  private readonly readFileFn: ReadFileFn;

  constructor(
    private readonly runner: AgentRunner,
    private readonly routingPolicy: AgentRoutingPolicy,
    options?: AgentServiceOptions,
  ) {
    this.logger = createLogger('implementation-agent', { destination: options?.logDestination, loggerProvider: options?.loggerProvider });
    this.readFileFn = options?.readFile ?? ((path, enc) => _readFile(path, enc));
  }

  async implement(
    artifact_path: string,
    working_directory: string,
    additional_context?: string,
    onProgress?: (message: string) => Promise<void>,
    telemetry?: AgentServiceTelemetry,
    plan_path?: string,
  ): Promise<ImplementationResult> {
    const resultFilePath = join(working_directory, '.autocatalyst', 'impl-result.json');
    const prompt = buildImplementationPrompt(artifact_path, resultFilePath, additional_context, plan_path);
    const route = { task: 'implementation.run' as const };

    this.logger.debug(
      { event: 'impl.agent_invoked', working_directory, has_additional_context: Boolean(additional_context), ...(telemetry?.run_id ? { run_id: telemetry.run_id } : {}), ...(telemetry?.request_id ? { request_id: telemetry.request_id } : {}) },
      'Invoking agent for implementation',
    );

    const profile = this.routingPolicy.resolve(route);
    notifyAgentRequest(telemetry, profile, route);

    const progressWithHeartbeat: ((msg: string) => Promise<void>) | undefined =
      onProgress && telemetry?.onAgentRequest
        ? async (msg: string) => {
            notifyAgentRequest(telemetry, profile, route, true);
            return onProgress(msg);
          }
        : onProgress;

    let drainSummary: AgentDrainSummary | undefined;
    try {
      await ensureResultDir(resultFilePath);
      drainSummary = await drainAgentRunner(
        this.runner.run({
          route,
          profile,
          working_directory,
          prompt,
          telemetry: {
            phase: 'implementation',
            route_task: route.task,
            handler: 'AgentRunnerImplementationAgent',
            ...(telemetry?.run_id ? { run_id: telemetry.run_id } : {}),
            ...(telemetry?.request_id ? { request_id: telemetry.request_id } : {}),
          },
        }),
        progressWithHeartbeat,
        this.logger,
        'implementation',
        { run_id: telemetry?.run_id, request_id: telemetry?.request_id },
      );
    } catch (err) {
      this.logger.error({ event: 'impl.agent_failed', error: String(err) }, 'Agent exited with error during implementation');
      const msg = String(err);
      if (msg.includes('exceeded') && msg.includes('output token')) {
        throw new Error(
          `Implementation failed: Claude Code hit its output token limit. ` +
          `Increase CLAUDE_CODE_MAX_OUTPUT_TOKENS (Autocatalyst default: 128000).`,
        );
      }
      throw new Error(`Implementation failed: ${msg}`);
    }

    const content = await validateRequiredResultFile({
      readFileFn: this.readFileFn,
      path: resultFilePath,
      label: 'Implementation',
      logger: this.logger,
      phase: 'implementation',
      route_task: 'implementation.run',
      run_id: telemetry?.run_id,
      request_id: telemetry?.request_id,
      drainSummary,
    });
    const result = parseImplementationResult(content, resultFilePath);
    this.logger.debug({ event: 'impl.agent_completed', status: result.status }, 'Agent implementation completed');
    return result;
  }
}

export class AgentRunnerImplementationPlanningAgent implements ImplementationPlanningAgent {
  private readonly logger: pino.Logger;
  private readonly readFileFn: ReadFileFn;

  constructor(
    private readonly runner: AgentRunner,
    private readonly routingPolicy: AgentRoutingPolicy,
    options?: AgentServiceOptions,
  ) {
    this.logger = createLogger('implementation-planning-agent', { destination: options?.logDestination, loggerProvider: options?.loggerProvider });
    this.readFileFn = options?.readFile ?? ((path, enc) => _readFile(path, enc));
  }

  async plan(
    artifact_path: string,
    working_directory: string,
    onProgress?: (message: string) => Promise<void>,
    telemetry?: AgentServiceTelemetry,
    additional_context?: string,
  ): Promise<ImplementationPlanResult> {
    const resultFilePath = join(working_directory, '.autocatalyst', 'implementation-plan-result.json');
    const prompt = buildImplementationPlanPrompt(artifact_path, working_directory, resultFilePath, additional_context);
    const route = { task: 'implementation.plan' as const, stage: 'planning' as const };

    this.logger.debug(
      { event: 'planning.agent_invoked', artifact_path, working_directory, ...(telemetry?.run_id ? { run_id: telemetry.run_id } : {}), ...(telemetry?.request_id ? { request_id: telemetry.request_id } : {}) },
      'Invoking agent for implementation planning',
    );

    const profile = this.routingPolicy.resolve(route);
    notifyAgentRequest(telemetry, profile, route);

    const progressWithHeartbeat: ((msg: string) => Promise<void>) | undefined =
      onProgress && telemetry?.onAgentRequest
        ? async (msg: string) => {
            notifyAgentRequest(telemetry, profile, route, true);
            return onProgress(msg);
          }
        : onProgress;

    let drainSummary: AgentDrainSummary | undefined;
    try {
      await ensureResultDir(resultFilePath);
      drainSummary = await drainAgentRunner(
        this.runner.run({
          route,
          profile,
          working_directory,
          prompt,
          telemetry: {
            phase: 'planning',
            route_task: route.task,
            handler: 'AgentRunnerImplementationPlanningAgent',
            ...(telemetry?.run_id ? { run_id: telemetry.run_id } : {}),
            ...(telemetry?.request_id ? { request_id: telemetry.request_id } : {}),
          },
        }),
        progressWithHeartbeat,
        this.logger,
        'planning',
        { run_id: telemetry?.run_id, request_id: telemetry?.request_id },
      );
    } catch (err) {
      this.logger.error({ event: 'planning.agent_failed', error: String(err) }, 'Agent exited with error during implementation planning');
      throw new Error(`Implementation planning failed: ${String(err)}`);
    }

    const content = await validateRequiredResultFile({
      readFileFn: this.readFileFn,
      path: resultFilePath,
      label: 'Implementation planning',
      logger: this.logger,
      phase: 'planning',
      route_task: 'implementation.plan',
      run_id: telemetry?.run_id,
      request_id: telemetry?.request_id,
      drainSummary,
    });
    const result = parseImplementationPlanResult(content, resultFilePath);
    this.logger.debug({ event: 'planning.agent_completed', status: result.status }, 'Agent implementation planning completed');
    return result;
  }
}

export class AgentRunnerQuestionAnsweringAgent implements QuestionAnsweringAgent {
  private readonly logger: pino.Logger;
  private readonly readFileFn: ReadFileFn;

  constructor(
    private readonly runner: AgentRunner,
    private readonly routingPolicy: AgentRoutingPolicy,
    private readonly repo_path: string,
    options?: AgentServiceOptions,
  ) {
    this.logger = createLogger('question-answering-agent', { destination: options?.logDestination, loggerProvider: options?.loggerProvider });
    this.readFileFn = options?.readFile ?? ((path, enc) => _readFile(path, enc));
  }

  async answer(question: string, telemetry?: AgentServiceTelemetry): Promise<string> {
    const resultPath = join(this.repo_path, '.autocatalyst', `question-${randomUUID()}.json`);
    const prompt = buildQuestionPrompt(question, resultPath);
    const route = { task: 'question.answer' as const };

    this.logger.debug({ event: 'question.answering', question_length: question.length, ...(telemetry?.run_id ? { run_id: telemetry.run_id } : {}), ...(telemetry?.request_id ? { request_id: telemetry.request_id } : {}) }, 'Answering question via agent');

    const profile = this.routingPolicy.resolve(route);
    notifyAgentRequest(telemetry, profile, route);

    let drainSummary: AgentDrainSummary | undefined;
    try {
      await ensureResultDir(resultPath);
      drainSummary = await drainAgentRunner(
        this.runner.run({
          route,
          profile,
          working_directory: this.repo_path,
          prompt,
          telemetry: {
            phase: 'question_answering',
            route_task: route.task,
            handler: 'AgentRunnerQuestionAnsweringAgent',
            ...(telemetry?.run_id ? { run_id: telemetry.run_id } : {}),
            ...(telemetry?.request_id ? { request_id: telemetry.request_id } : {}),
          },
        }),
        undefined,
        this.logger,
        'question_answering',
        { run_id: telemetry?.run_id, request_id: telemetry?.request_id },
      );
    } catch (err) {
      this.logger.error({ event: 'question.agent_failed', error: String(err), ...(telemetry?.run_id ? { run_id: telemetry.run_id } : {}), ...(telemetry?.request_id ? { request_id: telemetry.request_id } : {}) }, 'Agent exited with error during question answering');
      throw new Error(`Agent question answering failed: ${String(err)}`);
    }

    const content = await validateRequiredResultFile({
      readFileFn: this.readFileFn,
      path: resultPath,
      label: 'Question answering',
      logger: this.logger,
      phase: 'question_answering',
      route_task: 'question.answer',
      run_id: telemetry?.run_id,
      request_id: telemetry?.request_id,
      drainSummary,
    });
    unlink(resultPath).catch(() => {});
    const answer = parseQuestionAnswer(content);
    this.logger.info({ event: 'question.answered', response_length: answer.length }, 'Question answered');
    return answer;
  }
}

export class AgentRunnerIssueTriageAgent implements IssueTriageAgent {
  private readonly logger: pino.Logger;
  private readonly readFileFn: ReadFileFn;

  constructor(
    private readonly runner: AgentRunner,
    private readonly routingPolicy: AgentRoutingPolicy,
    options?: AgentServiceOptions,
  ) {
    this.logger = createLogger('issue-triage-agent', { destination: options?.logDestination, loggerProvider: options?.loggerProvider });
    this.readFileFn = options?.readFile ?? ((path, enc) => _readFile(path, enc));
  }

  async triage(
    request: Request,
    working_directory: string,
    onProgress?: (message: string) => Promise<void>,
    telemetry?: AgentServiceTelemetry,
  ): Promise<IssueTriageResult> {
    const resultPath = join(working_directory, '.autocatalyst', 'enrichment-result.json');
    const prompt = buildIssueTriagePrompt(request, resultPath);
    const route = { task: 'issue.triage' as const };

    this.logger.debug({ event: 'filing.agent_invoked', request_id: request.id }, 'Invoking agent for issue triage');

    const profile = this.routingPolicy.resolve(route);
    notifyAgentRequest(telemetry, profile, route);

    const progressWithHeartbeat: ((msg: string) => Promise<void>) | undefined =
      onProgress && telemetry?.onAgentRequest
        ? async (msg: string) => {
            notifyAgentRequest(telemetry, profile, route, true);
            return onProgress(msg);
          }
        : onProgress;

    let drainSummary: AgentDrainSummary | undefined;
    try {
      await ensureResultDir(resultPath);
      drainSummary = await drainAgentRunner(
        this.runner.run({
          route,
          profile,
          working_directory,
          prompt,
          telemetry: {
            request_id: request.id,
            phase: 'issue_triage',
            route_task: route.task,
            handler: 'AgentRunnerIssueTriageAgent',
            ...(telemetry?.run_id ? { run_id: telemetry.run_id } : {}),
          },
        }),
        progressWithHeartbeat,
        this.logger,
        'issue_triage',
        { run_id: telemetry?.run_id, request_id: telemetry?.request_id },
      );
    } catch (err) {
      this.logger.error(
        { event: 'filing.agent_failed', request_id: request.id, error: String(err) },
        'Agent exited with error during issue triage',
      );
      throw new Error(`Issue triage failed: ${String(err)}`);
    }

    const content = await validateRequiredResultFile({
      readFileFn: this.readFileFn,
      path: resultPath,
      label: 'Issue triage',
      logger: this.logger,
      phase: 'issue_triage',
      route_task: 'issue.triage',
      request_id: request.id,
      run_id: telemetry?.run_id,
      drainSummary,
    });
    return parseAndValidateIssueTriageResult(content, resultPath);
  }
}

export class IssueFilingService implements IssueFiler {
  constructor(
    private readonly issueManager: Pick<IssueManager, 'create'>,
    private readonly issueTriageAgent: IssueTriageAgent,
  ) {}

  async file(
    request: Request,
    workspace_path: string,
    onProgress?: (message: string) => Promise<void>,
    telemetry?: AgentServiceTelemetry,
  ): Promise<FilingResult> {
    const triageResult = await this.issueTriageAgent.triage(request, workspace_path, onProgress, telemetry);
    if (triageResult.status === 'failed') {
      return {
        status: 'failed',
        summary: '',
        filed_issues: [],
        error: triageResult.error ?? 'Issue triage agent reported failure',
      };
    }

    const filed_issues: FiledIssue[] = [];
    for (const item of triageResult.items) {
      if (item.duplicate_of) {
        filed_issues.push({
          number: item.duplicate_of.number,
          title: item.duplicate_of.title,
          action: 'duplicate',
        });
      } else {
        const created = await this.issueManager.create(
          workspace_path,
          item.proposed_title,
          item.proposed_body,
          item.proposed_labels,
        );
        filed_issues.push({ number: created.number, title: item.proposed_title, action: 'filed' });
      }
    }

    return { status: 'complete', summary: buildIssueFilingSummary(filed_issues), filed_issues };
  }
}

export async function drainAgentRunner(
  events: AsyncIterable<AgentRunEvent>,
  onProgress: ((message: string) => Promise<void> | void) | undefined,
  logger: Pick<pino.Logger, 'info' | 'warn' | 'debug' | 'error'>,
  phase: string,
  telemetry?: { run_id?: string; request_id?: string },
): Promise<AgentDrainSummary> {
  const startMs = performance.now();
  let event_count = 0;
  let assistant_turn_count = 0;
  let relay_count = 0;
  let tool_call_count = 0;
  let tool_result_count = 0;
  let latestDiagnostics: AgentDrainSummary['diagnostics'];

  const telCtx = {
    ...(telemetry?.run_id ? { run_id: telemetry.run_id } : {}),
    ...(telemetry?.request_id ? { request_id: telemetry.request_id } : {}),
  };

  logger.info({ event: 'agent.drain_started', phase, ...telCtx }, 'Agent drain started');

  try {
    for await (const event of events) {
      event_count++;

      // Capture diagnostics propagated from terminal runner events
      const eventDiag = (event as { diagnostics?: AgentDrainSummary['diagnostics'] }).diagnostics;
      if (eventDiag) latestDiagnostics = eventDiag;

      const content = assistantContent(event);
      if (content) {
        assistant_turn_count++;
        const evtAny = event as Record<string, unknown>;
        const tc = typeof evtAny['tool_call_count'] === 'number' ? evtAny['tool_call_count'] : 0;
        const tr = typeof evtAny['tool_result_count'] === 'number' ? evtAny['tool_result_count'] : 0;
        tool_call_count += tc;
        tool_result_count += tr;

        if (tc > 0) {
          const toolNames = Array.isArray(evtAny['tool_call_names']) ? evtAny['tool_call_names'] as string[] : undefined;
          logger.debug(
            { event: 'agent.tool_activity', phase, tool_call_count: tc, tool_call_names: toolNames, ...telCtx },
            'Agent tool activity',
          );
        }

        const relayMessage = parseRelayMessage(content);
        if (relayMessage) {
          relay_count++;
          if (onProgress) {
            try {
              await onProgress(relayMessage);
              logger.info({ event: 'progress_update', phase, message: relayMessage, ...telCtx }, 'Progress update posted');
            } catch (err) {
              logger.warn({ event: 'progress_failed', phase, error: String(err), ...telCtx }, 'Failed to post progress update');
            }
          }
        }
      }
    }
  } catch (err) {
    const elapsed_ms = Math.round(performance.now() - startMs);
    logger.error(
      { event: 'agent.drain_failed', phase, event_count, assistant_turn_count, relay_count, elapsed_ms, error: String(err), ...telCtx },
      'Agent drain failed',
    );
    throw err;
  }

  const elapsed_ms = Math.round(performance.now() - startMs);
  const summary: AgentDrainSummary = {
    event_count,
    assistant_turn_count,
    relay_count,
    tool_call_count,
    tool_result_count,
    elapsed_ms,
    ...(latestDiagnostics ? { diagnostics: latestDiagnostics } : {}),
  };

  logger.info(
    { event: 'agent.drain_completed', phase, ...summary, ...telCtx },
    'Agent drain completed',
  );

  return summary;
}

function assistantContent(event: AgentRunEvent): AgentRunContentBlock[] | undefined {
  if (event.type !== 'assistant') return undefined;
  const content = (event as { content?: unknown }).content;
  return Array.isArray(content) ? content as AgentRunContentBlock[] : undefined;
}

export function parseRelayMessage(content: AgentRunContentBlock[]): string | null {
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      for (const line of block.text.split('\n')) {
        const match = line.match(/^\[Relay\]\s+(.+)$/);
        if (match) return match[1].trim();
      }
    }
  }
  return null;
}

async function readRequiredFile(readFileFn: ReadFileFn, path: string, label: string): Promise<string> {
  try {
    return await readFileFn(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label}: result file not found at "${path}" after agent completed`);
    }
    throw err;
  }
}

interface ValidateResultFileOptions {
  readFileFn: ReadFileFn;
  path: string;
  label: string;
  logger: Pick<pino.Logger, 'info' | 'error'>;
  phase: string;
  route_task: string;
  request_id?: string;
  run_id?: string;
  drainSummary?: AgentDrainSummary;
}

export async function validateRequiredResultFile(options: ValidateResultFileOptions): Promise<string> {
  const { readFileFn, path, label, logger, phase, route_task, request_id, run_id, drainSummary } = options;
  let content: string;
  try {
    content = await readFileFn(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.error(
        {
          event: 'agent.result_file_missing',
          expected_path: path,
          phase,
          route_task,
          ...(request_id ? { request_id } : {}),
          ...(run_id ? { run_id } : {}),
          ...(drainSummary?.diagnostics?.stderr_excerpt_redacted
            ? { stderr_excerpt_redacted: drainSummary.diagnostics.stderr_excerpt_redacted }
            : {}),
        },
        `${label}: result file not found after agent completed`,
      );
      throw new Error(`${label}: result file not found at "${path}" after agent completed`);
    }
    logger.error(
      { event: 'agent.result_file_read_failed', expected_path: path, phase, route_task, error: String(err), ...(request_id ? { request_id } : {}), ...(run_id ? { run_id } : {}) },
      `${label}: failed to read result file`,
    );
    throw err;
  }

  logger.info(
    {
      event: 'agent.result_file_found',
      expected_path: path,
      phase,
      route_task,
      byte_length: content.length,
      ...(request_id ? { request_id } : {}),
      ...(run_id ? { run_id } : {}),
    },
    `${label}: result file found`,
  );
  return content;
}

async function ensureResultDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

function parseArtifactCreateResult(content: string, path: string): ArtifactCreateResult {
  const obj = parseJsonObject(content, `Artifact creation: result file at "${path}"`);
  const artifactPath = typeof obj['artifact_path'] === 'string'
    ? obj['artifact_path']
    : typeof obj['spec_path'] === 'string'
      ? obj['spec_path']
      : undefined;
  if (!artifactPath) {
    throw new Error(`Artifact creation: result file missing "artifact_path" string`);
  }
  return {
    artifact_path: artifactPath,
    existing_issue: typeof obj['existing_issue'] === 'number' ? obj['existing_issue'] : undefined,
  };
}

function parseCommentResponses(content: string, path: string): ArtifactCommentResponse[] {
  const obj = parseJsonObject(content, `Artifact revision: result file at "${path}"`);
  const raw = obj['comment_responses'];
  if (!Array.isArray(raw)) {
    throw new Error(`Artifact revision: result file missing "comment_responses" array`);
  }
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`Artifact revision: comment_responses[${index}] is not an object`);
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry['comment_id'] !== 'string') {
      throw new Error(`Artifact revision: comment_responses[${index}] missing string "comment_id"`);
    }
    if (typeof entry['response'] !== 'string') {
      throw new Error(`Artifact revision: comment_responses[${index}] missing string "response"`);
    }
    return { comment_id: entry['comment_id'], response: entry['response'] };
  });
}

const STATUS_SYNONYMS: Record<string, ImplementationStatus> = {
  done: 'complete',
  finished: 'complete',
  success: 'complete',
  successful: 'complete',
  succeeded: 'complete',
  ok: 'complete',
  okay: 'complete',
  passed: 'complete',
  resolved: 'complete',
  accomplished: 'complete',
  completed: 'complete',
  error: 'failed',
  failure: 'failed',
  err: 'failed',
  crashed: 'failed',
  broken: 'failed',
  unsuccessful: 'failed',
  aborted: 'failed',
  terminated: 'failed',
  exception: 'failed',
  waiting: 'needs_input',
  pending: 'needs_input',
  blocked: 'needs_input',
  needs_information: 'needs_input',
  needs_clarification: 'needs_input',
  requires_input: 'needs_input',
  input_needed: 'needs_input',
  awaiting: 'needs_input',
  paused: 'needs_input',
  stalled: 'needs_input',
  incomplete: 'needs_input',
};

function parseImplementationResult(content: string, path: string): ImplementationResult {
  const obj = parseJsonObject(content, `Implementation: result file at "${path}"`);
  const rawStatus = obj['status'];
  const status = typeof rawStatus === 'string'
    ? (STATUS_SYNONYMS[rawStatus] ?? rawStatus)
    : rawStatus;
  if (status !== 'complete' && status !== 'needs_input' && status !== 'failed') {
    throw new Error(`Implementation: invalid STATUS value "${String(rawStatus)}" in result file`);
  }

  // Parse optional review_summary
  let review_summary: ImplementationResult['review_summary'];
  const rawReviewSummary = obj['review_summary'];
  if (rawReviewSummary !== undefined && rawReviewSummary !== null) {
    if (typeof rawReviewSummary !== 'object') {
      throw new Error(`Implementation: review_summary must be an object`);
    }
    const rs = rawReviewSummary as Record<string, unknown>;
    review_summary = {
      changes: Array.isArray(rs['changes']) ? (rs['changes'] as unknown[]).filter((s): s is string => typeof s === 'string') : [],
      confirm: Array.isArray(rs['confirm']) ? (rs['confirm'] as unknown[]).filter((s): s is string => typeof s === 'string') : [],
    };
  }

  // Parse optional testing_steps
  let testing_steps: string[] | undefined;
  const rawSteps = obj['testing_steps'];
  if (Array.isArray(rawSteps)) {
    testing_steps = (rawSteps as unknown[]).filter((s): s is string => typeof s === 'string');
  }

  // Parse optional resolved_feedback_items
  let resolved_feedback_items: Array<{ id: string; resolution_comment: string }> | undefined;
  const rawResolved = obj['resolved_feedback_items'];
  if (Array.isArray(rawResolved)) {
    resolved_feedback_items = (rawResolved as unknown[]).map((item, index) => {
      if (typeof item !== 'object' || item === null) {
        throw new Error(`Implementation: resolved_feedback_items[${index}] is not an object`);
      }
      const entry = item as Record<string, unknown>;
      if (typeof entry['id'] !== 'string') {
        throw new Error(`Implementation: resolved_feedback_items[${index}] missing string "id"`);
      }
      if (typeof entry['resolution_comment'] !== 'string') {
        throw new Error(`Implementation: resolved_feedback_items[${index}] missing string "resolution_comment"`);
      }
      return { id: entry['id'], resolution_comment: entry['resolution_comment'] };
    });
  }

  // Parse optional review_responses
  let review_responses: ImplementationResult['review_responses'];
  const rawReviewResponses = obj['review_responses'];
  if (Array.isArray(rawReviewResponses)) {
    review_responses = (rawReviewResponses as unknown[]).flatMap((item) => {
      if (typeof item !== 'object' || item === null) return [];
      const entry = item as Record<string, unknown>;
      if (typeof entry['id'] !== 'string' || typeof entry['disposition'] !== 'string' || typeof entry['response'] !== 'string') return [];
      return [{ id: entry['id'], disposition: entry['disposition'] as 'fixed' | 'declined' | 'needs_input', response: entry['response'] }];
    });
  }

  return {
    status,
    summary: typeof obj['summary'] === 'string' ? obj['summary'] : undefined,
    testing_instructions: typeof obj['testing_instructions'] === 'string' ? obj['testing_instructions'] : undefined,
    review_summary,
    testing_steps,
    resolved_feedback_items,
    review_responses,
    requires_human_retest: obj['requires_human_retest'] === true,
    question: typeof obj['question'] === 'string' ? obj['question'] : undefined,
    error: typeof obj['error'] === 'string' ? obj['error'] : undefined,
  };
}

function parseImplementationPlanResult(content: string, path: string): ImplementationPlanResult {
  const obj = parseJsonObject(content, `Implementation planning: result file at "${path}"`);
  const rawStatus = obj['status'];
  const status = typeof rawStatus === 'string'
    ? (STATUS_SYNONYMS[rawStatus] ?? rawStatus)
    : rawStatus;
  if (status !== 'complete' && status !== 'needs_input' && status !== 'failed') {
    throw new Error(`Implementation planning: invalid STATUS value "${String(rawStatus)}" in result file`);
  }
  const planPath = typeof obj['plan_path'] === 'string' ? obj['plan_path'] : undefined;
  if (status === 'complete' && !planPath) {
    throw new Error(`Implementation planning: result file missing "plan_path" string`);
  }
  return {
    status,
    plan_path: planPath,
    question: typeof obj['question'] === 'string' ? obj['question'] : undefined,
    error: typeof obj['error'] === 'string' ? obj['error'] : undefined,
  };
}

function parseQuestionAnswer(content: string): string {
  const obj = parseJsonObject(content, 'Question answering: result file');
  if (typeof obj['answer'] !== 'string') {
    throw new Error(`Question answering: result file missing "answer" string`);
  }
  return obj['answer'];
}

export async function readAndValidateIssueTriageResult(readFileFn: ReadFileFn, filePath: string): Promise<IssueTriageResult> {
  const content = await readRequiredFile(readFileFn, filePath, 'Issue filing');
  return parseAndValidateIssueTriageResult(content, filePath);
}

function parseAndValidateIssueTriageResult(content: string, filePath: string): IssueTriageResult {
  const obj = parseJsonObject(content, `Issue filing: enrichment result at "${filePath}"`);

  if (obj['status'] !== 'complete' && obj['status'] !== 'failed') {
    throw new Error(`Issue filing: enrichment result at "${filePath}" has invalid status: "${String(obj['status'])}"`);
  }
  if (!Array.isArray(obj['items'])) {
    throw new Error(`Issue filing: enrichment result at "${filePath}" missing "items" array`);
  }

  const items: IssueTriageItem[] = obj['items'].map((raw, index) => parseIssueTriageItem(raw, index));
  return {
    status: obj['status'],
    items,
    error: typeof obj['error'] === 'string' ? obj['error'] : undefined,
  };
}

function parseIssueTriageItem(raw: unknown, index: number): IssueTriageItem {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Issue filing: enrichment result items[${index}] is not an object`);
  }
  const item = raw as Record<string, unknown>;

  if (item['duplicate_of'] !== null && item['duplicate_of'] !== undefined) {
    const dup = item['duplicate_of'];
    if (
      typeof dup !== 'object'
      || dup === null
      || typeof (dup as Record<string, unknown>)['number'] !== 'number'
      || typeof (dup as Record<string, unknown>)['title'] !== 'string'
    ) {
      throw new Error(`Issue filing: enrichment result items[${index}].duplicate_of must be null or { number: number, title: string }`);
    }
    return {
      proposed_title: '',
      proposed_body: '',
      proposed_labels: [],
      duplicate_of: {
        number: (dup as Record<string, unknown>)['number'] as number,
        title: (dup as Record<string, unknown>)['title'] as string,
      },
    };
  }

  if (typeof item['proposed_title'] !== 'string' || !item['proposed_title']) {
    throw new Error(`Issue filing: enrichment result items[${index}].proposed_title must be a non-empty string when duplicate_of is null`);
  }
  if (typeof item['proposed_body'] !== 'string' || !item['proposed_body']) {
    throw new Error(`Issue filing: enrichment result items[${index}].proposed_body must be a non-empty string when duplicate_of is null`);
  }
  if (!Array.isArray(item['proposed_labels'])) {
    throw new Error(`Issue filing: enrichment result items[${index}].proposed_labels must be an array when duplicate_of is null`);
  }

  return {
    proposed_title: item['proposed_title'],
    proposed_body: item['proposed_body'],
    proposed_labels: item['proposed_labels'] as string[],
    duplicate_of: null,
  };
}

function parseJsonObject(content: string, label: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${String(err)}`);
  }
  if (typeof data !== 'object' || data === null) {
    throw new Error(`${label} is not a JSON object`);
  }
  return data as Record<string, unknown>;
}

export function buildIssueFilingSummary(filedIssues: FiledIssue[]): string {
  const newIssues = filedIssues.filter(i => i.action === 'filed');
  const duplicates = filedIssues.filter(i => i.action === 'duplicate');
  const parts: string[] = [];

  if (newIssues.length > 0) {
    const list = newIssues.map(i => `#${i.number} ${i.title}`).join(', ');
    parts.push(`Filed ${newIssues.length} new issue${newIssues.length === 1 ? '' : 's'}: ${list}`);
  }

  if (duplicates.length > 0) {
    const list = duplicates.map(i => `#${i.number} ${i.title}`).join(', ');
    parts.push(`Found ${duplicates.length} existing issue${duplicates.length === 1 ? '' : 's'}: ${list}`);
  }

  return parts.length > 0 ? parts.join(' - ') : 'No issues filed (empty list).';
}

const CHECKPOINT_INSTRUCTIONS = `At any point during your work, if you have something worth reporting to the human watching -
a phase transition, your current focus, something interesting you found, or a meaningful
milestone - emit it on its own line using this exact format:

[Relay] <your message here>

The goal is to keep a human informed at intervals they'd find interesting. You decide what's
worth reporting and when.`;

const BRANCH_OWNERSHIP_POLICY = `\
Autocatalyst owns git branch and PR management for this run.
The workspace is already checked out on the correct run branch.
Do not create branches, switch branches, or create worktrees.
Do not push, merge, or open PRs — Autocatalyst handles those steps.
If a skill includes branch setup, worktree creation, push, merge, or PR steps, skip those parts and follow the rest of the skill normally.
All files and commits must stay on the current branch.`;

const MM_PLANNING_BRANCH_OVERRIDE = `\
When using mm:planning, treat its Branch setup section as already complete.
Do not run git checkout -b feat/..., enhancement/..., or fix/....`;

function buildArtifactCreatePrompt(
  request: Request,
  artifactDir: string,
  createResultPath: string,
  intent: 'idea' | 'bug' | 'chore',
): string {
  if (intent === 'bug') {
    return [
      `You are producing a bug triage document for the following report:`,
      ``,
      request.content,
      ``,
      BRANCH_OWNERSHIP_POLICY,
      ``,
      `Use the \`mm:issue-triage\` skill to perform a thorough investigation of this bug.`,
      `Examine relevant source files, recent commits, and related issue-tracker records to understand the`,
      `root cause before forming conclusions. The investigation must be thorough - do not`,
      `skip the codebase inspection step.`,
      ``,
      `When the triage document is complete:`,
      `- Write the triage file to: ${artifactDir}`,
      `  Use "triage-bug-<slug>.md" as the filename.`,
      `- Write the result to: ${createResultPath}`,
      `  Content must be: { "artifact_path": "<absolute path to the triage file you wrote>", "existing_issue": <issue number if this work appears to be captured in an existing issue, otherwise omit the field> }`,
      ``,
      `Do not signal completion until both files have been written.`,
      ``,
      CHECKPOINT_INSTRUCTIONS,
    ].join('\n');
  }

  if (intent === 'chore') {
    return [
      `You are producing a chore plan for the following maintenance request:`,
      ``,
      request.content,
      ``,
      BRANCH_OWNERSHIP_POLICY,
      ``,
      `Use the \`mm:issue-triage\` skill to investigate the current state of the relevant`,
      `code and understand why this work is needed now. Use thorough investigation.`,
      ``,
      `When the chore plan is complete:`,
      `- Write the plan file to: ${artifactDir}`,
      `  Use "triage-chore-<slug>.md" as the filename.`,
      `- Write the result to: ${createResultPath}`,
      `  Content must be: { "artifact_path": "<absolute path to the plan file you wrote>", "existing_issue": <issue number if this work appears to be captured in an existing issue, otherwise omit the field> }`,
      ``,
      `Do not signal completion until both files have been written.`,
      ``,
      CHECKPOINT_INSTRUCTIONS,
    ].join('\n');
  }

  return [
    `Use the \`mm:planning\` skill to create a complete product spec for the following request.`,
    ``,
    BRANCH_OWNERSHIP_POLICY,
    ``,
    MM_PLANNING_BRANCH_OVERRIDE,
    ``,
    `Request:`,
    `<<<`,
    request.content,
    `>>>`,
    ``,
    `When the spec is complete:`,
    `- Write the spec file to: ${artifactDir}`,
    `  Use "feature-<slug>.md" for new standalone functionality, "enhancement-<slug>.md" for improvements.`,
    `- Write the result to: ${createResultPath}`,
    `  Content must be: { "artifact_path": "<absolute path to the spec file you wrote>" }`,
    ``,
    `Do not signal completion until both files have been written.`,
    ``,
    CHECKPOINT_INSTRUCTIONS,
  ].join('\n');
}

function buildArtifactRevisePrompt(
  feedback: ThreadMessage,
  artifact_comments: ArtifactComment[],
  artifact_path: string,
  reviseResultPath: string,
  currentArtifact: string,
  anchorInstructions: string[],
): string {
  const commentSection = artifact_comments.length > 0
    ? [
        ``,
        `Published artifact comments:`,
        `<<<`,
        ...artifact_comments.map(c => `[COMMENT_ID: ${c.id}]\n${c.body}`),
        `>>>`,
      ].join('\n')
    : '';
  const commentResponsesShape = artifact_comments.length > 0
    ? `[{ "comment_id": "<id from [COMMENT_ID:] tag>", "response": "<1-2 sentences explaining how addressed>" }, ...]`
    : `[]`;
  const noCommentNote = artifact_comments.length === 0
    ? [``, `Use an empty array for comment_responses since there are no publisher comments.`]
    : [];
  const anchorInstructionLines = anchorInstructions.length > 0 ? [``, ...anchorInstructions] : [];

  return [
    `Revise the artifact below based on the following feedback.`,
    ``,
    BRANCH_OWNERSHIP_POLICY,
    ``,
    `Write the revised artifact to: ${artifact_path}`,
    `Write the result to: ${reviseResultPath}`,
    `Content must be:`,
    `{`,
    `  "comment_responses": ${commentResponsesShape}`,
    `}`,
    ...noCommentNote,
    `Do not signal completion until the result file has been written.`,
    ...anchorInstructionLines,
    ``,
    `Channel message:`,
    `<<<`,
    feedback.content,
    `>>>`,
    commentSection,
    ``,
    `Current artifact:`,
    `<<<`,
    currentArtifact,
    `>>>`,
    ``,
    CHECKPOINT_INSTRUCTIONS,
  ].join('\n');
}

function buildImplementationPrompt(artifact_path: string, result_file_path: string, additionalContext?: string, planPath?: string): string {
  const lines: string[] = [];
  lines.push(BRANCH_OWNERSHIP_POLICY);
  lines.push('');
  const hasFeedbackContext = Boolean(additionalContext) && additionalContext!.includes('[FEEDBACK_ID:');

  if (additionalContext) {
    lines.push('The working directory already contains partial implementation from a previous attempt.');
    lines.push('Skip Step 1 (the plan exists) - go directly to Step 2.');
    lines.push('');
    if (hasFeedbackContext) {
      lines.push('Implementation feedback from the testing guide (address each item):');
    } else {
      lines.push('Additional context from the human:');
    }
    lines.push('<<<');
    lines.push(additionalContext);
    lines.push('>>>');
    lines.push('');
    if (hasFeedbackContext) {
      lines.push('For each [FEEDBACK_ID: ...] item you address, include it in resolved_feedback_items');
      lines.push('using the exact ID string as provided — do not modify or guess IDs.');
      lines.push('Only include an item in resolved_feedback_items when you actually fixed that specific issue.');
      lines.push('');
    }
  }

  lines.push(`Read the approved artifact at: ${artifact_path}`);
  if (planPath) {
    lines.push(`Read the existing implementation plan at: ${planPath}`);
    lines.push('');
    lines.push('Do not create a new implementation plan. Use the existing plan as the execution checklist.');
  }
  lines.push('');

  if (!additionalContext && !planPath) {
    lines.push('Step 1 - Create an implementation plan');
    lines.push('Use the `superpowers:writing-plans` skill.');
    lines.push('');
    lines.push('Use the artifact as the authoritative baseline, especially its task list.');
    lines.push('');
    lines.push('Step 2 - Execute the plan in subagent mode');
  } else {
    lines.push('Step 2 - Execute the plan in subagent mode');
  }

  lines.push('Use the `superpowers:subagent-driven-development` skill.');
  lines.push('');
  lines.push('Step 3 - Commit all remaining source changes');
  lines.push('Run `git status`. Stage and commit only source files that belong in the repository.');
  lines.push('Never use `git add --force` or `git add -f`.');
  lines.push('Never stage files under `.autocatalyst/` — that directory is gitignored and contains');
  lines.push('internal pipeline state, not repository artifacts.');
  lines.push('');
  lines.push(`Step 4 - Write the result to: ${result_file_path}`);
  lines.push('Create the directory if it does not exist. The JSON must have this structure:');
  lines.push('{');
  lines.push('  "status": "complete" | "needs_input" | "failed",');
  lines.push('  "summary": "short fallback summary",');
  lines.push('  "review_summary": {');
  lines.push('    "changes": ["2-5 bullets describing what changed (user-visible or reviewer-relevant)"],');
  lines.push('    "confirm": ["2-5 bullets describing what the human should verify"]');
  lines.push('  },');
  lines.push('  "testing_instructions": "legacy fallback — use testing_steps instead",');
  lines.push('  "testing_steps": ["cd /path/to/workspace", "npm install", "concrete step 3"],');
  lines.push('  "resolved_feedback_items": [');
  lines.push('    { "id": "<exact FEEDBACK_ID value>", "resolution_comment": "1-2 sentences: what changed" }');
  lines.push('  ],');
  lines.push('  "question": "only when needs_input",');
  lines.push('  "error": "only when failed"');
  lines.push('}');
  lines.push('');
  lines.push('Rules:');
  lines.push('- review_summary.changes and review_summary.confirm must each contain 2-5 bullets when status is "complete".');
  if (hasFeedbackContext) {
    lines.push('- testing_steps should contain only net-new steps introduced by the changes in this feedback cycle.');
    lines.push('  Omit setup steps such as `cd /workspace` and `npm install` that are already in the testing guide baseline.');
    lines.push('  Include a baseline step only if the correct setup command has genuinely changed.');
  } else {
    lines.push('- testing_steps must start with a `cd ` step when a workspace path is available.');
  }
  lines.push('- resolved_feedback_items: include [] on initial implementation; on feedback runs, only include items you actually fixed.');
  lines.push('- Use IDs exactly as provided — do not modify or guess IDs.');
  lines.push('- Use only the exact canonical status values: "complete", "needs_input", or "failed".');
  lines.push('- Do not signal completion until the result file has been written.');
  lines.push('');
  lines.push(CHECKPOINT_INSTRUCTIONS);

  return lines.join('\n');
}

function buildImplementationPlanPrompt(
  artifact_path: string,
  working_directory: string,
  result_file_path: string,
  additional_context?: string,
): string {
  const planDir = join(working_directory, 'docs', 'superpowers', 'plans');
  const lines = [
    BRANCH_OWNERSHIP_POLICY,
    ``,
    `Read the approved artifact at: ${artifact_path}`,
    ``,
    `Create an implementation plan using the \`superpowers:writing-plans\` skill.`,
    `Use the artifact as the authoritative baseline, especially its task list.`,
  ];
  if (additional_context?.trim()) {
    lines.push(
      ``,
      `Additional planning context from the human:`,
      additional_context.trim(),
      ``,
      `Use this context to answer the previous planning question before writing the plan.`,
    );
  }
  lines.push(
    `Save the plan under: ${planDir}`,
    ``,
    `Write the result to: ${result_file_path}`,
    `Create the directory if it does not exist. The JSON must have this structure:`,
    `{`,
    `  "status": "complete" | "needs_input" | "failed",`,
    `  "plan_path": "<absolute path to the plan file when complete>",`,
    `  "question": "only when needs_input",`,
    `  "error": "only when failed"`,
    `}`,
    ``,
    `Rules:`,
    `- Use only the exact canonical status values: "complete", "needs_input", or "failed".`,
    `- When status is "complete", plan_path must point to the plan file you wrote.`,
    `- Do not execute the plan in this session; implementation happens in a separate stage.`,
    `- Do not signal completion until the result file has been written.`,
    ``,
    CHECKPOINT_INSTRUCTIONS,
  );
  return lines.join('\n');
}

function buildQuestionPrompt(question: string, resultPath: string): string {
  return [
    `You are Autocatalyst, an AI-powered product engineering assistant.`,
    ``,
    `Answer the following question. You have access to shell tools - use them as needed.`,
    ``,
    `Question:`,
    question,
    ``,
    `When you have your answer, write it to: ${resultPath}`,
    `Content must be: { "answer": "<your answer as a single string>" }`,
    ``,
    `Keep the answer concise - it will be posted directly to the user.`,
    `Do not signal completion until the result file has been written.`,
  ].join('\n');
}

export function buildIssueTriagePrompt(request: Request, resultPath: string): string {
  return [
    `You are enriching a list of items to be filed in the issue tracker.`,
    ``,
    `Use the \`mm:issue-triage\` skill in feedback intake mode to:`,
    `1. Identify each distinct issue in the list below`,
    `2. Investigate each item against the codebase (thorough mode)`,
    `3. For each item:`,
    `   - If a duplicate issue already exists: record it with duplicate_of set to the existing issue's number and title; omit proposed_title/body/labels`,
    `   - If no duplicate exists: generate a rich title, descriptive body, and appropriate label suggestions; record it with duplicate_of: null`,
    ``,
    `Do NOT create issues. Record enrichment data only - issue creation will be handled separately.`,
    ``,
    `List of items:`,
    `>>>`,
    request.content,
    `>>>`,
    ``,
    `When enrichment is complete, write the result to: ${resultPath}`,
    `Content must be:`,
    `{`,
    `  "status": "complete" | "failed",`,
    `  "items": [`,
    `    {`,
    `      "proposed_title": "...",`,
    `      "proposed_body": "...",`,
    `      "proposed_labels": ["..."],`,
    `      "duplicate_of": null | { "number": N, "title": "..." }`,
    `    }`,
    `  ],`,
    `  "error": "..."`,
    `}`,
    ``,
    `Do not signal completion until the result file has been written.`,
    ``,
    CHECKPOINT_INSTRUCTIONS,
  ].join('\n');
}

export function buildInitialReviewPrompt(
  artifact_path: string,
  working_directory: string,
  impl_result: ImplementationResult,
  diff_context: string,
  changed_files: string[],
): string {
  const reviewResultPath = join(working_directory, '.autocatalyst', 'impl-review-result.json');
  const summaryLines = [
    impl_result.summary ? `Summary: ${impl_result.summary}` : '',
    impl_result.review_summary?.changes?.length
      ? `Changes:\n${impl_result.review_summary.changes.map(c => `- ${c}`).join('\n')}`
      : '',
    impl_result.review_summary?.confirm?.length
      ? `Confirm:\n${impl_result.review_summary.confirm.map(c => `- ${c}`).join('\n')}`
      : '',
    impl_result.testing_instructions ? `Testing instructions: ${impl_result.testing_instructions}` : '',
  ].filter(Boolean);

  return [
    `You are an adversarial code reviewer. Your job is to inspect the implementation and find issues.`,
    `Do NOT edit any files. Read only.`,
    ``,
    `Approved artifact (spec): ${artifact_path}`,
    ``,
    `Implementation description from implementer:`,
    `<<<`,
    summaryLines.join('\n\n'),
    `>>>`,
    ``,
    `Changed files:`,
    ...changed_files.map(f => `- ${f}`),
    ``,
    `Git diff:`,
    `<<<`,
    diff_context || '(no diff available)',
    `>>>`,
    ``,
    `Review categories for initial review: correctness, test, security, maintainability, docs.`,
    `Focus on: correctness issues, missing test coverage, security problems, unmaintainable code, missing docs.`,
    ``,
    `Write your result to: ${reviewResultPath}`,
    `Content must be:`,
    `{`,
    `  "status": "no_findings" | "findings" | "failed",`,
    `  "summary": "1-2 sentence summary of review outcome",`,
    `  "findings": [`,
    `    {`,
    `      "id": "INIT-1",`,
    `      "severity": "blocker" | "warning" | "info",`,
    `      "category": "correctness" | "test" | "security" | "maintainability" | "docs",`,
    `      "finding": "concise description",`,
    `      "suggested_action": "optional action"`,
    `    }`,
    `  ],`,
    `  "requires_human_retest": false,`,
    `  "error": "only when status is failed"`,
    `}`,
    ``,
    `Rules:`,
    `- Do NOT include secrets, API keys, env values, or raw credential values in findings.`,
    `- Do NOT include your reasoning chain or full prompt in findings.`,
    `- Do NOT edit any files in the workspace.`,
    `- Use sequential IDs: INIT-1, INIT-2, etc.`,
    `- If no issues found, use status: "no_findings" with empty findings array.`,
    `- Do not signal completion until the result file has been written.`,
    ``,
    CHECKPOINT_INSTRUCTIONS,
  ].join('\n');
}

export function buildFinalReviewPrompt(
  artifact_path: string,
  working_directory: string,
  impl_result: ImplementationResult,
  diff_context: string,
  changed_files: string[],
): string {
  const reviewResultPath = join(working_directory, '.autocatalyst', 'impl-review-result.json');
  const summaryLines = [
    impl_result.summary ? `Summary: ${impl_result.summary}` : '',
    impl_result.review_summary?.changes?.length
      ? `Changes:\n${impl_result.review_summary.changes.map(c => `- ${c}`).join('\n')}`
      : '',
  ].filter(Boolean);

  return [
    `You are an adversarial code reviewer performing a final pre-PR security and readiness check.`,
    `Do NOT edit any files. Read only.`,
    ``,
    `Approved artifact (spec): ${artifact_path}`,
    ``,
    `Implementation description from implementer:`,
    `<<<`,
    summaryLines.join('\n\n'),
    `>>>`,
    ``,
    `Changed files:`,
    ...changed_files.map(f => `- ${f}`),
    ``,
    `Git diff:`,
    `<<<`,
    diff_context || '(no diff available)',
    `>>>`,
    ``,
    `FOCUS for final review: security and pr_readiness.`,
    `Only include correctness, maintainability, test, or docs findings if the issue is newly discovered`,
    `and serious enough to block or delay the PR.`,
    ``,
    `Write your result to: ${reviewResultPath}`,
    `Content must be:`,
    `{`,
    `  "status": "no_findings" | "findings" | "failed",`,
    `  "summary": "1-2 sentence summary",`,
    `  "findings": [`,
    `    {`,
    `      "id": "FINAL-1",`,
    `      "severity": "blocker" | "warning" | "info",`,
    `      "category": "security" | "pr_readiness" | "correctness" | "test" | "maintainability" | "docs",`,
    `      "finding": "concise description",`,
    `      "suggested_action": "optional action"`,
    `    }`,
    `  ],`,
    `  "requires_human_retest": false,`,
    `  "error": "only when status is failed"`,
    `}`,
    ``,
    `Rules:`,
    `- Do NOT include secrets, API keys, env values, or raw credential values.`,
    `- Do NOT edit any files.`,
    `- Use sequential IDs: FINAL-1, FINAL-2, etc.`,
    `- Do not signal completion until the result file has been written.`,
    ``,
    CHECKPOINT_INSTRUCTIONS,
  ].join('\n');
}

export function buildImplementerResponsePrompt(
  artifact_path: string,
  working_directory: string,
  impl_result: ImplementationResult,
  findings: ImplementationReviewFinding[],
): string {
  const resultFilePath = join(working_directory, '.autocatalyst', 'impl-result.json');

  const findingBlocks = findings.map(f => [
    `[REVIEW_ID: ${f.id}]`,
    `Severity: ${f.severity}`,
    `Category: ${f.category}`,
    `Finding: ${f.finding}`,
    ...(f.suggested_action ? [`Suggested action: ${f.suggested_action}`] : []),
  ].join('\n'));

  return [
    `Review findings require your response.`,
    ``,
    BRANCH_OWNERSHIP_POLICY,
    ``,
    `Read the approved artifact at: ${artifact_path}`,
    ``,
    `Previous implementation summary: ${impl_result.summary ?? '(none)'}`,
    ``,
    `Review findings:`,
    ``,
    findingBlocks.join('\n\n'),
    ``,
    `For each [REVIEW_ID: ...] finding, either fix it or decline it with a concrete reason.`,
    ``,
    `Step 1 - Respond to each finding.`,
    `For blockers: fix the issue in code/tests/docs, or escalate to needs_input with a specific question.`,
    `For warnings/info: fix, or decline with a concrete reason (not "no action needed").`,
    ``,
    `Step 2 - Commit any changes.`,
    ``,
    `Step 3 - Write the result to: ${resultFilePath}`,
    `Content must be:`,
    `{`,
    `  "status": "complete" | "needs_input" | "failed",`,
    `  "summary": "updated summary",`,
    `  "review_summary": { "changes": [...], "confirm": [...] },`,
    `  "testing_steps": [...],`,
    `  "resolved_feedback_items": [],`,
    `  "review_responses": [`,
    `    {`,
    `      "id": "<exact REVIEW_ID value>",`,
    `      "disposition": "fixed" | "declined" | "needs_input",`,
    `      "response": "what changed or concrete reason for decline"`,
    `    }`,
    `  ],`,
    `  "requires_human_retest": false`,
    `}`,
    ``,
    `Rules:`,
    `- Include one review_responses entry per [REVIEW_ID:] finding.`,
    `- "declined" responses must include a concrete reason, not just "no action needed".`,
    `- "fixed" responses should mention changed files or behavior.`,
    `- Use exact ID strings — do not modify or guess IDs.`,
    `- requires_human_retest: set true only if you changed user-visible behavior or testing steps.`,
    `- Do not signal completion until the result file has been written.`,
    ``,
    CHECKPOINT_INSTRUCTIONS,
  ].join('\n');
}

export function parseImplementationReviewResult(content: string, path: string): ImplementationReviewResult {
  let obj: Record<string, unknown>;
  try {
    const data = JSON.parse(content);
    if (typeof data !== 'object' || data === null) {
      return { status: 'failed', summary: '', findings: [], error: `Review result at "${path}" is not a JSON object` };
    }
    obj = data as Record<string, unknown>;
  } catch (err) {
    return { status: 'failed', summary: '', findings: [], error: `Review result at "${path}" is not valid JSON: ${String(err)}` };
  }

  const rawStatus = obj['status'];
  if (rawStatus !== 'no_findings' && rawStatus !== 'findings' && rawStatus !== 'failed') {
    return { status: 'failed', summary: '', findings: [], error: `Review result at "${path}" has invalid status: "${String(rawStatus)}"` };
  }

  const findings: ImplementationReviewFinding[] = [];
  if (Array.isArray(obj['findings'])) {
    for (const raw of obj['findings'] as unknown[]) {
      if (typeof raw !== 'object' || raw === null) continue;
      const f = raw as Record<string, unknown>;
      if (typeof f['id'] === 'string' && typeof f['severity'] === 'string' && typeof f['category'] === 'string' && typeof f['finding'] === 'string') {
        findings.push({
          id: f['id'],
          severity: f['severity'] as ImplementationReviewFinding['severity'],
          category: f['category'] as ImplementationReviewFinding['category'],
          finding: f['finding'],
          ...(typeof f['suggested_action'] === 'string' ? { suggested_action: f['suggested_action'] } : {}),
        });
      }
    }
  }

  return {
    status: rawStatus,
    summary: typeof obj['summary'] === 'string' ? obj['summary'] : '',
    findings,
    requires_human_retest: obj['requires_human_retest'] === true,
    ...(typeof obj['error'] === 'string' ? { error: obj['error'] } : {}),
  };
}
