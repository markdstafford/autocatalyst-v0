// src/core/orchestrator.ts
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type pino from 'pino';
import type { Meter, Counter, Histogram } from '@opentelemetry/api';
import { metrics } from '@opentelemetry/api';
import { createLogger } from './logger.js';
import type { ChannelAdapter } from '../adapters/channel-adapter.js';
import { channelKey, type ConversationRef, type MessageRef } from '../types/channel.js';
import type { WorkspaceManager } from './workspace-manager.js';
import type { ArtifactAuthoringAgent, ImplementationAgent, ImplementationPlanningAgent, QuestionAnsweringAgent } from '../types/ai.js';
import type { ArtifactContentSource, ArtifactPublisher } from '../types/publisher.js';
import type { Run, RunStage, RequestIntent } from '../types/runs.js';
import { VALID_RUN_STAGES } from '../types/runs.js';
import type { Request, InboundEvent } from '../types/events.js';
import type { FeedbackSource } from '../types/feedback-source.js';
import type { IntentClassifier, ClassificationContext, Intent } from '../types/intent.js';
import type { ArtifactLifecyclePolicy, ArtifactKind } from '../types/artifact.js';
import type { SpecCommitter } from './spec-committer.js';
import type { ImplementationReviewPublisher } from '../types/impl-feedback-page.js';
import type { PRManager, IssueManager } from '../types/issue-tracker.js';
import type { PRTitleGenerator } from './ai/pr-title-generator.js';
import type { IssueFiler } from '../types/issue-filing.js';
import { RunStore, FileRunStore } from './run-store.js';
import type { CommandRegistry, CommandEvent } from '../types/commands.js';
import type { ChannelRepoMap } from '../types/config.js';
import type { HandlerRegistry } from './handler-registry.js';
import { buildDefaultHandlerRegistry as buildDefaultHandlers } from './default-handler-registry.js';
import type { BranchGuard } from './git-branch-guard.js';
import type { ImplementationReviewCoordinator } from './ai/implementation-review-coordinator.js';
import type { SpecReviewCoordinator } from './ai/spec-review-coordinator.js';
import { clearAgentRequestContext, isAiActiveStage } from './run-ai-context.js';
import { extractIssueReference, buildEnrichedClassificationMessage } from './issue-reference.js';
import type { RunJournal } from './journal/run-journal.js';
import type { AgentProfile } from '../types/ai.js';

/** Maps an actionable review stage to the in-progress stage that prevents duplicate dispatch. */
function stageAfterApproval(stage: RunStage): RunStage {
  if (stage === 'reviewing_spec') return 'planning';
  if (stage === 'awaiting_planning_input') return 'planning';
  if (stage === 'reviewing_implementation') return 'implementing';
  if (stage === 'awaiting_impl_input') return 'implementing';
  return stage;
}

function toRequestIntent(intent: Intent): RequestIntent | undefined {
  if (intent === 'idea' || intent === 'bug' || intent === 'chore' || intent === 'file_issues' || intent === 'question') {
    return intent;
  }
  return undefined;
}

const CLASSIFICATION_UNAVAILABLE_MESSAGE =
  'I could not classify that message because the AI service is unavailable. Please try again shortly.';

