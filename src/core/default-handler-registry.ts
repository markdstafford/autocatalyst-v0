import { performance } from 'node:perf_hooks';
import type pino from 'pino';
import type { IssueFiler } from '../types/issue-filing.js';
import type { IssueManager, PRManager } from '../types/issue-tracker.js';
import type { PRTitleGenerator } from './ai/pr-title-generator.js';
import type { ArtifactAuthoringAgent, ImplementationAgent, ImplementationPlanningAgent, QuestionAnsweringAgent } from '../types/ai.js';
import type { Request, ThreadMessage } from '../types/events.js';
import type { ConversationRef } from '../types/channel.js';
import type { FeedbackSource } from '../types/feedback-source.js';
import type { ImplementationReviewPublisher } from '../types/impl-feedback-page.js';
import type { Intent } from '../types/intent.js';
import type { ArtifactContentSource, ArtifactPublisher } from '../types/publisher.js';
import type { ArtifactLifecyclePolicy, ArtifactKind } from '../types/artifact.js';
import type { RequestIntent, Run, RunStage } from '../types/runs.js';
import type { ChannelRepoMap } from '../types/config.js';
import type { WorkspaceManager } from './workspace-manager.js';
import type { WorkspacePruner } from './workspace-pruner.js';
import type { SpecCommitter } from './spec-committer.js';
import { HandlerRegistryImpl, type HandlerRegistry } from './handler-registry.js';
import { GitBranchGuard, type BranchGuard } from './git-branch-guard.js';
import type { ImplementationReviewCoordinator } from './ai/implementation-review-coordinator.js';
import { ArtifactCreationHandler } from './handlers/artifact-creation-handler.js';
import { ArtifactApprovalHandler, type ArtifactApprovalResult } from './handlers/artifact-approval-handler.js';
import { ArtifactFeedbackHandler } from './handlers/artifact-feedback-handler.js';
import { ImplementationStartHandler } from './handlers/implementation-start-handler.js';
import { ImplementationFeedbackHandler } from './handlers/implementation-feedback-handler.js';
import { ImplementationApprovalHandler } from './handlers/implementation-approval-handler.js';
import { PlanningHandler } from './handlers/planning-handler.js';
import { IssueFilingHandler } from './handlers/issue-filing-handler.js';
import { PrMergeHandler } from './handlers/pr-merge-handler.js';
import { QuestionHandler } from './handlers/question-handler.js';

type ArtifactCreationIntent = Extract<RequestIntent, 'idea' | 'bug' | 'chore'>;

function wrapHandler<TEvent, TRun>(
  handlerName: string,
  eventType: string,
  stage: string | undefined,
  intent: string | undefined,
  logger: Pick<pino.Logger, 'info' | 'error'>,
  fn: (event: TEvent, run: TRun) => Promise<void>,
): (event: TEvent, run: TRun) => Promise<void> {
  return async (event: TEvent, run: TRun) => {
    const run_id = (run as { id?: string }).id;
    const request_id = (run as { request_id?: string }).request_id;
    const startMs = performance.now();
    const ctx = {
      handler: handlerName,
      event_type: eventType,
      ...(stage ? { stage } : {}),
      ...(intent ? { intent } : {}),
      ...(run_id ? { run_id } : {}),
      ...(request_id ? { request_id } : {}),
    };

    logger.info({ event: 'handler.entered', ...ctx }, 'Handler entered');

    try {
      await fn(event, run);
      const duration_ms = Math.round(performance.now() - startMs);
      const runStage = (run as { stage?: string }).stage;
      const outcome = runStage === 'failed' ? 'error' : 'success';
      logger.info({ event: 'handler.completed', ...ctx, outcome, duration_ms }, 'Handler completed');
    } catch (err) {
      const duration_ms = Math.round(performance.now() - startMs);
      logger.error({ event: 'handler.failed', ...ctx, outcome: 'error', duration_ms, error: String(err) }, 'Handler failed');
      throw err;
    }
  };
}

