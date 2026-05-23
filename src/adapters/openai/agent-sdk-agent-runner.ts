import { run as _run, OpenAIResponsesModel, setTracingDisabled, type Agent } from '@openai/agents';
import { SandboxAgent, type Capability, filesystem, shell, compaction } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient, type UnixLocalSandboxSessionState } from '@openai/agents/sandbox/local';
import { Manifest } from '@openai/agents/sandbox';
import OpenAI from 'openai';
import type pino from 'pino';
import type { LoggerProvider } from '@opentelemetry/api-logs';
import { performance } from 'node:perf_hooks';
import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram, Meter } from '@opentelemetry/api';
import type { AgentRunEvent, AgentRunRequest, AgentRunner, AgentRoute, AgentSkillRef } from '../../types/ai.js';
import { createLogger } from '../../core/logger.js';
import { materializeOpenAIRuntimeSkills } from './openai-runtime-skill-materializer.js';
import { buildSandboxEnvironment } from '../sandbox-environment.js';
import { startAnthropicBetaHeaderFilterProxy, type AnthropicBetaHeaderFilterProxy, type RequestLogOptions } from '../anthropic/anthropic-beta-header-filter-proxy.js';

const DEFAULT_OPENAI_AGENT_MAX_TURNS = 50;

interface RunFnOptions {
  maxTurns: number;
  environment: Record<string, string>;
}

type RunFn = (
  agent: unknown,
  prompt: string,
  workingDirectory: string,
  options: RunFnOptions,
) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

export interface OpenAIAgentSdkAgentRunnerOptions {
  runFn?: RunFn;
  materializeSkills?: (refs: AgentSkillRef[]) => Promise<unknown[]>;
  meter?: Meter;
  logDestination?: pino.DestinationStream;
  loggerProvider?: LoggerProvider;
  maxTurns?: number;
  sandboxEnvTokens?: string[];
  requestLog?: RequestLogOptions;
  startProxy?: typeof startAnthropicBetaHeaderFilterProxy;
}

export function skillRefsForRoute(route: AgentRoute): AgentSkillRef[] {
  if (route.task === 'implementation.plan') {
    return ['superpowers:writing-plans'];
  }
  if (route.task === 'implementation.run') {
    return ['superpowers:subagent-driven-development'];
  }
  if (route.task === 'issue.triage') {
    return ['mm:issue-triage'];
  }
  if (route.task === 'artifact.create') {
    if (route.intent === 'idea') return ['mm:planning'];
    if (route.intent === 'bug' || route.intent === 'chore') return ['mm:issue-triage'];
  }
  return [];
}

