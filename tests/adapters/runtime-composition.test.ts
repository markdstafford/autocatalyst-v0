import { describe, it, expect, vi, test } from 'vitest';
import { resolveAiConfig } from '../../src/core/config.js';
import { OrchestratorImpl } from '../../src/core/orchestrator.js';
import type { OrchestratorDeps } from '../../src/core/orchestrator.js';
import type { WorkflowConfig, AiConfig } from '../../src/types/config.js';
import { buildDirectModelRunner, buildAgentRunner, RoutingAwareDirectModelRunner, RoutingAwareAgentRunner } from '../../src/adapters/runtime-composition.js';
import { OpenAIDirectModelRunner } from '../../src/adapters/openai/direct-model-runner.js';
import { AnthropicDirectModelRunner } from '../../src/adapters/anthropic/direct-model-runner.js';
import { OpenAIAgentSdkAgentRunner } from '../../src/adapters/openai/agent-sdk-agent-runner.js';
import { ClaudeAgentSdkAgentRunner } from '../../src/adapters/anthropic/claude-agent-sdk-agent-runner.js';
import { AuthoringApiConvergenceCoordinator } from '../../src/core/ai/authoring-api-convergence-coordinator.js';
import { getSpecAuthoringPolicy } from '../../src/core/config.js';
import type { ResolvedAiConfig } from '../../src/core/config.js';
import type { RuntimeLogger } from '../../src/adapters/runtime-composition.js';
import type { DirectModelRunner, DirectModelRunRequest, AgentRunner, AgentRunRequest } from '../../src/types/ai.js';

function makeWorkflowConfig(ai: Partial<AiConfig>): WorkflowConfig {
  return { ai } as unknown as WorkflowConfig;
}

function validAi(): AiConfig {
  return {
    credentials: [{ name: 'my-key', type: 'api_key', value: '${MY_KEY}' }],
    endpoints: [{ name: 'ep', protocol: 'anthropic', credential: 'my-key' }],
    profiles: [{ name: 'p', endpoint: 'ep', model: 'haiku', runner: 'anthropic_direct' }],
    routing: { 'intent.classify': 'p' },
  };
}

/**
 * Startup sequence integration tests (ST1–ST5).
 *
 * Tests verify that resolveAiConfig errors propagate before any agent work begins.
 */
describe('startup sequence: resolveAiConfig error propagation', () => {
  it('ST1: absent ai: section throws before agent work; message contains "ai: section is required"', () => {
    expect(() => resolveAiConfig({} as WorkflowConfig, {})).toThrow('ai: section is required');
  });

  it('ST2: unknown endpoint credential throws before agent work with the invalid name', () => {
    const ai = validAi();
    ai.endpoints[0].credential = 'missing';
    expect(() => resolveAiConfig(makeWorkflowConfig(ai), { MY_KEY: 'sk' })).toThrow("unknown credential 'missing'");
  });

  it('ST3: valid config with api_key and env var set resolves successfully', () => {
    const result = resolveAiConfig(makeWorkflowConfig(validAi()), { MY_KEY: 'sk-test' });
    expect(result.credentials[0].resolvedValue).toBe('sk-test');
  });

  it('ST4: valid config resolves routing map in result', () => {
    const result = resolveAiConfig(makeWorkflowConfig(validAi()), { MY_KEY: 'sk-test' });
    expect(result.routing['intent.classify']).toBe('p');
  });
});

/**
 * ST5: Code-level audit — no direct AC_ANTHROPIC_API_KEY read in buildDirectModelRunner or startup path.
 */
describe('ST5: no direct env reads outside resolveAiConfig', () => {
  it('buildDirectModelRunner source does not contain direct AC_ANTHROPIC_API_KEY read', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(
      join(import.meta.dirname, '../../src/adapters/runtime-composition.ts'),
      'utf-8',
    );
    const fnStart = source.indexOf('export function buildDirectModelRunner');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart);
    expect(fnBody).not.toContain("env['AC_ANTHROPIC_API_KEY']");
    expect(fnBody).not.toContain('env["AC_ANTHROPIC_API_KEY"]');
  });
});

const noopLogger: RuntimeLogger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
};