export interface DefaultHandlerRegistryDeps {
  workspaceManager: Pick<WorkspaceManager, 'create' | 'destroy'>;
  artifactAuthoringAgent: Pick<ArtifactAuthoringAgent, 'create' | 'revise'>;
  artifactPublisher: ArtifactPublisher;
  artifactContentSource?: ArtifactContentSource;
  artifactPolicies?: Record<ArtifactKind, ArtifactLifecyclePolicy>;
  feedbackSource?: FeedbackSource;
  questionAnswerer?: QuestionAnsweringAgent;
  specCommitter?: Pick<SpecCommitter, 'commit' | 'updateStatus'>;
  implementationPlanner?: ImplementationPlanningAgent;
  implementer?: ImplementationAgent;
  implFeedbackPage?: ImplementationReviewPublisher;
  prManager?: PRManager;
  prTitleGenerator?: PRTitleGenerator;
  issueManager?: IssueManager;
  issueFiler?: IssueFiler;
  channelRepoMap: ChannelRepoMap;
  reacjiComplete?: string | null;
  postMessage: (conversation: ConversationRef, text: string) => Promise<void>;
  postError: (conversation: ConversationRef, text: string) => Promise<void>;
  transition: (run: Run, stage: RunStage) => void;
  failRun: (run: Run, conversation: ConversationRef, error: unknown) => Promise<void>;
  persist: () => void;
  reactToRunMessage: (run: Run, reaction: string) => Promise<void>;
  logger: Pick<pino.Logger, 'debug' | 'info' | 'warn' | 'error'>;
  branchGuard?: BranchGuard;
  reviewCoordinator?: ImplementationReviewCoordinator;
  validatePlanPath?: (workspacePath: string, planPath: string) => string;
  workspacePruner?: Pick<WorkspacePruner, 'prune'>;
  autoPruneWorkspace?: boolean;
}

export function buildDefaultHandlerRegistry(deps: DefaultHandlerRegistryDeps): HandlerRegistry {
  const registry = new HandlerRegistryImpl();
  const branchGuard: BranchGuard = deps.branchGuard ?? new GitBranchGuard();
  const registerNewRequest = (
    intent: RequestIntent,
    handlerName: string,
    handler: (request: Request, run: Run) => Promise<void>,
  ): void => {
    registry.register({ event_type: 'new_request', stage: 'new_thread', intent }, async (event, run) => {
      if (event.type !== 'new_request' || !run) return;
      await wrapHandler(handlerName, 'new_request', 'new_thread', intent, deps.logger, async (e, r) => {
        await handler((e as typeof event).payload, r as Run);
      })(event, run);
    });
  };
  const registerThreadMessage = (
    stage: RunStage,
    intent: Intent,
    handlerName: string,
    handler: (feedback: ThreadMessage, run: Run) => Promise<void>,
  ): void => {
    registry.register({ event_type: 'thread_message', stage, intent }, async (event, run) => {
      if (event.type !== 'thread_message' || !run) return;
      await wrapHandler(handlerName, 'thread_message', stage, intent, deps.logger, async (e, r) => {
        await handler((e as typeof event).payload, r as Run);
      })(event, run);
    });
  };

  registerNewRequest('idea', 'ArtifactCreationHandler.idea', (request, run) => startArtifactCreation(deps, branchGuard, run, request, 'idea'));
  registerNewRequest('bug', 'ArtifactCreationHandler.bug', (request, run) => startArtifactCreation(deps, branchGuard, run, request, 'bug'));
  registerNewRequest('chore', 'ArtifactCreationHandler.chore', (request, run) => startArtifactCreation(deps, branchGuard, run, request, 'chore'));
  registerNewRequest('file_issues', 'IssueFilingHandler', (request, run) => startFilingPipeline(deps, run, request));
  registerNewRequest('question', 'QuestionHandler', async (request, run) => {
    const result = await handleQuestion(deps, request.content, request.conversation, run);
    deps.transition(run, result.status === 'unavailable' ? 'failed' : 'done');
  });

  registerThreadMessage('reviewing_spec', 'feedback', 'ArtifactFeedbackHandler', (feedback, run) => handleArtifactFeedback(deps, branchGuard, feedback, run));
  registerThreadMessage('awaiting_planning_input', 'feedback', 'PlanningHandler.awaiting', async (feedback, run) => {
    const planning = await runPlanning(deps, feedback, run, feedback.content);
    if (planning.status !== 'implementing') return;
    await runImplementation(deps, branchGuard, feedback, run);
  });
  registerThreadMessage('reviewing_implementation', 'feedback', 'ImplementationFeedbackHandler.reviewing', (feedback, run) => handleImplementationFeedback(deps, branchGuard, feedback, run, 'reviewing_implementation'));
  registerThreadMessage('awaiting_impl_input', 'feedback', 'ImplementationFeedbackHandler.awaiting', (feedback, run) => handleImplementationFeedback(deps, branchGuard, feedback, run, 'awaiting_impl_input'));
  registerThreadMessage('pr_open', 'feedback', 'PrOpenFeedbackHandler', (feedback, run) => handlePrOpenFeedback(deps, feedback, run));
  registerThreadMessage('reviewing_spec', 'approval', 'ArtifactApprovalHandler', async (feedback, run) => {
    const result = await approveArtifact(deps, branchGuard, run, feedback);
    if (result.status === 'failed') return;
    if (!result.implementation_required) return;
    const planning = await runPlanning(deps, feedback, run);
    if (planning.status !== 'implementing') return;
    await runImplementation(deps, branchGuard, feedback, run);
  });
  registerThreadMessage('reviewing_implementation', 'approval', 'ImplementationApprovalHandler', (feedback, run) => handleImplementationApproval(deps, branchGuard, feedback, run));
  registerThreadMessage('pr_open', 'approval', 'PrMergeHandler', (feedback, run) => handlePrMerge(deps, feedback, run));
  registerThreadMessage('reviewing_spec', 'question', 'QuestionHandler.spec', (feedback, run) => answerQuestionAndRestoreStage(deps, feedback, run, 'reviewing_spec'));
  registerThreadMessage('awaiting_planning_input', 'question', 'PlanningHandler.awaitingQuestion', async (feedback, run) => {
    const planning = await runPlanning(deps, feedback, run, feedback.content);
    if (planning.status !== 'implementing') return;
    await runImplementation(deps, branchGuard, feedback, run);
  });
  registerThreadMessage('reviewing_implementation', 'question', 'QuestionHandler.impl', (feedback, run) => answerQuestionAndRestoreStage(deps, feedback, run, 'reviewing_implementation'));
  registerThreadMessage('awaiting_impl_input', 'question', 'QuestionHandler.awaiting', (feedback, run) => answerQuestionAndRestoreStage(deps, feedback, run, 'awaiting_impl_input'));
  registerThreadMessage('pr_open', 'question', 'QuestionHandler.pr', (feedback, run) => answerQuestionAndRestoreStage(deps, feedback, run, 'pr_open'));

  return registry;
}