export interface Orchestrator {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface OrchestratorDeps {
  adapter: ChannelAdapter;
  workspaceManager: WorkspaceManager;
  artifactAuthoringAgent: ArtifactAuthoringAgent;
  artifactPublisher: ArtifactPublisher;
  artifactContentSource?: ArtifactContentSource;
  artifactPolicies?: Record<ArtifactKind, ArtifactLifecyclePolicy>;
  feedbackSource?: FeedbackSource;
  intentClassifier?: IntentClassifier;
  questionAnswerer?: QuestionAnsweringAgent;
  specCommitter?: SpecCommitter;
  implementationPlanner?: ImplementationPlanningAgent;
  implementer?: ImplementationAgent;
  implFeedbackPage?: ImplementationReviewPublisher;
  prManager?: PRManager;
  prTitleGenerator?: PRTitleGenerator;
  issueManager?: IssueManager;
  issueFiler?: IssueFiler;
  runStore?: RunStore;
  postError?: (conversation: ConversationRef, text: string) => Promise<void>;
  postMessage?: (conversation: ConversationRef, text: string) => Promise<void>;
  channelRepoMap: ChannelRepoMap;
  commandRegistry?: CommandRegistry;
  reacjiComplete?: string | null;
  handlerRegistry?: HandlerRegistry;
  branchGuard?: BranchGuard;
  reviewCoordinator?: ImplementationReviewCoordinator;
  specReviewCoordinator?: SpecReviewCoordinator;
  validatePlanPath?: (workspacePath: string, planPath: string) => string;
  autoPruneWorkspace?: boolean;
  workspacePruner?: import('./workspace-pruner.js').WorkspacePruner;
  journal?: RunJournal;
}

interface OrchestratorOptions {
  logDestination?: pino.DestinationStream;
  maxConcurrentRuns?: number; // default: 5
  meter?: Meter;
}

export class OrchestratorImpl implements Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly logger: pino.Logger;
  private readonly runs = new Map<string, Run>();
  private _stopping = false;
  private _loopPromise: Promise<void> = Promise.resolve();
  private _inFlight = new Set<Promise<void>>();
  private _queue: InboundEvent[] = [];
  private readonly _maxConcurrentRuns: number;
  /** Maps request_id → the run stage that was current when _classify dispatched the event.
   *  Stored before _classify advances the stage; read and deleted by _handleRequest for routing. */
  private _pendingStage = new Map<string, RunStage>();
  /** Maps queued InboundEvent reference → enqueue timestamp (ms) for queue_wait_ms metric. */
  private _queueTimestamps = new Map<InboundEvent, number>();
  private readonly _runLogs = new Map<string, string[]>();
  private readonly handlerRegistry: HandlerRegistry;
  private readonly _runStarted: Counter;
  private readonly _runCompleted: Counter;
  private readonly _stageDuration: Histogram;
  private readonly _stageStartTimes = new Map<string, number>();

  constructor(deps: OrchestratorDeps, options?: OrchestratorOptions) {
    this.deps = deps;
    this.logger = createLogger('orchestrator', { destination: options?.logDestination });
    this._maxConcurrentRuns = options?.maxConcurrentRuns ?? 5;
    const meter = options?.meter ?? metrics.getMeter('autocatalyst');
    this._runStarted = meter.createCounter('autocatalyst.run.started', {
      unit: '{run}',
      description: 'Number of runs started',
    });
    this._runCompleted = meter.createCounter('autocatalyst.run.completed', {
      unit: '{run}',
      description: 'Number of runs completed',
    });
    this._stageDuration = meter.createHistogram('autocatalyst.stage.duration', {
      unit: 'ms',
      description: 'Duration of each stage transition',
    });
    this.handlerRegistry = deps.handlerRegistry ?? this.buildDefaultHandlerRegistry();
    if (deps.runStore) {
      const loaded = deps.runStore.load();
      for (const run of loaded) {
        this.runs.set(run.request_id, run);
        if (run.conversation) {
          deps.adapter.registerConversation?.(run.conversation, run.request_id);
        }
      }
      if (deps.runStore instanceof FileRunStore && deps.runStore.demotedIds.size > 0) {
        const demotedRuns = [...deps.runStore.demotedIds]
          .map(id => this.runs.get(id))
          .filter((r): r is Run => r !== undefined);
        if (demotedRuns.length > 0) {
          setImmediate(() => this._notifyRestartFailures(demotedRuns));
        }
      }
    }
  }

  async start(): Promise<void> {
    await this.deps.adapter.start();
    this._loopPromise = this._runLoop();

    // Wrap adapter.stop so that calling it directly (e.g. in tests) also drains
    // any in-flight event handler before returning.  orch.stop() already awaits
    // _loopPromise; this ensures the same guarantee even when callers bypass it.
    const adapter = this.deps.adapter as unknown as { stop: () => Promise<void> };
    const originalStop = adapter.stop.bind(this.deps.adapter);
    adapter.stop = async () => {
      await originalStop();
      await this._loopPromise;
    };
  }

  async stop(): Promise<void> {
    this._stopping = true;
    await this.deps.adapter.stop();
    await this._loopPromise;
  }

  private async _runLoop(): Promise<void> {
    for await (const event of this.deps.adapter.receive()) {
      if (this._stopping) break;
      if (event.type === 'command') {
        this._launchCommand(event.payload);
        continue;
      }
      // Classification is serial and awaited: advances run state and commits the
      // dispatch decision before the next event is processed. Prevents duplicate
      // or conflicting dispatches for the same run (e.g., double-approval).
      const action = await this._classify(event as Exclude<InboundEvent, { type: 'command' }>);
      if (action === 'dispatch') {
        this._dispatchOrEnqueue(event as Exclude<InboundEvent, { type: 'command' }>);
      }
    }
    // Drain all in-flight handlers before resolving (including those promoted from queue)
    while (this._inFlight.size > 0) {
      await Promise.allSettled([...this._inFlight]);
    }
  }