export class OpenAIAgentSdkAgentRunner implements AgentRunner {
  private readonly runFn: RunFn;
  private readonly materializeSkillsFn: (refs: AgentSkillRef[]) => Promise<unknown[]>;
  private readonly _agentTurns: Counter;
  private readonly _adapterLatency: Histogram;
  private readonly _agentRunOutcome: Counter;
  private readonly logger: pino.Logger;
  private readonly maxTurns: number;
  private readonly sandboxEnvTokens: string[];
  private readonly requestLog: RequestLogOptions | undefined;
  private readonly startProxy: typeof startAnthropicBetaHeaderFilterProxy;
  private _proxy: Promise<AnthropicBetaHeaderFilterProxy> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string | undefined,
    private readonly defaultModel: string | undefined,
    options?: OpenAIAgentSdkAgentRunnerOptions,
  ) {
    setTracingDisabled(true);
    this.runFn = options?.runFn ?? defaultRunFn;
    this.materializeSkillsFn = options?.materializeSkills ?? materializeOpenAIRuntimeSkills;
    this.logger = createLogger('openai-agent-sdk', {
      destination: options?.logDestination,
      loggerProvider: options?.loggerProvider,
    });
    this.maxTurns = options?.maxTurns ?? DEFAULT_OPENAI_AGENT_MAX_TURNS;
    this.sandboxEnvTokens = options?.sandboxEnvTokens ?? [];
    this.requestLog = options?.requestLog;
    this.startProxy = options?.startProxy ?? startAnthropicBetaHeaderFilterProxy;
    const meter = options?.meter ?? metrics.getMeter('autocatalyst');
    this._agentTurns = meter.createCounter('autocatalyst.agent.turns', {
      unit: '{turn}',
      description: 'Agent turns yielded',
    });
    this._adapterLatency = meter.createHistogram('autocatalyst.adapter.latency', {
      unit: 'ms',
      description: 'Latency of adapter operations',
    });
    this._agentRunOutcome = meter.createCounter('autocatalyst.agent.runs', {
      unit: '{run}',
      description: 'Agent runs completed, by outcome',
    });
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentRunEvent> {
    const model = request.profile?.model ?? this.defaultModel ?? 'gpt-4o';
    const refs = skillRefsForRoute(request.route);
    const skillCapabilities = await this.materializeSkillsFn(refs);
    const capabilities: Capability[] = [
      filesystem(),
      shell(),
      compaction(),
      ...(skillCapabilities as Capability[]),
    ];

    // For Grove/Azure APIM: create a configured OpenAI client with api-key header and wrap it
    // in OpenAIResponsesModel so the custom base URL is applied to every agent HTTP request.
    // Route through the loopback proxy so all requests can be logged/filtered.
    // For standard OpenAI endpoints: pass the model string and let the SDK use its default client.
    let agentModel: string | OpenAIResponsesModel;
    const proxyUrl = await this.proxyBaseUrl();
    if (proxyUrl) {
      const client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: proxyUrl,
        defaultHeaders: { 'api-key': this.apiKey },
      });
      // Cast required: resolution-mode difference between our OpenAI import and @openai/agents-openai's import
      agentModel = new OpenAIResponsesModel(client as never, model);
    } else {
      agentModel = model;
    }

    const baseInstructions = [
      'You are an AI agent for software development automation.',
      'Work in the provided working directory.',
      request.working_directory ? `Working directory: ${request.working_directory}` : '',
    ].filter(Boolean).join('\n');

    const agent = new SandboxAgent({
      name: 'autocatalyst-agent',
      model: agentModel,
      instructions: baseInstructions,
      capabilities,
    });

    const sandboxEnv = buildSandboxEnvironment(this.sandboxEnvTokens);

    if (isGitHubDependentRoute(request.route) && !sandboxEnv['GH_TOKEN'] && !sandboxEnv['GITHUB_TOKEN']) {
      this.logger.warn(
        {
          event: 'sandbox.no_github_token',
          route_task: request.route.task,
        },
        `Sandbox route ${request.route.task} requires GitHub CLI authentication. Add AC_GH_TOKEN to sandbox.env_tokens in autocatalyst.yaml and set AC_GH_TOKEN before starting Autocatalyst.`,
      );
    }

    const startMs = performance.now();
    let outcome: 'success' | 'error' = 'success';
    const telemetry = request.telemetry ?? {};

    this.logger.info(
      {
        event: 'agent.run_started',
        model,
        ...routeLogAttributes(request.route),
        working_directory: request.working_directory,
        skill_refs: refs,
        capability_types: capabilities.map(c => c.type),
        max_turns: this.maxTurns,
        ...(telemetry.run_id ? { run_id: telemetry.run_id } : {}),
        ...(telemetry.request_id ? { request_id: telemetry.request_id } : {}),
        ...(telemetry.phase ? { phase: telemetry.phase } : {}),
      },
      'OpenAI Agents SDK run started',
    );

    let pendingToolCallCount = 0;
    let pendingToolResultCount = 0;
    try {
      const stream = await Promise.resolve(this.runFn(agent, request.prompt, request.working_directory, { maxTurns: this.maxTurns, environment: sandboxEnv }));
      for await (const event of stream) {
        const diag = openAIEventDiagnostic(event);
        this.logger.debug(
          {
            event: 'agent.sdk_item',
            model,
            ...routeLogAttributes(request.route),
            ...diag,
            ...(telemetry.run_id ? { run_id: telemetry.run_id } : {}),
            ...(telemetry.request_id ? { request_id: telemetry.request_id } : {}),
            ...(telemetry.phase ? { phase: telemetry.phase } : {}),
          },
          'OpenAI Agents SDK item',
        );
        // Accumulate tool counts from individual tool call/result events
        const itemType = diag['item_type'];
        if (itemType === 'tool_call_item') pendingToolCallCount++;
        else if (itemType === 'tool_call_output_item') pendingToolResultCount++;
        const normalized = normalizeOpenAIEvent(event);
        if (normalized) {
          if (normalized.type === 'assistant') {
            this._agentTurns.add(1, { component: 'openai-agent-sdk', model });
            const diagExtras: Record<string, unknown> = {};
            if (pendingToolCallCount > 0) {
              diagExtras['tool_call_count'] = pendingToolCallCount;
              pendingToolCallCount = 0;
            }
            if (pendingToolResultCount > 0) {
              diagExtras['tool_result_count'] = pendingToolResultCount;
              pendingToolResultCount = 0;
            }
            if (Object.keys(diagExtras).length > 0) {
              yield { ...normalized, ...diagExtras } as AgentRunEvent;
            } else {
              yield normalized;
            }
          } else {
            yield normalized;
          }
        }
      }
    } catch (err) {
      outcome = 'error';
      this.logger.error(
        {
          event: 'agent.run_failed',
          model,
          ...routeLogAttributes(request.route),
          error: String(err),
          generated_item_count: generatedItemsFromError(err).length,
          ...(telemetry.run_id ? { run_id: telemetry.run_id } : {}),
          ...(telemetry.request_id ? { request_id: telemetry.request_id } : {}),
          ...(telemetry.phase ? { phase: telemetry.phase } : {}),
        },
        'OpenAI Agents SDK run failed',
      );
      throw err;
    } finally {
      this._agentRunOutcome.add(1, { component: 'openai-agent-sdk', model, outcome });
      this._adapterLatency.record(performance.now() - startMs, {
        adapter: 'agent-sdk',
        operation: 'run',
        model,
      });
      this.logger.info(
        {
          event: 'agent.run_completed',
          model,
          ...routeLogAttributes(request.route),
          outcome,
          latency_ms: Math.round(performance.now() - startMs),
          ...(pendingToolCallCount > 0 ? { trailing_tool_call_count: pendingToolCallCount } : {}),
          ...(pendingToolResultCount > 0 ? { trailing_tool_result_count: pendingToolResultCount } : {}),
          ...(telemetry.run_id ? { run_id: telemetry.run_id } : {}),
          ...(telemetry.request_id ? { request_id: telemetry.request_id } : {}),
          ...(telemetry.phase ? { phase: telemetry.phase } : {}),
        },
        'OpenAI Agents SDK run completed',
      );
    }
  }

  private async proxyBaseUrl(): Promise<string | null> {
    if (!this.baseUrl) return null;
    if (!this._proxy) {
      const pending = this.startProxy(this.baseUrl, {
        stripBetaValues: [],
        ...(this.requestLog ? { requestLog: this.requestLog } : {}),
      });
      this._proxy = pending;
      pending.catch(() => {
        if (this._proxy === pending) {
          this._proxy = null;
        }
      });
    }
    const proxy = await this._proxy;
    return proxy.baseUrl;
  }

  async close(): Promise<void> {
    if (this._proxy) {
      try {
        const proxy = await this._proxy;
        await proxy.close();
      } catch {
        // proxy never started successfully — nothing to close
      }
      this._proxy = null;
    }
  }
}