async function startArtifactCreation(
  deps: DefaultHandlerRegistryDeps,
  branchGuard: BranchGuard,
  run: Run,
  request: Request,
  intent: ArtifactCreationIntent,
): Promise<void> {
  const handler = new ArtifactCreationHandler({
    workspaceManager: deps.workspaceManager,
    artifactAuthoringAgent: deps.artifactAuthoringAgent,
    artifactPublisher: deps.artifactPublisher,
    channelRepoMap: deps.channelRepoMap,
    postMessage: deps.postMessage,
    transition: deps.transition,
    failRun: deps.failRun,
    persist: deps.persist,
    logger: deps.logger,
    branchGuard,
  });
  await handler.handle(run, request, intent);
}

async function approveArtifact(
  deps: DefaultHandlerRegistryDeps,
  branchGuard: BranchGuard,
  run: Run,
  feedback: ThreadMessage,
): Promise<ArtifactApprovalResult> {
  const handler = new ArtifactApprovalHandler({
    artifactPublisher: deps.artifactPublisher,
    artifactContentSource: artifactContentSource(deps),
    artifactPolicies: deps.artifactPolicies,
    specCommitter: deps.specCommitter,
    issueManager: deps.issueManager,
    channelRepoMap: deps.channelRepoMap,
    postMessage: deps.postMessage,
    transition: deps.transition,
    failRun: deps.failRun,
    persist: deps.persist,
    logger: deps.logger,
    branchGuard,
  });
  return handler.handle(run, feedback);
}

async function handleArtifactFeedback(
  deps: DefaultHandlerRegistryDeps,
  branchGuard: BranchGuard,
  feedback: ThreadMessage,
  run: Run,
): Promise<void> {
  const handler = new ArtifactFeedbackHandler({
    artifactAuthoringAgent: deps.artifactAuthoringAgent,
    artifactPublisher: deps.artifactPublisher,
    artifactContentSource: artifactContentSource(deps),
    feedbackSource: deps.feedbackSource,
    postMessage: deps.postMessage,
    transition: deps.transition,
    failRun: deps.failRun,
    persist: deps.persist,
    logger: deps.logger,
    branchGuard,
  });
  await handler.handle(run, feedback);
}

async function runImplementation(
  deps: DefaultHandlerRegistryDeps,
  branchGuard: BranchGuard,
  feedback: ThreadMessage,
  run: Run,
  additionalContext?: string,
): Promise<void> {
  const handler = new ImplementationStartHandler({
    implementer: deps.implementer!,
    implFeedbackPage: deps.implFeedbackPage,
    postMessage: deps.postMessage,
    transition: deps.transition,
    failRun: deps.failRun,
    persist: deps.persist,
    logger: deps.logger,
    branchGuard,
    reviewCoordinator: deps.reviewCoordinator,
  });
  await handler.handle(run, feedback, additionalContext);
}

async function runPlanning(
  deps: DefaultHandlerRegistryDeps,
  feedback: ThreadMessage,
  run: Run,
  additionalContext?: string,
): Promise<Awaited<ReturnType<PlanningHandler['handle']>>> {
  if (!deps.implementationPlanner) {
    await deps.failRun(run, feedback.conversation, new Error('Implementation planner is required for planning'));
    return { status: 'failed' };
  }
  const handler = new PlanningHandler({
    planner: deps.implementationPlanner,
    postMessage: deps.postMessage,
    transition: deps.transition,
    failRun: deps.failRun,
    persist: deps.persist,
    logger: deps.logger,
    validatePlanPath: deps.validatePlanPath,
  });
  return handler.handle(run, feedback, additionalContext);
}

