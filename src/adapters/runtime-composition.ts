import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type pino from 'pino';
import type { Meter } from '@opentelemetry/api';
import type { LoggerProvider } from '@opentelemetry/api-logs';
import { App } from '@slack/bolt';
import Anthropic from '@anthropic-ai/sdk';
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { loadConfigFromPath, repoNameFromUrl, resolveEnvVars, resolveAiConfig, getImplementationReviewPolicy, getSpecReviewPolicy, type ResolvedAiConfig } from '../core/config.js';
import { bootstrapWorkflowRuntime } from '../core/bootstrap.js';
import { normalizeWorkflowConfig } from '../core/config-normalizer.js';
import { configExists, runInit } from '../core/init.js';
import { channelRegistryToRepoMap, type LoadedConfig, type PreRepoEntry, type ProfileConfig, type WorkflowConfig } from '../types/config.js';
import { SlackAdapter } from './slack/slack-adapter.js';
import { SlackThreadPruner } from './slack/thread-pruner.js';
import { ThreadRegistry } from './slack/thread-registry.js';
import { WorkspaceManagerImpl } from '../core/workspace-manager.js';
import { SlackCanvasPublisher } from './slack/canvas-publisher.js';
import type { ArtifactCommentAnchorCodec, ArtifactContentSource, ArtifactPublisher } from '../types/publisher.js';
import { FileRunStore } from '../core/run-store.js';
import { JsonlJournalWriter } from '../core/journal/jsonl-writer.js';
import { RunJournal } from '../core/journal/run-journal.js';
import { NoopJournalWriter } from '../types/journal.js';
import { NotionClientImpl } from './notion/notion-client.js';
import { NotionPublisher } from './notion/notion-publisher.js';
import { NotionCommentAnchorCodec } from './notion/markdown-diff.js';
import { NotionFeedbackSource } from './notion/notion-feedback-source.js';
import type { FeedbackSource } from '../types/feedback-source.js';
import { GHPRManager } from './github/pr-manager.js';
import { GHIssueManager } from './github/issue-manager.js';
import { NotionSpecCommitter } from './notion/spec-committer.js';
import type { SpecCommitter } from '../core/spec-committer.js';
import { NotionImplementationFeedbackPage } from './notion/implementation-feedback-page.js';
import type { ImplementationReviewPublisher } from '../types/impl-feedback-page.js';
import { createBuiltInExtensionRegistry } from './built-in-extensions.js';
import type { BuiltInExtensionKind, BuiltInExtensionRegistry } from '../core/extensions/built-ins.js';
import { DefaultAgentRoutingPolicy } from '../core/ai/routing-policy.js';
import { ModelIntentClassifier } from '../core/ai/model-intent-classifier.js';
import { ModelPRTitleGenerator } from '../core/ai/pr-title-generator.js';
import {
  AgentRunnerArtifactAuthoringAgent,
  AgentRunnerImplementationAgent,
  AgentRunnerImplementationPlanningAgent,
  AgentRunnerIssueTriageAgent,
  AgentRunnerQuestionAnsweringAgent,
  IssueFilingService,
} from '../core/ai/agent-services.js';
import { AnthropicDirectModelRunner, type AnthropicCreateFn } from './anthropic/direct-model-runner.js';
import { OpenAIDirectModelRunner } from './openai/direct-model-runner.js';
import type { DirectModelRunRequest, DirectModelRunResult, DirectModelRunner, AgentRunner, AgentRunRequest, AgentRunEvent } from '../types/ai.js';
import { ClaudeAgentSdkAgentRunner } from './anthropic/claude-agent-sdk-agent-runner.js';
import { OpenAIAgentSdkAgentRunner } from './openai/agent-sdk-agent-runner.js';
import { ImplementationReviewCoordinator } from '../core/ai/implementation-review-coordinator.js';
import { resolveImplementationConvergencePolicy } from '../core/ai/layered-convergence-policy.js';
import { SpecReviewCoordinator } from '../core/ai/spec-review-coordinator.js';
import type { BudgetWriter } from '../core/journal/model-session-budget.js';
import { createLogger } from '../core/logger.js';
import { WorkspacePruner } from '../core/workspace-pruner.js';
import { CommandConfirmationRegistryImpl } from '../core/command-confirmations.js';
import type { PruneConfirmationPayload } from '../core/commands/prune-command.js';