  /**
   * Classifies an event and decides whether to dispatch a heavy handler.
   * Runs serially in the main loop — this is the deduplication gate.
   *
   * For new_request events: always returns 'dispatch'.
   * For thread_message events: checks the run's current stage. If the action is
   * valid, stores the original stage in _pendingStage (for routing in _handleRequest),
   * advances the stage atomically before returning 'dispatch' so that a concurrent
   * duplicate message sees the updated stage and is discarded.
   */
  private async _classify(event: Exclude<InboundEvent, { type: 'command' }>): Promise<'dispatch' | 'discard'> {
    if (event.type === 'new_request') {
      return 'dispatch';
    }
    // thread_message path: look up run and check stage
    const run = this.runs.get(event.payload.request_id);
    if (!run) {
      this.logger.debug({ event: 'classify.run_not_found', request_id: event.payload.request_id }, 'No run found; discarding');
      return 'discard';
    }
    const actionableStages: RunStage[] = ['reviewing_spec', 'awaiting_planning_input', 'reviewing_implementation', 'awaiting_impl_input', 'pr_open'];
    if (!actionableStages.includes(run.stage)) {
      this.logger.debug({ event: 'classify.stage_blocked', stage: run.stage }, 'Stage blocked: discarding thread_message');
      this.deps.adapter.react?.(event.payload.origin, 'ac-message-discarded').catch((err: unknown) => {
        this.logger.error(
          { event: 'adapter.react_error', error: String(err) },
          'Failed to post ac-message-discarded reaction',
        );
      });
      return 'discard';
    }
    // Store original stage for routing in _handleRequest before advancing
    this._pendingStage.set(event.payload.request_id, run.stage);
    // Advance stage here — prevents a duplicate message from also dispatching
    run.stage = stageAfterApproval(run.stage);
    this.logger.debug({ event: 'classify.dispatched', stage: run.stage }, 'Stage advanced; dispatching');
    return 'dispatch';
  }

  private _dispatchOrEnqueue(event: InboundEvent): void {
    if (this._inFlight.size >= this._maxConcurrentRuns) {
      this._queueTimestamps.set(event, Date.now());
      this._queue.push(event);
      // Notify user their request has been queued (best-effort; new_request only)
      if (event.type === 'new_request') {
        this.postMessage(event.payload.conversation,
          'The system is at capacity right now — your request has been queued and will start shortly.',
        ).catch(err => {
          this.logger.error({ event: 'run.notify_failed', error: String(err) }, 'Failed to post queue notification');
        });
      }
      this.logger.warn({ event: 'run.queued', queue_depth: this._queue.length }, 'Concurrency limit reached; event queued');
      this.logger.info({ metric: 'orchestrator.queue_depth', value: this._queue.length }, 'queue_depth gauge (enqueue)');
      return;
    }
    this._launch(event);
  }

  private _launch(event: InboundEvent): void {
    let p: Promise<void>;
    p = this._handleRequest(event)
      .catch(err => {
        this.logger.error({ event: 'run.unhandled_error', error: String(err) }, 'Unhandled error in request handler');
      })
      .finally(() => {
        this._inFlight.delete(p);
        this.logger.info({ metric: 'orchestrator.in_flight', value: this._inFlight.size }, 'in_flight gauge (release)');
        // Dequeue next event if any
        const next = this._queue.shift();
        if (next) {
          const enqueuedAt = this._queueTimestamps.get(next);
          this._queueTimestamps.delete(next);
          const waitMs = enqueuedAt !== undefined ? Date.now() - enqueuedAt : 0;
          this.logger.debug({ event: 'run.dequeued', in_flight: this._inFlight.size, queue_depth: this._queue.length }, 'Dequeued event; dispatching');
          this.logger.info({ metric: 'orchestrator.queue_wait_ms', value: waitMs }, 'queue_wait_ms histogram');
          this.logger.info({ metric: 'orchestrator.queue_depth', value: this._queue.length }, 'queue_depth gauge (dequeue)');
          this._launch(next);
        }
      });
    this._inFlight.add(p);
    this.logger.debug({ event: 'run.dispatched', in_flight: this._inFlight.size }, 'Handler dispatched');
    this.logger.info({ metric: 'orchestrator.in_flight', value: this._inFlight.size }, 'in_flight gauge (dispatch)');
  }