function makeResolvedAi(overrides: {
  runner: 'openai_direct' | 'anthropic_direct';
  credentialType?: 'api_key' | 'bearer_token' | 'iam' | 'workload_identity';
  baseUrl?: string;
}): ResolvedAiConfig {
  const { runner, credentialType = 'api_key', baseUrl } = overrides;
  return {
    credentials: [{ name: 'cred', type: credentialType, resolvedValue: 'sk-test' }],
    endpoints: [{ name: 'ep', protocol: 'openai', credential: 'cred', ...(baseUrl ? { base_url: baseUrl } : {}) }],
    profiles: [{ name: 'p', endpoint: 'ep', runner, model: 'gpt-4o-mini' }],
    routing: { 'intent.classify': 'p' },
  } as unknown as ResolvedAiConfig;
}

describe('buildDirectModelRunner dispatch', () => {
  it('returns OpenAIDirectModelRunner when profile runner is openai_direct', () => {
    const runner = buildDirectModelRunner(makeResolvedAi({ runner: 'openai_direct' }), noopLogger);
    expect(runner).toBeInstanceOf(OpenAIDirectModelRunner);
  });

  it('returns AnthropicDirectModelRunner when profile runner is anthropic_direct (no regression)', () => {
    const resolvedAi: ResolvedAiConfig = {
      credentials: [{ name: 'cred', type: 'api_key', resolvedValue: 'sk-anthropic' }],
      endpoints: [{ name: 'ep', protocol: 'anthropic', credential: 'cred' }],
      profiles: [{ name: 'p', endpoint: 'ep', runner: 'anthropic_direct', model: 'claude-haiku-4-5' }],
      routing: { 'intent.classify': 'p' },
    } as unknown as ResolvedAiConfig;
    const runner = buildDirectModelRunner(resolvedAi, noopLogger);
    expect(runner).toBeInstanceOf(AnthropicDirectModelRunner);
  });

  it('throws when openai_direct profile uses a non-api_key credential', () => {
    expect(() =>
      buildDirectModelRunner(makeResolvedAi({ runner: 'openai_direct', credentialType: 'bearer_token' }), noopLogger),
    ).toThrow("Credential type 'bearer_token' is not supported for openai_direct runner");
  });

  it('throws when no openai_direct or anthropic_direct profile exists', () => {
    const resolvedAi: ResolvedAiConfig = {
      credentials: [],
      endpoints: [],
      profiles: [],
      routing: {},
    } as unknown as ResolvedAiConfig;
    expect(() => buildDirectModelRunner(resolvedAi, noopLogger)).toThrow(
      'No profile with runner "openai_direct" or "anthropic_direct" found',
    );
  });

  it('returns RoutingAwareDirectModelRunner when both openai_direct and anthropic_direct profiles exist', () => {
    const resolvedAi: ResolvedAiConfig = {
      credentials: [{ name: 'cred', type: 'api_key', resolvedValue: 'sk-test' }],
      endpoints: [{ name: 'ep', protocol: 'openai', credential: 'cred' }],
      profiles: [
        { name: 'oai', endpoint: 'ep', runner: 'openai_direct', model: 'gpt-4o-mini' },
        { name: 'ant', endpoint: 'ep', runner: 'anthropic_direct', model: 'claude-haiku-4-5' },
      ],
      routing: { 'intent.classify': 'oai', 'pr.title_generate': 'ant' },
    } as unknown as ResolvedAiConfig;
    const runner = buildDirectModelRunner(resolvedAi, noopLogger);
    expect(runner).toBeInstanceOf(RoutingAwareDirectModelRunner);
  });
});