async function* defaultRunFn(
  agent: unknown,
  prompt: string,
  workingDirectory: string,
  options: RunFnOptions,
): AsyncIterable<unknown> {
  const client = new UnixLocalSandboxClient();
  const state: UnixLocalSandboxSessionState = {
    manifest: new Manifest(),
    workspaceRootPath: workingDirectory,
    workspaceRootOwned: false,
    environment: options.environment,
  };
  const session = await client.resume(state);
  const sandbox = { client, session };
  try {
    const result = await _run(agent as Agent, prompt, { sandbox, maxTurns: options.maxTurns });
    yield* openAIEventsFromRunItems(runItemsFromResult(result));
  } catch (err) {
    yield* openAIEventsFromRunItems(generatedItemsFromError(err));
    throw err;
  }
}

function* openAIEventsFromRunItems(items: unknown[]): Iterable<unknown> {
  for (const item of items) {
    const name = openAIEventNameForRunItem(item);
    yield { type: 'run_item_stream_event', name: name ?? 'unknown_item', item };
  }
}

function runItemsFromResult(result: unknown): unknown[] {
  if (!result || typeof result !== 'object') return [];
  const newItems = (result as { newItems?: unknown }).newItems;
  return Array.isArray(newItems) ? newItems : [];
}

function generatedItemsFromError(err: unknown): unknown[] {
  if (!err || typeof err !== 'object') return [];
  const state = (err as { state?: unknown }).state;
  if (!state || typeof state !== 'object') return [];
  const generatedItems = (state as { _generatedItems?: unknown })._generatedItems;
  return Array.isArray(generatedItems) ? generatedItems : [];
}