  private _launchCommand(event: CommandEvent): void {
    const reply = (text: string): Promise<void> =>
      this.postMessage(event.conversation, text).catch(err => {
        this.logger.error(
          { event: 'command.reply_failed', command: event.command, error: String(err) },
          'Failed to post command reply',
        );
      });

    const p: Promise<void> = (async () => {
      this.logger.info({ event: 'command.dispatched', command: event.command, author: event.author }, 'Command dispatched');
      this.logger.info({ metric: 'command.received', command: event.command }, 'command.received counter');
      if (!this.deps.commandRegistry?.has(event.command)) {
        this.logger.warn({ event: 'command.unknown', command: event.command }, 'Unknown command');
        this.logger.info({ metric: 'command.unknown' }, 'command.unknown counter');
        if (this.deps.commandRegistry?.has('help')) {
          await this.deps.commandRegistry.dispatch('help', event, reply);
        } else {
          await reply(`Unknown command \`:${event.command}:\` — use \`:ac-help:\` to see available commands.`);
        }
        return;
      }
      try {
        await this.deps.commandRegistry!.dispatch(event.command, event, reply);
        this.logger.info({ event: 'command.succeeded', command: event.command, author: event.author }, 'Command succeeded');
        this.logger.info({ metric: 'command.succeeded', command: event.command }, 'command.succeeded counter');
      } catch (err) {
        this.logger.error({ event: 'command.failed', command: event.command, error: String(err) }, 'Command handler failed');
        this.logger.info({ metric: 'command.failed', command: event.command }, 'command.failed counter');
        await reply(`Something went wrong running \`${event.command}\` — check logs.`);
      }
    })().finally(() => {
      this._inFlight.delete(p);
    });
    this._inFlight.add(p);
  }