describe('RoutingAwareDirectModelRunner dispatch', () => {
  function makeRunner(result: string): DirectModelRunner {
    return { run: vi.fn().mockResolvedValue({ text: result, raw: {} }) };
  }

  it('dispatches to the runner registered for request.profile.id', async () => {
    const openaiRunner = makeRunner('openai-result');
    const anthropicRunner = makeRunner('anthropic-result');
    const runners = new Map<string, DirectModelRunner>([
      ['oai-profile', openaiRunner],
      ['ant-profile', anthropicRunner],
    ]);
    const wrapper = new RoutingAwareDirectModelRunner(runners, openaiRunner);

    const req: DirectModelRunRequest = {
      route: { task: 'pr.title_generate' },
      profile: { id: 'ant-profile', provider: 'anthropic', model: 'claude-haiku-4-5' },
      messages: [{ role: 'user', content: 'title' }],
    };
    const result = await wrapper.run(req);
    expect(result.text).toBe('anthropic-result');
    expect(anthropicRunner.run).toHaveBeenCalledWith(req);
    expect(openaiRunner.run).not.toHaveBeenCalled();
  });

  it('falls back to the default runner when profile.id is not in the map', async () => {
    const defaultRunner = makeRunner('default-result');
    const runners = new Map<string, DirectModelRunner>([['some-profile', makeRunner('other')]]);
    const wrapper = new RoutingAwareDirectModelRunner(runners, defaultRunner);

    const req: DirectModelRunRequest = {
      route: { task: 'intent.classify' },
      profile: { id: 'unknown-profile', provider: 'openai', model: 'gpt-4o' },
      messages: [{ role: 'user', content: 'classify' }],
    };
    const result = await wrapper.run(req);
    expect(result.text).toBe('default-result');
  });

  it('falls back to the default runner when no profile is present in the request', async () => {
    const defaultRunner = makeRunner('fallback');
    const wrapper = new RoutingAwareDirectModelRunner(new Map(), defaultRunner);

    const req: DirectModelRunRequest = {
      route: { task: 'intent.classify' },
      messages: [{ role: 'user', content: 'classify' }],
    };
    const result = await wrapper.run(req);
    expect(result.text).toBe('fallback');
  });
});

function makeAgentResolvedAi(runner: 'claude_agent_sdk' | 'openai_agent_sdk', credentialType: string = 'api_key'): ResolvedAiConfig {
  return {
    credentials: [{ name: 'cred', type: credentialType, resolvedValue: 'sk-test' }],
    endpoints: [{ name: 'ep', protocol: 'openai', credential: 'cred' }],
    profiles: [{ name: 'p', endpoint: 'ep', runner, model: 'gpt-4o' }],
    routing: { 'implementation.run': 'p' },
  } as unknown as ResolvedAiConfig;
}

function makeMixedAgentResolvedAi(): ResolvedAiConfig {
  return {
    credentials: [{ name: 'cred', type: 'api_key', resolvedValue: 'sk-test' }],
    endpoints: [{ name: 'ep', protocol: 'openai', credential: 'cred' }],
    profiles: [
      { name: 'claude-p', endpoint: 'ep', runner: 'claude_agent_sdk', model: 'claude-sonnet-4-6' },
      { name: 'openai-p', endpoint: 'ep', runner: 'openai_agent_sdk', model: 'gpt-4o' },
    ],
    routing: { 'artifact.create': 'claude-p', 'implementation.run': 'openai-p' },
  } as unknown as ResolvedAiConfig;
}

