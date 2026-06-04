import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedConfig } from '../../src/types/config.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execSync: vi.fn().mockReturnValue('https://example.test/org/repo.git\n'),
  execFileSync: vi.fn().mockReturnValue('https://example.test/org/repo.git\n'),
}));

vi.mock('@slack/bolt', () => ({
  App: vi.fn().mockImplementation((args: unknown) => ({ args, client: {} })),
}));

const fakeChannelRegistry = new Map([
  ['slack:C123', {
    channel: { provider: 'slack', id: 'C123', name: 'product' },
    repo_url: 'https://example.test/org/repo.git',
    workspace_root: '/tmp/ws',
  }],
]);

const fakeAdapter = {
  resolveChannels: vi.fn().mockResolvedValue(fakeChannelRegistry),
  start: vi.fn(),
  stop: vi.fn(),
  receive: async function* () {},
  reply: vi.fn(),
  replyError: vi.fn(),
  isConnected: vi.fn().mockReturnValue(true),
};

vi.mock('../../src/adapters/slack/slack-adapter.js', () => ({
  SlackAdapter: vi.fn().mockImplementation(() => fakeAdapter),
}));

vi.mock('../../src/adapters/slack/thread-registry.js', () => ({
  ThreadRegistry: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/core/workspace-manager.js', () => ({
  WorkspaceManagerImpl: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/core/run-store.js', () => ({
  FileRunStore: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/adapters/github/pr-manager.js', () => ({
  GHPRManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/adapters/github/issue-manager.js', () => ({
  GHIssueManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/adapters/slack/canvas-publisher.js', () => ({
  SlackCanvasPublisher: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/adapters/anthropic/direct-model-runner.js', () => ({
  AnthropicDirectModelRunner: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/adapters/anthropic/claude-agent-sdk-agent-runner.js', () => ({
  ClaudeAgentSdkAgentRunner: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/core/bootstrap.js', () => ({
  bootstrapWorkflowRuntime: vi.fn().mockReturnValue({
    service: { start: vi.fn(), stopped: new Promise(() => {}), updateConfig: vi.fn() },
    orchestrator: {},
    commandRegistry: {},
  }),
}));

vi.mock('@anthropic-ai/bedrock-sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: vi.fn() } })),
}));

vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: vi.fn().mockReturnValue(vi.fn()),
}));

const BASE_AI_CONFIG = {
  credentials: [
    { name: 'anthropic-default', type: 'api_key' as const, value: 'test-key' },
  ],
  endpoints: [
    { name: 'anthropic-direct', protocol: 'anthropic' as const, credential: 'anthropic-default' },
  ],
  profiles: [
    { name: 'default', endpoint: 'anthropic-direct', model: 'claude-sonnet-4-5', runner: 'anthropic_direct' as const },
    { name: 'agent', endpoint: 'anthropic-direct', model: 'claude-sonnet-4-5', runner: 'claude_agent_sdk' as const },
  ],
  routing: { default_profile: 'default' },
};

const BEDROCK_AI_CONFIG = {
  credentials: [
    { name: 'bedrock-iam', type: 'iam' as const, aws_profile: 'ai-prod-llm' },
  ],
  endpoints: [
    { name: 'bedrock-direct', protocol: 'anthropic' as const, credential: 'bedrock-iam' },
  ],
  profiles: [
    { name: 'default', endpoint: 'bedrock-direct', model: 'claude-sonnet-4-5', runner: 'anthropic_direct' as const },
    { name: 'agent', endpoint: 'bedrock-direct', model: 'claude-sonnet-4-5', runner: 'claude_agent_sdk' as const },
  ],
  routing: { default_profile: 'default' },
};

function makeConfig(overrides: Partial<LoadedConfig['config']> = {}): LoadedConfig {
  return {
    config: {
      workspace: { root: '/tmp/ws' },
      channels: [
        {
          provider: 'slack',
          name: 'product',
          workspace_root: '/tmp/ws',
          config: {
            bot_token: 'xoxb-test',
            app_token: 'xapp-test',
            reacjis: {
              ack: 'binoculars',
              complete: 'white_check_mark',
            },
          },
        },
      ],
      ai: BASE_AI_CONFIG,
      ...overrides,
    },
    filePath: '/tmp/repo/autocatalyst.yaml',
  };
}

describe('composeWorkflowRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds a runtime from normalized built-in provider config and resolved channel registry', async () => {
    const { composeWorkflowRuntime } = await import('../../src/core/runtime-composition.js');
    const { SlackAdapter } = await import('../../src/adapters/slack/slack-adapter.js');
    const { bootstrapWorkflowRuntime } = await import('../../src/core/bootstrap.js');

    const config = makeConfig();

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const runtime = await composeWorkflowRuntime({
      currentConfig: config,
      repoPath: '/tmp/repo',
      repoPaths: ['/tmp/repo'],
      env: { AC_ANTHROPIC_API_KEY: 'test-key' },
      logger,
    });

    expect(runtime.service).toBeDefined();
    expect(SlackAdapter).toHaveBeenCalledWith(
      expect.anything(),
      { channelName: 'product', repo_url: 'https://example.test/org/repo.git', workspace_root: '/tmp/ws' },
      expect.objectContaining({ ackEmoji: 'binoculars' }),
    );
    expect(bootstrapWorkflowRuntime).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        adapter: fakeAdapter,
        reacjiComplete: 'white_check_mark',
        channelRepoMap: new Map([
          ['slack:C123', { channel_ref: 'slack:C123', repo_url: 'https://example.test/org/repo.git', workspace_root: '/tmp/ws' }],
        ]),
        specReviewCoordinator: expect.objectContaining({ runSpecReview: expect.any(Function) }),
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'extensions.loaded',
        built_in_extensions: expect.arrayContaining(['channel:slack', 'publisher:notion', 'agent_runtime:claude_agent_sdk']),
      }),
      'Built-in extensions loaded',
    );
  });

  it('passes configured aws_profile directly to the Bedrock credential provider without mutating env', async () => {
    const { composeWorkflowRuntime } = await import('../../src/core/runtime-composition.js');
    const { default: AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk');
    const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers');
    const config = makeConfig({ ai: BEDROCK_AI_CONFIG });
    const env: Record<string, string | undefined> = {};
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    await composeWorkflowRuntime({
      currentConfig: config,
      repoPath: '/tmp/repo',
      repoPaths: ['/tmp/repo'],
      env,
      logger,
    });
    const bedrockOptions = vi.mocked(AnthropicBedrock).mock.calls[0][0] as {
      providerChainResolver: () => Promise<unknown>;
    };

    await bedrockOptions.providerChainResolver();

    expect(fromNodeProviderChain).toHaveBeenCalledWith({ profile: 'ai-prod-llm' });
    expect(env).not.toHaveProperty('AWS_PROFILE');
  });
});