  private async _handleRequest(event: InboundEvent): Promise<void> {
    if (event.type === 'new_request') {
      const request = event.payload;
      const requestChannelKey = channelKey(request.channel);
      if (!this.deps.channelRepoMap.has(requestChannelKey)) {
        this.logger.warn({ event: 'run.channel_unmapped', channel_ref: requestChannelKey }, 'No repo configured for channel; discarding new_request');
        return;
      }
      const run = this.createRun(request);

      // Stage 1: classify raw message in new_thread context
      let stage1Intent: Intent = 'idea';
      if (this.deps.intentClassifier) {
        const classifyTs = new Date().toISOString();
        try {
          stage1Intent = await this.deps.intentClassifier.classify(request.content, 'new_thread');
          this.captureDirectSession(run, 'intent.classify', classifyTs, 'ok');
        } catch (err) {
          this.captureDirectSession(run, 'intent.classify', classifyTs, 'failed');
          await this.handleClassificationUnavailable(run, request.conversation, err);
          return;
        }
        this.logger.debug({ event: 'intent_classification.result', run_id: run.id, intent: stage1Intent }, 'Stage 1 intent classified for new request');
      }

      // Two-stage path: work_on_issue requires issue loading then Stage 2 classification
      if (stage1Intent === 'work_on_issue') {
        this.logger.info(
          { event: 'intent_classification.work_on_issue', request_id: request.id, intent: stage1Intent },
          'Stage 1 returned work_on_issue — starting two-stage classification',
        );

        // Extract issue number from message
        const ref = extractIssueReference(request.content);
        if (!ref) {
          await this.failRun(run, request.conversation, new Error('Could not find an issue number in your request. Please include an issue number like "issue 42" or "#42".'));
          return;
        }
        this.logger.info(
          { event: 'issue_reference.extracted', request_id: request.id, issue_number: ref.number, raw: ref.raw },
          'Issue reference extracted',
        );

        // Post interim message immediately
        try {
          await this.postMessage(request.conversation, `Looking up issue #${ref.number}…`, run);
        } catch (err) {
          this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post interim issue lookup message');
        }

        // Check issueManager availability
        if (!this.deps.issueManager) {
          await this.failRun(run, request.conversation, new Error('Issue loading is not configured for this workspace. Cannot work on an existing issue.'));
          return;
        }

        // Load issue
        let issue;
        try {
          const channelEntry = this.deps.channelRepoMap.get(requestChannelKey);
          const repoUrl = channelEntry?.repo_url ?? '';
          issue = await this.deps.issueManager.getIssue(repoUrl, ref.number);
        } catch (err) {
          this.logger.error(
            { event: 'issue_reference.load_failed', request_id: request.id, issue_number: ref.number, error: String(err) },
            'Failed to load issue',
          );
          await this.failRun(run, request.conversation, new Error(`Could not load issue #${ref.number}. Please check the issue number and try again.`));
          return;
        }

        // Preliminary check: closed issues cannot be worked on
        const issueStateLower = issue.state.toLowerCase();
        if (issueStateLower === 'closed') {
          this.logger.info(
            { event: 'issue_reference.closed', request_id: request.id, issue_number: ref.number },
            'Referenced issue is closed',
          );
          await this.failRun(run, request.conversation, new Error(`Issue #${ref.number} is already closed and cannot be worked on.`));
          return;
        }

        // Link run to issue
        run.issue = ref.number;
        this._persistRuns();

        // Stage 2: classify enriched message in existing_issue context
        const enrichedMessage = buildEnrichedClassificationMessage(request.content, issue);
        let intent: Intent = 'idea';
        if (this.deps.intentClassifier) {
          const classifyTs2 = new Date().toISOString();
          try {
            intent = await this.deps.intentClassifier.classify(enrichedMessage, 'existing_issue');
            this.captureDirectSession(run, 'intent.classify', classifyTs2, 'ok');
          } catch (err) {
            this.captureDirectSession(run, 'intent.classify', classifyTs2, 'failed');
            await this.handleClassificationUnavailable(run, request.conversation, err);
            return;
          }
          this.logger.info(
            { event: 'intent_classification.issue_context', run_id: run.id, issue_number: ref.number, context: 'existing_issue', classified_intent: intent },
            'Stage 2 intent classified for existing issue',
          );
        }

        const stage2ClassificationStatus = this.deps.intentClassifier ? 'classified' : 'defaulted';
        void this.deps.journal?.captureInboundMessage(
          run,
          { content: request.content },
          intent,
          stage2ClassificationStatus,
        ).catch(() => {});

        // Post Stage 2 intent-specific acknowledgement (best-effort) — no file_issues ack here
        if (intent !== 'ignore') {
          const intentMessages: Partial<Record<string, string>> = {
            'idea': "Writing a spec — will post it here when I'm done.",
            'bug': "Working on a plan — will post it here when I'm done.",
            'chore': "Working on a plan — will post it here when I'm done.",
            'question': "On it — looking that up now.",
          };
          const intentMessage = intentMessages[intent] ?? "On it — will update here when I'm done.";
          try {
            await this.postMessage(request.conversation, intentMessage, run);
          } catch (err) {
            this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post Stage 2 intent acknowledgement');
          }
        }

        const requestIntent = toRequestIntent(intent);
        if (!requestIntent) {
          this.runs.delete(request.id);
          this._persistRuns();
          this.logger.debug({ event: 'new_request.ignored', request_id: request.id }, 'Existing issue request classified as ignore; discarding');
          return;
        }

        run.intent = requestIntent;
        this._runStarted.add(1, { intent: requestIntent });
        this._stageStartTimes.set(run.id, performance.now());
        this._persistRuns();
        const handler = this.handlerRegistry.resolve({
          event_type: 'new_request',
          stage: 'new_thread',
          intent,
        });
        if (!handler) {
          await this.failRun(run, request.conversation, new Error(`No handler registered for new_request intent ${intent}`));
          return;
        }
        await handler(event, run);
        return;
      }

      // Single-stage path: all other intents from Stage 1
      const intent = stage1Intent;
      const stage1ClassificationStatus = this.deps.intentClassifier ? 'classified' : 'defaulted';
      void this.deps.journal?.captureInboundMessage(
        run,
        { content: request.content },
        intent,
        stage1ClassificationStatus,
      ).catch(() => {});

      // Post intent-specific acknowledgement (best-effort)
      if (intent !== 'ignore') {
        const intentMessages: Partial<Record<string, string>> = {
          'idea': "Writing a spec — will post it here when I'm done.",
          'bug': "Working on a plan — will post it here when I'm done.",
          'chore': "Working on a plan — will post it here when I'm done.",
          'file_issues': "Filing this — will confirm here when I'm done.",
          'question': "On it — looking that up now.",
        };
        const intentMessage = intentMessages[intent] ?? "On it — will update here when I'm done.";
        try {
          await this.postMessage(request.conversation, intentMessage, run);
        } catch (err) {
          this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post intent acknowledgement');
        }
      }

      const requestIntent = toRequestIntent(intent);
      if (!requestIntent) {
        this.runs.delete(request.id);
        this._persistRuns();
        this.logger.debug({ event: 'new_request.ignored', request_id: request.id }, 'New request classified as ignore; discarding');
        return;
      }

      run.intent = requestIntent;
      this._runStarted.add(1, { intent: requestIntent });
      this._stageStartTimes.set(run.id, performance.now());
      this._persistRuns();
      const handler = this.handlerRegistry.resolve({
        event_type: 'new_request',
        stage: 'new_thread',
        intent,
      });
      if (!handler) {
        await this.failRun(run, request.conversation, new Error(`No handler registered for new_request intent ${intent}`));
        return;
      }
      await handler(event, run);
      return;
    }

    if (event.type === 'thread_message') {
      const feedback = event.payload;
      const run = this.runs.get(feedback.request_id);
      if (!run) {
        // Safety net: _classify already checked this
        this.logger.debug({ event: 'thread_message.discarded', request_id: feedback.request_id, reason: 'no_run' }, 'No run for request_id; discarding');
        return;
      }

      // Retrieve and clear the routing stage stored by _classify before it advanced run.stage.
      // This preserves the original stage for correct intent × stage routing below.
      const routingStage = this._pendingStage.get(feedback.request_id) ?? run.stage;
      this._pendingStage.delete(feedback.request_id);

      // _classify has already validated the stage and advanced it for deduplication.
      // Classify intent using the original (routing) stage as context.
      let intent: Intent = 'feedback';
      if (this.deps.intentClassifier) {
        const context: ClassificationContext = routingStage as ClassificationContext;
        const classifyTs3 = new Date().toISOString();
        try {
          intent = await this.deps.intentClassifier.classify(feedback.content, context);
          this.captureDirectSession(run, 'intent.classify', classifyTs3, 'ok');
        } catch (err) {
          this.captureDirectSession(run, 'intent.classify', classifyTs3, 'failed');
          void this.deps.journal?.captureInboundMessage(
            run,
            { content: feedback.content },
            null,
            'failed',
          ).catch(() => {});
          this.restoreStageAfterClassificationFailure(run, routingStage, err);
          await this.postError(feedback.conversation, CLASSIFICATION_UNAVAILABLE_MESSAGE);
          return;
        }
        this.logger.debug({ event: 'intent_classification.result', run_id: run.id, intent, stage: routingStage }, 'Intent classified');
      }

      const threadMsgClassificationStatus = this.deps.intentClassifier ? 'classified' : 'defaulted';
      void this.deps.journal?.captureInboundMessage(
        run,
        { content: feedback.content },
        intent,
        threadMsgClassificationStatus,
      ).catch(() => {});

      const handler = this.handlerRegistry.resolve({
        event_type: 'thread_message',
        stage: routingStage,
        intent,
      });
      if (handler) {
        await handler(event, run);
        return;
      }
      // 'ignore' and unregistered intents: silently discard
      this.restoreStageAfterUnroutedThreadMessage(run, routingStage, intent);
    }
  }