export type RuntimeLogger = Pick<pino.Logger, 'debug' | 'error' | 'info' | 'warn'>;

export interface ComposeWorkflowRuntimeOptions {
  currentConfig: LoadedConfig;
  repoPath: string;
  repoPaths: string[];
  env: Record<string, string | undefined>;
  logger: RuntimeLogger;
  meter?: Meter;
  loggerProvider?: LoggerProvider;
  logRequests?: boolean;
}

export async function composeBuiltInWorkflowRuntime(options: ComposeWorkflowRuntimeOptions): Promise<ReturnType<typeof bootstrapWorkflowRuntime>> {
  const { currentConfig, env, logger, repoPath, repoPaths } = options;
  const isMultiRepo = repoPaths.length > 1;
  const normalizedConfig = normalizeWorkflowConfig(currentConfig.config);
  const builtInExtensions = createBuiltInExtensionRegistry();
  logger.info(
    {
      event: 'extensions.loaded',
      built_in_extensions: builtInExtensions.entries().map(extension => `${extension.kind}:${extension.provider}`),
    },
    'Built-in extensions loaded',
  );

  logger.info(
    {
      event: 'config.normalized',
      channel_count: normalizedConfig.channels.length,
      publisher_count: normalizedConfig.publishers.length,
    },
    'Configuration normalized',
  );

  const resolvedAi = resolveAiConfig(currentConfig.config, env);
  logger.info(
    {
      event: 'config.resolved',
      routingMap: resolvedAi.routing,
    },
    'AI config resolved',
  );

  const repo_url = resolveRepoUrl(repoPath, logger);
  const repo_name = repoNameFromUrl(repo_url);
  const slackChannelConfig = findConfiguredProvider(normalizedConfig.channels, builtInExtensions, 'channel', 'slack');
  const workspaceRoot = workspaceRootFromConfig(slackChannelConfig?.workspace_root ?? normalizedConfig.workspace_root);
  const requestLogDir = options.logRequests ? join(workspaceRoot, 'request-logs') : undefined;

  const botToken = stringConfig(slackChannelConfig?.config, 'bot_token');
  const appToken = stringConfig(slackChannelConfig?.config, 'app_token');
  if (!botToken || !appToken) {
    throw new Error('channels[] provider "slack" requires config.bot_token and config.app_token');
  }

  const channelName = slackChannelConfig?.name;
  if (!channelName) {
    throw new Error('channels[] provider "slack" requires name');
  }
  const slackReacjisConfig = recordConfig(slackChannelConfig?.config, 'reacjis');
  const ackEmoji = stringConfig(slackReacjisConfig, 'ack');
  const reacjiComplete = stringConfig(slackReacjisConfig, 'complete');

  const boltApp = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  const aiRoutingPolicy = buildAgentRoutingPolicy(resolvedAi);
  const directModelRunner = buildDirectModelRunner(resolvedAi, logger, options.loggerProvider);
  const agentRunner = buildAgentRunner(resolvedAi, logger, options.meter, currentConfig.config.sandbox?.env_tokens, options.loggerProvider, requestLogDir);
  const intentClassifier = new ModelIntentClassifier(directModelRunner, { routingPolicy: aiRoutingPolicy });
  const prTitleGenerator = new ModelPRTitleGenerator(directModelRunner, { routingPolicy: aiRoutingPolicy });
  const questionAnswerer = new AgentRunnerQuestionAnsweringAgent(agentRunner, aiRoutingPolicy, repoPath, { loggerProvider: options.loggerProvider });
  const preRepoEntries = isMultiRepo
    ? await resolvePreRepoEntries(repoPaths, env, logger)
    : [];

  const threadRegistry = new ThreadRegistry();
  const confirmationRegistry = new CommandConfirmationRegistryImpl<PruneConfirmationPayload>();
  const adapter = new SlackAdapter(
    boltApp,
    isMultiRepo
      ? { repoEntries: preRepoEntries }
      : { channelName, repo_url, workspace_root: workspaceRoot },
    ackEmoji
      ? { registry: threadRegistry, ackEmoji, confirmationRegistry }
      : { registry: threadRegistry, confirmationRegistry },
  );

  const channelRegistry = await adapter.resolveChannels();
  const channelRepoMap = channelRegistryToRepoMap(channelRegistry);

  const workspaceManager = new WorkspaceManagerImpl();

  let journal: RunJournal;
  let budgetWriter: BudgetWriter;
  if (normalizedConfig.journal_enabled) {
    logger.info({ event: 'journal.writer_started' }, 'Journal enabled');
    const writer = new JsonlJournalWriter(workspaceRoot);
    journal = new RunJournal(writer);
    budgetWriter = writer;
  } else {
    logger.info({ event: 'journal.disabled' }, 'Journal disabled');
    const writer = new NoopJournalWriter();
    journal = new RunJournal(writer);
    budgetWriter = writer;
  }

  const runStore = new FileRunStore(workspaceRoot, {
    legacyConversationFields: {
      provider: 'slack',
      channelField: 'channel_id',
      conversationField: 'thread_ts',
    },
    journal,
  });
  const implementer = new AgentRunnerImplementationAgent(agentRunner, aiRoutingPolicy, { loggerProvider: options.loggerProvider });
  const implementationPlanner = new AgentRunnerImplementationPlanningAgent(agentRunner, aiRoutingPolicy, { loggerProvider: options.loggerProvider });
  const prManager = new GHPRManager();
  const issueManager = new GHIssueManager();
  const issueTriageAgent = new AgentRunnerIssueTriageAgent(agentRunner, aiRoutingPolicy, { loggerProvider: options.loggerProvider });
  const issueFiler = new IssueFilingService(issueManager, issueTriageAgent);

  const artifactDeps = await buildArtifactDeps({
    app: boltApp,
    currentConfig,
    logger,
    normalizedConfig,
    builtInExtensions,
    repo_name,
    env,
  });
  const artifactAuthoringAgent = new AgentRunnerArtifactAuthoringAgent(agentRunner, aiRoutingPolicy, {
    commentAnchorCodec: artifactDeps.commentAnchorCodec,
    loggerProvider: options.loggerProvider,
  });

  const reviewCoordinator = new ImplementationReviewCoordinator({
    runner: agentRunner,
    implementer,
    routingPolicy: aiRoutingPolicy,
    policy: getImplementationReviewPolicy(currentConfig.config),
    logger,
  });

  const convergencePolicy = resolveImplementationConvergencePolicy(currentConfig.config);

  const specReviewCoordinator = new SpecReviewCoordinator({
    runner: agentRunner,
    artifactAuthoringAgent,
    routingPolicy: aiRoutingPolicy,
    policy: getSpecReviewPolicy(currentConfig.config),
    logger,
  });

  const threadPruner = new SlackThreadPruner(boltApp);
  const workspacePruner = new WorkspacePruner();
  const pruneLogger = createLogger('prune-commands');

  return bootstrapWorkflowRuntime(currentConfig, {
    adapter,
    workspaceManager,
    artifactAuthoringAgent,
    artifactPublisher: artifactDeps.artifactPublisher,
    artifactContentSource: artifactDeps.artifactContentSource,
    artifactPolicies: normalizedConfig.artifact_policies,
    feedbackSource: artifactDeps.feedbackSource,
    intentClassifier,
    questionAnswerer,
    specCommitter: artifactDeps.specCommitter,
    implementationPlanner,
    implementer,
    implFeedbackPage: artifactDeps.implFeedbackPage,
    prManager,
    prTitleGenerator,
    issueManager,
    issueFiler,
    runStore,
    channelRepoMap,
    reacjiComplete,
    reviewCoordinator,
    convergencePolicy,
    budgetWriter,
    specReviewCoordinator,
    threadPruner,
    workspacePruner,
    confirmationRegistry,
    pruneLogger,
    autoPruneWorkspace: normalizedConfig.workspace_auto_prune,
    isConnected: () => adapter.isConnected(),
    meter: options.meter,
    onStop: () => agentRunner.close?.() ?? Promise.resolve(),
    journal,
  });
}