function openAIEventNameForRunItem(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  switch ((item as { type?: string }).type) {
    case 'message_output_item': return 'message_output_created';
    case 'handoff_call_item': return 'handoff_requested';
    case 'handoff_output_item': return 'handoff_occurred';
    case 'tool_search_call_item': return 'tool_search_called';
    case 'tool_search_output_item': return 'tool_search_output_created';
    case 'tool_call_item': return 'tool_called';
    case 'tool_call_output_item': return 'tool_output';
    case 'reasoning_item': return 'reasoning_item_created';
    case 'tool_approval_item': return 'tool_approval_requested';
    default: return undefined;
  }
}

function normalizeOpenAIEvent(event: unknown): AgentRunEvent | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as Record<string, unknown>;

  // RunItemStreamEvent with name 'message_output_created' carries model text output.
  // item.type === 'message_output_item', item.rawItem.content has { type: 'output_text', text }
  if (e['type'] === 'run_item_stream_event' && e['name'] === 'message_output_created') {
    const text = extractTextFromMessageOutputItem(e['item']);
    if (text !== null) {
      return { type: 'assistant', content: [{ type: 'text', text }] };
    }
  }

  if (typeof e['type'] === 'string') {
    return { type: e['type'], ...e } as AgentRunEvent;
  }
  return null;
}

function isGitHubDependentRoute(route: AgentRoute): boolean {
  if (route.task === 'issue.triage') return true;
  if (route.task === 'artifact.create' && (route.intent === 'bug' || route.intent === 'chore')) return true;
  return false;
}

function routeLogAttributes(route: AgentRoute): Record<string, string> {
  return {
    route_task: route.task,
    ...(route.stage ? { route_stage: route.stage } : {}),
    ...(route.intent ? { route_intent: route.intent } : {}),
    ...(route.artifact_kind ? { artifact_kind: route.artifact_kind } : {}),
  };
}

function openAIEventDiagnostic(event: unknown): Record<string, unknown> {
  if (!event || typeof event !== 'object') {
    return { sdk_event_type: typeof event };
  }
  const e = event as Record<string, unknown>;
  const item = e['item'];
  const itemRecord = item && typeof item === 'object' ? item as Record<string, unknown> : undefined;
  const rawItem = itemRecord?.['rawItem'];
  const rawRecord = rawItem && typeof rawItem === 'object' ? rawItem as Record<string, unknown> : undefined;

  return withoutUndefined({
    sdk_event_type: typeof e['type'] === 'string' ? e['type'] : undefined,
    sdk_event_name: typeof e['name'] === 'string' ? e['name'] : undefined,
    item_type: typeof itemRecord?.['type'] === 'string' ? itemRecord['type'] : undefined,
    raw_item_type: rawItemType(rawRecord),
    ...toolDiagnostic(rawRecord, itemRecord),
  });
}

function rawItemType(rawItem: Record<string, unknown> | undefined): string | undefined {
  if (!rawItem) return undefined;
  if (typeof rawItem['type'] === 'string') return rawItem['type'];
  if (typeof rawItem['role'] === 'string') return rawItem['role'];
  return undefined;
}