  private buildDefaultHandlerRegistry(): HandlerRegistry {
    return buildDefaultHandlers({
      workspaceManager: this.deps.workspaceManager,
      artifactAuthoringAgent: this.deps.artifactAuthoringAgent,
      artifactPublisher: this.deps.artifactPublisher,
      artifactContentSource: this.deps.artifactContentSource,
      artifactPolicies: this.deps.artifactPolicies,
      feedbackSource: this.deps.feedbackSource,
      questionAnswerer: this.deps.questionAnswerer,
      specCommitter: this.deps.specCommitter,
      implementationPlanner: this.deps.implementationPlanner,
      implementer: this.deps.implementer,
      implFeedbackPage: this.deps.implFeedbackPage,
      prManager: this.deps.prManager,
      prTitleGenerator: this.deps.prTitleGenerator,
      issueManager: this.deps.issueManager,
      issueFiler: this.deps.issueFiler,
      channelRepoMap: this.deps.channelRepoMap,
      reacjiComplete: this.deps.reacjiComplete,
      postMessage: (conversation, text, run) => this.postMessage(conversation, text, run),
      postError: (conversation, text) => this.postError(conversation, text),
      transition: (targetRun, stage) => this.transition(targetRun, stage),
      failRun: (targetRun, conversation, error) => this.failRun(targetRun, conversation, error),
      persist: () => this._persistRuns(),
      reactToRunMessage: (targetRun, reaction) => this.reactToRunMessage(targetRun, reaction),
      logger: this.logger,
      branchGuard: this.deps.branchGuard,
      reviewCoordinator: this.deps.reviewCoordinator,
      specReviewCoordinator: this.deps.specReviewCoordinator,
      validatePlanPath: this.deps.validatePlanPath,
      autoPruneWorkspace: this.deps.autoPruneWorkspace,
      workspacePruner: this.deps.workspacePruner,
      journal: this.deps.journal,
    });
  }