function resolveRepoUrl(repoPath: string, logger: RuntimeLogger): string {
  try {
    const repoUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath }).toString().trim();
    if (!repoUrl) throw new Error('git remote get-url origin returned empty string');
    return repoUrl;
  } catch (err) {
    logger.error({ event: 'config.parse_error', error: String(err) }, 'Could not resolve git origin URL. Run: git remote add origin <url>');
    throw err;
  }
}

function workspaceRootFromConfig(rawWorkspaceRoot: string | undefined): string {
  if (!rawWorkspaceRoot || rawWorkspaceRoot.trim() === '') {
    throw new Error('workspace.root is required');
  }
  return rawWorkspaceRoot.replace(/^~/, homedir());
}

function stringConfig(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function recordConfig(config: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = config?.[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function buildAgentRoutingPolicy(resolvedAi: ResolvedAiConfig): DefaultAgentRoutingPolicy {
  return new DefaultAgentRoutingPolicy(resolvedAi);
}

export function buildAgentRunner(
  resolvedAi: ResolvedAiConfig,
  logger: RuntimeLogger,
  meter?: Meter,
  sandboxEnvTokens?: string[],
  loggerProvider?: LoggerProvider,
  requestLogDir?: string,
): AgentRunner {
  const claudeProfile = resolvedAi.profiles.find(p => p.runner === 'claude_agent_sdk');
  const openAiAgentProfile = resolvedAi.profiles.find(p => p.runner === 'openai_agent_sdk');

  if (!claudeProfile && !openAiAgentProfile) {
    const runnerKinds = resolvedAi.profiles.map(p => p.runner).join(', ') || 'none';
    throw new Error(
      `No recognized agent runner configured. Expected a profile with runner: claude_agent_sdk or openai_agent_sdk. Found: ${runnerKinds}`,
    );
  }

  const claudeRunner = claudeProfile
    ? (() => {
        logger.info(
          {
            event: 'service.config',
            provider: 'anthropic',
            runner: 'claude_agent_sdk',
            model: claudeProfile.model ?? 'default',
          },
          'Using Claude Agent SDK',
        );
        return new ClaudeAgentSdkAgentRunner({
          meter,
          sandboxEnvTokens,
          loggerProvider,
          ...(requestLogDir ? { requestLog: { logDir: requestLogDir } } : {}),
        });
      })()
    : null;

  let openAiRunner: AgentRunner | null = null;
  if (openAiAgentProfile) {
    const endpoint = resolvedAi.endpoints.find(e => e.name === openAiAgentProfile.endpoint)!;
    const credential = resolvedAi.credentials.find(c => c.name === endpoint.credential)!;

    if (credential.type !== 'api_key') {
      throw new Error(
        `Credential type '${credential.type}' is not supported for openai_agent_sdk runner`,
      );
    }

    logger.info(
      {
        event: 'service.config',
        provider: 'openai',
        runner: 'openai_agent_sdk',
        model: openAiAgentProfile.model ?? 'default',
        base_url: endpoint.base_url ?? 'default',
      },
      'Using OpenAI Agents SDK',
    );

    openAiRunner = new OpenAIAgentSdkAgentRunner(
      credential.resolvedValue!,
      endpoint.base_url,
      openAiAgentProfile.model,
      {
        meter,
        sandboxEnvTokens,
        loggerProvider,
        ...(requestLogDir ? { requestLog: { logDir: requestLogDir } } : {}),
      },
    );
  }

  // Only one runner kind present — return directly (no routing overhead)
  if (claudeRunner && !openAiRunner) return claudeRunner;
  if (openAiRunner && !claudeRunner) return openAiRunner;

  // Both runner kinds present — wrap in a routing-aware runner that dispatches
  // on request.profile?.provider at call time.
  return new RoutingAwareAgentRunner(claudeRunner!, openAiRunner!, { loggerProvider });
}

/**
 * Dispatches `run()` calls to the runner registered for the resolved profile.
 * Used when the routing table maps different tasks to profiles with different runner kinds
 * (e.g. intent classification → openai_direct, PR title → anthropic_direct).
 */
export class RoutingAwareDirectModelRunner implements DirectModelRunner {
  constructor(
    private readonly runners: Map<string, DirectModelRunner>,
    private readonly fallback: DirectModelRunner,
  ) {}

  run(request: DirectModelRunRequest): Promise<DirectModelRunResult> {
    const profileId = request.profile?.id;
    const runner = (profileId !== undefined && this.runners.get(profileId)) || this.fallback;
    return runner.run(request);
  }
}

/**
 * Dispatches `run()` calls to the agent runner registered for the resolved profile's provider.
 * Used when the routing table maps different tasks to profiles with different agent runner kinds
 * (e.g. artifact.create → claude_agent_sdk, implementation.run → openai_agent_sdk).
 */
export class RoutingAwareAgentRunner implements AgentRunner {
  private readonly logger: RuntimeLogger;

  constructor(
    private readonly claudeRunner: AgentRunner,
    private readonly openAiRunner: AgentRunner,
    options?: { logDestination?: pino.DestinationStream; loggerProvider?: LoggerProvider },
  ) {
    this.logger = createLogger('routing-aware-runner', {
      destination: options?.logDestination,
      loggerProvider: options?.loggerProvider,
    });
  }

  run(request: AgentRunRequest): AsyncIterable<AgentRunEvent> {
    const selected = request.profile?.provider === 'openai_agent_sdk' ? 'openai_agent_sdk' : 'claude_agent_sdk';
    this.logger.debug(
      {
        event: 'runner.dispatched',
        runner: selected,
        route_task: request.route.task,
        model: request.profile?.model ?? 'unknown',
      },
      'Routing-aware runner dispatched',
    );
    if (request.profile?.provider === 'openai_agent_sdk') {
      return this.openAiRunner.run(request);
    }
    return this.claudeRunner.run(request);
  }

  async close(): Promise<void> {
    await Promise.all([
      this.claudeRunner.close?.(),
      this.openAiRunner.close?.(),
    ]);
  }
}

function buildRunnerForProfile(
  profile: ProfileConfig,
  resolvedAi: ResolvedAiConfig,
  logger: RuntimeLogger,
  loggerProvider?: LoggerProvider,
): DirectModelRunner {
  const endpoint = resolvedAi.endpoints.find(e => e.name === profile.endpoint)!;
  const credential = resolvedAi.credentials.find(c => c.name === endpoint.credential)!;

  if (profile.runner === 'openai_direct') {
    if (credential.type !== 'api_key') {
      throw new Error(`Credential type '${credential.type}' is not supported for openai_direct runner`);
    }
    logger.info(
      { event: 'service.config', provider: 'openai', auth: 'api_key', base_url: endpoint.base_url ?? 'default' },
      'Using OpenAI direct API',
    );
    return new OpenAIDirectModelRunner(credential.resolvedValue!, endpoint.base_url, {
      defaultModel: profile.model,
      loggerProvider,
    });
  }

  // anthropic_direct paths
  if (credential.type === 'iam') {
    const bedrockClient = new AnthropicBedrock({
      providerChainResolver: () => Promise.resolve(
        credential.aws_profile
          ? fromNodeProviderChain({ profile: credential.aws_profile })
          : fromNodeProviderChain(),
      ),
    });
    const bedrockCreateFn: AnthropicCreateFn = async (params) => {
      try {
        return await bedrockClient.messages.create({
          ...params,
          model: `us.${params.model.replace(/^us\./, '')}`,
        }) as unknown as { content: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
      } catch (err) {
        const msg = String(err);
        if (msg.includes('CredentialsProviderError') || msg.includes('Could not load credentials') || msg.includes('sso')) {
          logger.error(
            { event: 'bedrock.credentials_expired', aws_profile: credential.aws_profile ?? 'default' },
            'AWS credentials expired or unavailable. Run: aws sso login --profile <profile>',
          );
        }
        throw err;
      }
    };
    logger.info(
      { event: 'service.config', provider: 'bedrock', auth: 'iam', aws_profile: credential.aws_profile ?? 'default' },
      'Using Amazon Bedrock',
    );
    return new AnthropicDirectModelRunner('', {
      createFn: bedrockCreateFn,
      defaultModel: profile.model,
      loggerProvider,
    });
  }

  if (credential.type === 'api_key') {
    logger.info(
      { event: 'service.config', provider: 'anthropic', auth: 'api_key', base_url: endpoint.base_url ?? 'default' },
      'Using Anthropic direct API with API key',
    );
    const clientOptions: ConstructorParameters<typeof Anthropic>[0] = { apiKey: credential.resolvedValue! };
    if (endpoint.base_url) {
      clientOptions.baseURL = endpoint.base_url;
      clientOptions.defaultHeaders = { 'api-key': credential.resolvedValue! };
    }
    const client = new Anthropic(clientOptions);
    return new AnthropicDirectModelRunner(credential.resolvedValue!, {
      createFn: params => client.messages.create(params) as Promise<{ content: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } }>,
      defaultModel: profile.model,
      loggerProvider,
    });
  }

  if (credential.type === 'bearer_token') {
    logger.info(
      { event: 'service.config', provider: 'anthropic', auth: 'bearer_token' },
      'Using Anthropic direct API with bearer token',
    );
    return new AnthropicDirectModelRunner('', {
      createFn: async (params) => {
        const client = new Anthropic({ authToken: credential.resolvedValue! });
        return await client.messages.create(params) as unknown as { content: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
      },
      defaultModel: profile.model,
      loggerProvider,
    });
  }

  throw new Error(`Credential type '${credential.type}' is not supported for anthropic_direct runner`);
}

export function buildDirectModelRunner(
  resolvedAi: ResolvedAiConfig,
  logger: RuntimeLogger,
  loggerProvider?: LoggerProvider,
): DirectModelRunner {
  const directProfiles = resolvedAi.profiles.filter(
    p => p.runner === 'openai_direct' || p.runner === 'anthropic_direct',
  );

  if (directProfiles.length === 0) {
    throw new Error(
      'No profile with runner "openai_direct" or "anthropic_direct" found in autocatalyst.yaml ai.profiles',
    );
  }

  if (directProfiles.length === 1) {
    return buildRunnerForProfile(directProfiles[0], resolvedAi, logger, loggerProvider);
  }

  // Multiple direct profiles — build one runner per profile and wire up routing dispatch.
  const runners = new Map<string, DirectModelRunner>();
  for (const profile of directProfiles) {
    runners.set(profile.name, buildRunnerForProfile(profile, resolvedAi, logger, loggerProvider));
  }
  const fallback = runners.get(directProfiles[0].name)!;
  return new RoutingAwareDirectModelRunner(runners, fallback);
}

function findConfiguredProvider<T extends { provider: string }>(
  entries: T[],
  builtInExtensions: BuiltInExtensionRegistry,
  kind: BuiltInExtensionKind,
  provider: string,
): T | undefined {
  if (!builtInExtensions.has(kind, provider)) {
    throw new Error(`Built-in extension is not registered: ${kind}:${provider}`);
  }
  return entries.find(entry => entry.provider === provider);
}

async function resolvePreRepoEntries(
  repoPaths: string[],
  env: Record<string, string | undefined>,
  logger: RuntimeLogger,
): Promise<PreRepoEntry[]> {
  const preRepoEntries: PreRepoEntry[] = [];
  for (const repoPath of repoPaths) {
    await runInit(repoPath);
    if (!configExists(repoPath)) {
      throw new Error(`Config is not set up for ${repoPath}. Run autocatalyst init --repo ${repoPath}`);
    }
    const loaded = loadConfigFromPath(repoPath, env);
    const { resolved, missing } = resolveEnvVars(loaded.config as Record<string, unknown>, env);
    if (missing.length > 0) {
      logger.warn({ event: 'config.env_missing', repo_path: repoPath, missing }, `Missing env vars for ${repoPath}: ${missing.join(', ')}`);
      throw new Error(`Missing env vars for ${repoPath}: ${missing.join(', ')}`);
    }
    const config = resolved as WorkflowConfig;
    const normalizedConfig = normalizeWorkflowConfig(config);
    const slackChannelConfig = findConfiguredProvider(
      normalizedConfig.channels,
      createBuiltInExtensionRegistry(),
      'channel',
      'slack',
    );
    if (!slackChannelConfig?.name) {
      throw new Error(`channels[] provider "slack" requires name in ${repoPath}/autocatalyst.yaml`);
    }
    preRepoEntries.push({
      channel_name: slackChannelConfig.name,
      repo_url: resolveRepoUrl(repoPath, logger),
      workspace_root: slackChannelConfig.workspace_root ?? normalizedConfig.workspace_root ?? '~/.autocatalyst/workspaces',
    });
  }
  return preRepoEntries;
}

async function buildArtifactDeps(options: {
  app: App;
  currentConfig: LoadedConfig;
  env: Record<string, string | undefined>;
  logger: RuntimeLogger;
  normalizedConfig: ReturnType<typeof normalizeWorkflowConfig>;
  builtInExtensions: BuiltInExtensionRegistry;
  repo_name: string;
}): Promise<{
  artifactPublisher: ArtifactPublisher;
  artifactContentSource?: ArtifactContentSource;
  feedbackSource?: FeedbackSource;
  specCommitter?: SpecCommitter;
  implFeedbackPage?: ImplementationReviewPublisher;
  commentAnchorCodec?: ArtifactCommentAnchorCodec;
}> {
  const { app, env, logger, normalizedConfig, builtInExtensions, repo_name } = options;
  const notionPublisherConfig = findConfiguredProvider(
    normalizedConfig.publishers,
    builtInExtensions,
    'publisher',
    'notion',
  );
  const notionArtifactConfig = notionPublisherConfig?.artifacts.includes('artifact')
    ? notionPublisherConfig
    : undefined;

  if (!notionArtifactConfig) {
    if (!builtInExtensions.has('publisher', 'slack_canvas')) {
      throw new Error('Built-in extension is not registered: publisher:slack_canvas');
    }
    logger.info({ event: 'service.config', publisher: 'slack-canvas' }, 'Using Slack canvas publisher');
    return { artifactPublisher: new SlackCanvasPublisher(app) };
  }

  const notionToken = stringConfig(notionArtifactConfig.config, 'integration_token') ?? env['AC_NOTION_INTEGRATION_TOKEN'];
  if (!notionToken) {
    throw new Error('publishers[] provider "notion" requires config.integration_token or AC_NOTION_INTEGRATION_TOKEN');
  }
  const specsDatabaseId = stringConfig(notionArtifactConfig.config, 'specs_database_id');
  const testingGuidesDatabaseId = stringConfig(notionArtifactConfig.config, 'testing_guides_database_id');
  if (!specsDatabaseId || !testingGuidesDatabaseId) {
    throw new Error('publishers[] provider "notion" requires config.specs_database_id and config.testing_guides_database_id');
  }

  const notionClient = new NotionClientImpl({ integration_token: notionToken });
  let botUser: { id: string };
  try {
    botUser = await notionClient.users.me();
  } catch (err) {
    logger.error({ event: 'notion.auth_failed', error: String(err) }, 'Failed to detect Notion bot user. Check AC_NOTION_INTEGRATION_TOKEN permissions.');
    throw err;
  }

  logger.info({ event: 'service.config', bot_user_id: botUser.id }, 'Detected Notion bot user ID');
  const notionPublisher = new NotionPublisher(notionClient, specsDatabaseId, { repo_name });
  logger.info({ event: 'service.config', publisher: 'notion' }, 'Using Notion publisher');
  return {
    artifactPublisher: notionPublisher,
    artifactContentSource: notionPublisher,
    feedbackSource: new NotionFeedbackSource(notionClient, { bot_user_id: botUser.id }),
    specCommitter: new NotionSpecCommitter(notionPublisher),
    implFeedbackPage: new NotionImplementationFeedbackPage(notionClient, testingGuidesDatabaseId),
    commentAnchorCodec: new NotionCommentAnchorCodec(),
  };
}