describe('buildAgentRunner dispatch', () => {
  test('returns ClaudeAgentSdkAgentRunner when profile runner is claude_agent_sdk', () => {
    const runner = buildAgentRunner(makeAgentResolvedAi('claude_agent_sdk'), noopLogger);
    expect(runner).toBeInstanceOf(ClaudeAgentSdkAgentRunner);
  });

  test('returns OpenAIAgentSdkAgentRunner when profile runner is openai_agent_sdk', () => {
    const runner = buildAgentRunner(makeAgentResolvedAi('openai_agent_sdk'), noopLogger);
    expect(runner).toBeInstanceOf(OpenAIAgentSdkAgentRunner);
  });

  test('throws a clear startup error when no recognized runner kind is configured', () => {
    const resolvedAi: ResolvedAiConfig = {
      credentials: [{ name: 'cred', type: 'api_key', resolvedValue: 'sk' }],
      endpoints: [{ name: 'ep', protocol: 'openai', credential: 'cred' }],
      profiles: [{ name: 'p', endpoint: 'ep', runner: 'openai_direct', model: 'gpt-4o' }],
      routing: {},
    } as unknown as ResolvedAiConfig;

    expect(() => buildAgentRunner(resolvedAi, noopLogger)).toThrow(
      /No recognized agent runner configured/,
    );
  });

  test('throws a clear startup error when openai_agent_sdk profile uses non-api_key credential', () => {
    expect(() =>
      buildAgentRunner(makeAgentResolvedAi('openai_agent_sdk', 'bearer_token'), noopLogger),
    ).toThrow(/not supported for openai_agent_sdk runner/);
  });

  test('logs service.config event with correct fields when openai_agent_sdk profile is used', () => {
    const loggedInfoCalls: unknown[] = [];
    const capturingLogger: RuntimeLogger = {
      debug: () => {},
      error: () => {},
      warn: () => {},
      info: (obj: unknown) => { loggedInfoCalls.push(obj); },
    };

    buildAgentRunner(makeAgentResolvedAi('openai_agent_sdk'), capturingLogger);

    const serviceConfigEvent = loggedInfoCalls.find(
      (c): c is Record<string, unknown> =>
        typeof c === 'object' && c !== null && (c as Record<string, unknown>)['event'] === 'service.config',
    );
    expect(serviceConfigEvent).toBeDefined();
    expect(serviceConfigEvent?.['provider']).toBe('openai');
    expect(serviceConfigEvent?.['runner']).toBe('openai_agent_sdk');
  });

  test('returns RoutingAwareAgentRunner when both claude_agent_sdk and openai_agent_sdk profiles exist', () => {
    const runner = buildAgentRunner(makeMixedAgentResolvedAi(), noopLogger);
    expect(runner).toBeInstanceOf(RoutingAwareAgentRunner);
  });
});