  private transition(run: Run, stage: RunStage): void {
    const from = run.stage;
    const endMs = performance.now();
    const startMs = this._stageStartTimes.get(run.id);
    if (startMs !== undefined) {
      this._stageDuration.record(endMs - startMs, {
        stage: from,
        outcome: stage === 'failed' ? 'failed' : 'success',
      });
    }
    this._stageStartTimes.set(run.id, endMs);

    run.stage = stage;
    if (!isAiActiveStage(stage)) {
      clearAgentRequestContext(run);
    }
    run.updated_at = new Date().toISOString();
    void this.deps.journal?.captureRunEvent(run, 'transition', from, stage).catch(() => {});
    this.logger.info({ event: 'run.stage_transition', run_id: run.id, request_id: run.request_id, from_stage: from, to_stage: stage }, 'Stage transition');
    this._appendRunLog(run.request_id, `[${new Date().toISOString()}] Stage: ${from} → ${stage}`);
    this._persistRuns();

    if (stage === 'done' || stage === 'failed') {
      this._runCompleted.add(1, { terminal_reason: stage });
      this._stageStartTimes.delete(run.id);
    }
  }

  private _persistRuns(): void {
    this.deps.runStore?.save(this.runs);
  }

  private async handleClassificationUnavailable(run: Run, conversation: ConversationRef, error: unknown): Promise<void> {
    this.transition(run, 'failed');
    this.logger.error(
      { event: 'intent_classification.failed', run_id: run.id, request_id: run.request_id, error: String(error) },
      'Intent classification failed',
    );
    await this.postError(conversation, CLASSIFICATION_UNAVAILABLE_MESSAGE);
  }

  private restoreStageAfterClassificationFailure(run: Run, stage: RunStage, error: unknown): void {
    const from = run.stage;
    run.stage = stage;
    run.updated_at = new Date().toISOString();
    this._pendingStage.delete(run.request_id);
    this._persistRuns();
    this.logger.error(
      { event: 'intent_classification.failed', run_id: run.id, request_id: run.request_id, from_stage: from, restored_stage: stage, error: String(error) },
      'Intent classification failed',
    );
  }

  private restoreStageAfterUnroutedThreadMessage(run: Run, stage: RunStage, intent: Intent): void {
    const from = run.stage;
    run.stage = stage;
    run.updated_at = new Date().toISOString();
    this._pendingStage.delete(run.request_id);
    this._persistRuns();
    this.logger.debug(
      { event: 'intent_classification.unrouted', run_id: run.id, request_id: run.request_id, intent, from_stage: from, restored_stage: stage },
      'Intent had no handler; restored stage after discard',
    );
  }

  private _appendRunLog(requestId: string, message: string): void {
    const logs = this._runLogs.get(requestId) ?? [];
    logs.push(message);
    if (logs.length > 20) logs.shift();
    this._runLogs.set(requestId, logs);
  }

  private _notifyRestartFailures(runs: Run[]): void {
    const message = "Server restarted while this was running. The run has been marked as failed. Reply in this thread to try again.";
    for (const run of runs) {
      if (!run.conversation) continue;
      this.postMessage(run.conversation, message, run).catch(err => {
        this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post restart notification');
      });
    }
  }