async function handleImplementationFeedback(
  deps: DefaultHandlerRegistryDeps,
  branchGuard: BranchGuard,
  feedback: ThreadMessage,
  run: Run,
  routingStage: RunStage,
): Promise<void> {
  const handler = new ImplementationFeedbackHandler({
    implementer: deps.implementer!,
    implFeedbackPage: deps.implFeedbackPage,
    postMessage: deps.postMessage,
    transition: deps.transition,
    failRun: deps.failRun,
    persist: deps.persist,
    logger: deps.logger,
    branchGuard,
    reviewCoordinator: deps.reviewCoordinator,
  });
  await handler.handle(run, feedback, routingStage);
}

async function handleImplementationApproval(
  deps: DefaultHandlerRegistryDeps,
  branchGuard: BranchGuard,
  feedback: ThreadMessage,
  run: Run,
): Promise<void> {
  const handler = new ImplementationApprovalHandler({
    specCommitter: deps.specCommitter,
    artifactPublisher: deps.artifactPublisher,
    prManager: deps.prManager!,
    prTitleGenerator: deps.prTitleGenerator!,
    implFeedbackPage: deps.implFeedbackPage,
    postMessage: deps.postMessage,
    transition: deps.transition,
    failRun: deps.failRun,
    persist: deps.persist,
    logger: deps.logger,
    branchGuard,
    reviewCoordinator: deps.reviewCoordinator,
  });
  await handler.handle(run, feedback);
}

async function handlePrMerge(deps: DefaultHandlerRegistryDeps, feedback: ThreadMessage, run: Run): Promise<void> {
  const handler = new PrMergeHandler({
    prManager: deps.prManager!,
    postMessage: deps.postMessage,
    transition: deps.transition,
    failRun: deps.failRun,
    reactToRunMessage: deps.reactToRunMessage,
    reacjiComplete: deps.reacjiComplete,
    logger: deps.logger,
    autoPruneWorkspace: deps.autoPruneWorkspace,
    workspacePruner: deps.workspacePruner,
    workspaceRootForRun: (run) => {
      if (!run.channel) return undefined;
      const key = `${run.channel.provider}:${run.channel.id}`;
      return deps.channelRepoMap.get(key)?.workspace_root;
    },
    persist: deps.persist,
  });
  await handler.handle(run, feedback);
}

async function startFilingPipeline(deps: DefaultHandlerRegistryDeps, run: Run, request: Request): Promise<void> {
  const handler = new IssueFilingHandler({
    workspaceManager: deps.workspaceManager,
    issueFiler: deps.issueFiler!,
    channelRepoMap: deps.channelRepoMap,
    postMessage: deps.postMessage,
    transition: deps.transition,
    failRun: deps.failRun,
    persist: deps.persist,
    reactToRunMessage: deps.reactToRunMessage,
    reacjiComplete: deps.reacjiComplete,
    logger: deps.logger,
  });
  await handler.handle(run, request);
}

async function handleQuestion(
  deps: DefaultHandlerRegistryDeps,
  content: string,
  conversation: ConversationRef,
  run: Run,
): Promise<Awaited<ReturnType<QuestionHandler['handle']>>> {
  const handler = new QuestionHandler({
    questionAnswerer: deps.questionAnswerer,
    postMessage: deps.postMessage,
    postError: deps.postError,
    persist: deps.persist,
    logger: deps.logger,
  });
  return handler.handle(content, conversation, run);
}

async function answerQuestionAndRestoreStage(
  deps: DefaultHandlerRegistryDeps,
  feedback: ThreadMessage,
  run: Run,
  stage: RunStage,
): Promise<void> {
  await handleQuestion(deps, feedback.content, feedback.conversation, run);
  deps.transition(run, stage);
}

async function handlePrOpenFeedback(
  deps: DefaultHandlerRegistryDeps,
  feedback: ThreadMessage,
  run: Run,
): Promise<void> {
  try {
    await deps.postMessage(
      feedback.conversation,
      'A PR is already open \u2014 merge it or close it first.',
    );
  } catch (err) {
    deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post pr_open feedback message');
  }
}

function artifactContentSource(deps: DefaultHandlerRegistryDeps): ArtifactContentSource | undefined {
  if (deps.artifactContentSource) return deps.artifactContentSource;
  const publisher = deps.artifactPublisher as ArtifactPublisher & Partial<ArtifactContentSource>;
  if (typeof publisher.getContent === 'function') {
    return { getContent: publisher.getContent.bind(publisher) };
  }
  return undefined;
}