function toolDiagnostic(
  rawItem: Record<string, unknown> | undefined,
  item: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!rawItem) return {};
  const type = rawItemType(rawItem);
  const callId = stringValue(rawItem['callId']) ?? stringValue(rawItem['call_id']);
  const status = stringValue(rawItem['status']);

  switch (type) {
    case 'function_call':
      return {
        tool_name: stringValue(rawItem['name']),
        call_id: callId,
        tool_status: status,
      };
    case 'function_call_result':
      return {
        tool_name: stringValue(rawItem['name']),
        call_id: callId,
        tool_status: status,
        output_type: outputType(rawItem['output']),
      };
    case 'hosted_tool_call':
      return {
        tool_name: stringValue(rawItem['name']),
        call_id: callId,
        tool_status: status,
      };
    case 'shell_call':
      return {
        tool_name: 'shell',
        call_id: callId,
        tool_status: status,
        command_count: shellCommandCount(rawItem['action']),
      };
    case 'shell_call_output':
      return {
        tool_name: 'shell',
        call_id: callId,
        output_count: shellOutput(rawItem['output']).length,
        exit_codes: shellOutput(rawItem['output'])
          .map(output => shellExitCode(output))
          .filter((code): code is number => typeof code === 'number'),
      };
    case 'apply_patch_call':
      return {
        tool_name: 'apply_patch',
        call_id: callId,
        tool_status: status,
        patch_operation: patchOperation(rawItem['operation']),
      };
    case 'apply_patch_call_output':
      return {
        tool_name: 'apply_patch',
        call_id: callId,
        tool_status: status,
        output_length: typeof rawItem['output'] === 'string' ? rawItem['output'].length : undefined,
      };
    case 'computer_call':
      return {
        tool_name: 'computer',
        call_id: callId,
        tool_status: status,
        action_type: computerActionType(rawItem['action']),
      };
    case 'computer_call_result':
      return {
        tool_name: 'computer',
        call_id: callId,
      };
    case 'tool_search_call':
      return {
        tool_name: 'tool_search',
        call_id: callId,
        tool_status: status,
      };
    case 'tool_search_output':
      return {
        tool_name: 'tool_search',
        call_id: callId,
        tool_status: status,
        output_count: Array.isArray(rawItem['tools']) ? rawItem['tools'].length : undefined,
      };
    default:
      return {
        call_id: callId,
        tool_status: status,
        output_type: outputType(item?.['output']),
      };
  }
}

function shellCommandCount(action: unknown): number | undefined {
  if (!action || typeof action !== 'object') return undefined;
  const commands = (action as { commands?: unknown }).commands;
  return Array.isArray(commands) ? commands.length : undefined;
}

function shellOutput(output: unknown): Array<Record<string, unknown>> {
  return Array.isArray(output)
    ? output.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : [];
}

function shellExitCode(output: Record<string, unknown>): number | undefined {
  const outcome = output['outcome'];
  if (!outcome || typeof outcome !== 'object') return undefined;
  const exitCode = (outcome as { exitCode?: unknown }).exitCode;
  return typeof exitCode === 'number' ? exitCode : undefined;
}

function patchOperation(operation: unknown): string | undefined {
  if (!operation || typeof operation !== 'object') return undefined;
  return stringValue((operation as { type?: unknown }).type);
}

function computerActionType(action: unknown): string | undefined {
  if (!action || typeof action !== 'object') return undefined;
  return stringValue((action as { type?: unknown }).type);
}

function outputType(output: unknown): string | undefined {
  if (typeof output === 'string') return 'string';
  if (Array.isArray(output)) return 'array';
  if (!output || typeof output !== 'object') return undefined;
  return stringValue((output as { type?: unknown }).type) ?? 'object';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function withoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function extractTextFromMessageOutputItem(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const i = item as Record<string, unknown>;
  const rawItem = i['rawItem'] as Record<string, unknown> | undefined;
  if (!rawItem) return null;
  const content = rawItem['content'];
  if (!Array.isArray(content)) return null;
  const textBlock = (content as Record<string, unknown>[]).find(b => b['type'] === 'output_text');
  if (textBlock && typeof textBlock['text'] === 'string') return textBlock['text'];
  return null;
}