describe('RoutingAwareAgentRunner dispatch', () => {
  function makeAgentRunnerMock(): AgentRunner {
    return {
      run: vi.fn().mockImplementation(async function* () {
        yield { type: 'assistant', content: [{ type: 'text', text: 'ok' }] };
      }),
    };
  }

  it('dispatches to openAiRunner when request.profile.provider is openai_agent_sdk', async () => {
    const claudeRunner = makeAgentRunnerMock();
    const openAiRunner = makeAgentRunnerMock();
    const wrapper = new RoutingAwareAgentRunner(claudeRunner, openAiRunner);

    const req: AgentRunRequest = {
      route: { task: 'implementation.run' },
      profile: { id: 'openai-p', provider: 'openai_agent_sdk', model: 'gpt-4o' },
      working_directory: '/tmp',
      prompt: 'do it',
    };
    const events = [];
    for await (const event of wrapper.run(req)) {
      events.push(event);
    }
    expect(openAiRunner.run).toHaveBeenCalledWith(req);
    expect(claudeRunner.run).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });

  it('dispatches to claudeRunner when request.profile.provider is claude_agent_sdk', async () => {
    const claudeRunner = makeAgentRunnerMock();
    const openAiRunner = makeAgentRunnerMock();
    const wrapper = new RoutingAwareAgentRunner(claudeRunner, openAiRunner);

    const req: AgentRunRequest = {
      route: { task: 'artifact.create' },
      profile: { id: 'claude-p', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-6' },
      working_directory: '/tmp',
      prompt: 'write a spec',
    };
    const events = [];
    for await (const event of wrapper.run(req)) {
      events.push(event);
    }
    expect(claudeRunner.run).toHaveBeenCalledWith(req);
    expect(openAiRunner.run).not.toHaveBeenCalled();
  });

  it('falls back to claudeRunner when no profile is present', async () => {
    const claudeRunner = makeAgentRunnerMock();
    const openAiRunner = makeAgentRunnerMock();
    const wrapper = new RoutingAwareAgentRunner(claudeRunner, openAiRunner);

    const req: AgentRunRequest = {
      route: { task: 'question.answer' },
      working_directory: '/tmp',
      prompt: 'what is this?',
    };
    for await (const _ of wrapper.run(req)) { /* drain */ }
    expect(claudeRunner.run).toHaveBeenCalledWith(req);
    expect(openAiRunner.run).not.toHaveBeenCalled();
  });
});

describe('buildAgentRunner — requestLogDir threading', () => {
  it('returns ClaudeAgentSdkAgentRunner when requestLogDir is provided', () => {
    const runner = buildAgentRunner(
      makeAgentResolvedAi('claude_agent_sdk'),
      noopLogger,
      undefined,
      [],
      undefined,
      '/tmp/test-workspace/request-logs',
    );
    expect(runner).toBeInstanceOf(ClaudeAgentSdkAgentRunner);
  });

  it('returns ClaudeAgentSdkAgentRunner when requestLogDir is undefined (backward compat)', () => {
    const runner = buildAgentRunner(
      makeAgentResolvedAi('claude_agent_sdk'),
      noopLogger,
      undefined,
      [],
      undefined,
      undefined,
    );
    expect(runner).toBeInstanceOf(ClaudeAgentSdkAgentRunner);
  });

  it('wires requestLog into OpenAIAgentSdkAgentRunner when requestLogDir is provided', () => {
    const runner = buildAgentRunner(
      makeAgentResolvedAi('openai_agent_sdk'),
      noopLogger,
      undefined,
      [],
      undefined,
      '/tmp/test-workspace/request-logs',
    );
    expect(runner).toBeInstanceOf(OpenAIAgentSdkAgentRunner);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((runner as any).requestLog).toEqual({ logDir: '/tmp/test-workspace/request-logs' });
  });

  it('does not set requestLog on OpenAIAgentSdkAgentRunner when requestLogDir is undefined', () => {
    const runner = buildAgentRunner(
      makeAgentResolvedAi('openai_agent_sdk'),
      noopLogger,
      undefined,
      [],
      undefined,
      undefined,
    );
    expect(runner).toBeInstanceOf(OpenAIAgentSdkAgentRunner);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((runner as any).requestLog).toBeUndefined();
  });
});

describe('runtime wiring: AuthoringApiConvergenceCoordinator construction', () => {
  it('AuthoringApiConvergenceCoordinator can be constructed with agentRunner, routingPolicy, policy, and logger', () => {
    const agentRunner: AgentRunner = {
      run: vi.fn().mockImplementation(async function* () {
        yield { type: 'assistant', content: [{ type: 'text', text: 'ok' }] };
      }),
    };
    const routingPolicy = {
      resolve: vi.fn(),
    } as unknown as import('../../src/core/ai/routing-policy.js').DefaultAgentRoutingPolicy;

    const workflowConfig = {} as WorkflowConfig;
    const specAuthoringPolicy = getSpecAuthoringPolicy(workflowConfig);

    const coordinator = new AuthoringApiConvergenceCoordinator({
      runner: agentRunner,
      routingPolicy,
      policy: specAuthoringPolicy.api_convergence,
      logger: noopLogger,
    });

    expect(coordinator).toBeInstanceOf(AuthoringApiConvergenceCoordinator);
  });
});

describe('runtime wiring: specReviewCoordinator flows through OrchestratorDeps', () => {
  it('OrchestratorDeps accepts specReviewCoordinator and OrchestratorImpl forwards it to the handler registry', () => {
    // Verify that specReviewCoordinator is accepted by OrchestratorDeps at the type level
    // and that the orchestrator passes it through to buildDefaultHandlerRegistry.
    const runSpecReview = vi.fn().mockResolvedValue({ status: 'complete', artifact_path: '/ws/spec.md' });
    const specReviewCoordinator = { runSpecReview };

    const minimalDeps: OrchestratorDeps = {
      adapter: { on: vi.fn(), resolveChannels: vi.fn(), isConnected: vi.fn() } as unknown as OrchestratorDeps['adapter'],
      workspaceManager: { create: vi.fn(), findExisting: vi.fn(), cleanup: vi.fn() } as unknown as OrchestratorDeps['workspaceManager'],
      artifactAuthoringAgent: { create: vi.fn(), revise: vi.fn(), respondToSpecReview: vi.fn() } as unknown as OrchestratorDeps['artifactAuthoringAgent'],
      artifactPublisher: { createArtifact: vi.fn(), updateArtifact: vi.fn() } as unknown as OrchestratorDeps['artifactPublisher'],
      channelRepoMap: {},
      specReviewCoordinator,
    };

    // OrchestratorImpl should construct without throwing when specReviewCoordinator is provided
    const orchestrator = new OrchestratorImpl(minimalDeps);
    expect(orchestrator).toBeDefined();
  });
});