  private createRun(request: Request): Run {
    const run: Run = {
      id: randomUUID(),
      request_id: request.id,
      intent: 'idea',
      stage: 'intake',
      workspace_path: '',
      branch: '',
      artifact: undefined,
      impl_feedback_ref: undefined,
      issue: undefined,
      attempt: 0,
      pr_url: undefined,
      last_impl_result: undefined,
      channel: request.channel,
      conversation: request.conversation,
      origin: request.origin,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    // Keyed by request_id: at most one active run per request is the design invariant.
    // The event loop is sequential, so a second new_request for the same request_id
    // would not arrive until the first is fully processed.
    this.runs.set(request.id, run);
    void this.deps.journal?.captureRunEvent(run, 'created').catch(() => {});
    this._persistRuns();
    this.logger.info({ event: 'run.created', run_id: run.id, request_id: request.id }, 'Run created');
    return run;
  }

  private async failRun(run: Run, conversation: ConversationRef, error: unknown): Promise<void> {
    this.transition(run, 'failed');
    this.logger.error({ event: 'run.failed', run_id: run.id, request_id: run.request_id, error: String(error) }, 'Run failed');
    await this.postError(conversation, `Sorry, something went wrong: ${String(error)}`);
  }

  private async postMessage(conversation: ConversationRef, text: string, run?: Run): Promise<void> {
    if (this.deps.postMessage) {
      await this.deps.postMessage(conversation, text);
    } else {
      await this.deps.adapter.reply(conversation, text);
    }
    if (run && this.deps.journal) {
      void this.deps.journal.captureOutboundMessage(run, text).catch(() => {});
    }
  }

  private async postError(conversation: ConversationRef, text: string): Promise<void> {
    if (this.deps.postError) {
      await this.deps.postError(conversation, text);
      return;
    }
    await this.deps.adapter.replyError(conversation, text);
  }

  getRuns(): Map<string, Run> {
    return this.runs;
  }

  getRunLogs(requestId: string): string[] {
    return this._runLogs.get(requestId) ?? [];
  }

  getActiveRunCount(): number {
    return [...this.runs.values()].filter(r => r.stage !== 'done' && r.stage !== 'failed').length;
  }

  cancelRun(requestId: string): 'cancelled' | 'already_terminal' | 'not_found' {
    const run = this.runs.get(requestId);
    if (!run) return 'not_found';
    if (run.stage === 'done' || run.stage === 'failed') return 'already_terminal';
    this.transition(run, 'failed');
    this.logger.info({ event: 'run.cancelled', run_id: run.id, request_id: requestId }, 'Run cancelled via command');
    return 'cancelled';
  }

  overrideRunStage(requestId: string, stage: RunStage): 'updated' | 'not_found' | 'invalid_stage' {
    if (!VALID_RUN_STAGES.includes(stage)) return 'invalid_stage';
    const run = this.runs.get(requestId);
    if (!run) return 'not_found';
    run.stage = stage;
    if (!isAiActiveStage(stage)) {
      clearAgentRequestContext(run);
    }
    run.updated_at = new Date().toISOString();
    this._persistRuns();
    this.logger.info(
      { event: 'run.stage_override', run_id: run.id, request_id: requestId, stage },
      'Run stage overridden via operator command',
    );
    return 'updated';
  }

  private captureDirectSession(
    run: Run,
    task: string,
    ts_start: string,
    outcome: 'ok' | 'failed',
    profile?: AgentProfile | null,
  ): void {
    if (!this.deps.journal) return;
    const ts_end = new Date().toISOString();
    const providerName = profile?.provider ?? 'anthropic_direct';
    const runnerName: 'anthropic_direct' | 'openai_direct' = providerName === 'openai_direct' ? 'openai_direct' : 'anthropic_direct';
    void this.deps.journal.captureSession({
      run,
      ts_start,
      ts_end,
      phase: run.stage,
      step: task,
      round: 1,
      model: {
        provider: providerName,
        name: profile?.model ?? null,
      },
      inference: {
        effort: profile?.effort ?? null,
        thinking: profile?.thinking ?? null,
      },
      tokens: null,
      assistant_turns: null,
      tool_calls: null,
      tool_results: null,
      outcome,
      runner: runnerName,
    }).catch(() => {});
  }

  private async reactToRunMessage(run: Run, reaction: string): Promise<void> {
    if (!run.conversation) {
      throw new Error(`Run ${run.id} is missing conversation metadata`);
    }
    const ref: MessageRef = {
      provider: run.origin?.provider ?? run.conversation.provider,
      channel_id: run.conversation.channel_id,
      conversation_id: run.conversation.conversation_id,
      message_id: run.origin?.message_id ?? run.conversation.conversation_id,
    };
    if (this.deps.adapter.react) {
      await this.deps.adapter.react(ref, reaction);
    }
  }
}
