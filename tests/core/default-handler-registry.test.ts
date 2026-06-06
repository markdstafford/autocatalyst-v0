import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { buildDefaultHandlerRegistry } from '../../src/core/default-handler-registry.js';
import type { ThreadMessage, InboundEvent } from '../../src/types/events.js';
import type { Run } from '../../src/types/runs.js';
import { TEST_CHANNEL, TEST_CONVERSATION, TEST_ORIGIN, testChannelBinding } from '../helpers/channel-refs.js';

function makeFeedback(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    request_id: 'request-001',
    channel: TEST_CHANNEL,
    conversation: TEST_CONVERSATION,
    origin: TEST_ORIGIN,
    content: 'approved',
    author: 'U123',
    received_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-001',
    request_id: 'request-001',
    intent: 'idea',
    stage: 'reviewing_spec',
    workspace_path: '/ws/request-001',
    branch: 'spec/request-001',
    spec_path: undefined,
    publisher_ref: undefined,
    artifact: {
      kind: 'feature_spec',
      local_path: '/ws/request-001/context-human/specs/typed-feature.md',
      published_ref: { provider: 'artifact_publisher', id: 'CANVAS-TYPED' },
      status: 'waiting_on_feedback',
    },
    impl_feedback_ref: undefined,
    issue: undefined,
    attempt: 0,
    channel: TEST_CHANNEL,
    conversation: TEST_CONVERSATION,
    origin: TEST_ORIGIN,
    pr_url: undefined,
    last_impl_result: undefined,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeps() {
  return {
    workspaceManager: {
      create: vi.fn(),
      destroy: vi.fn(),
    },
    artifactAuthoringAgent: {
      create: vi.fn(),
      revise: vi.fn(),
    },
    artifactPublisher: {
      createArtifact: vi.fn(),
      updateArtifact: vi.fn(),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      setIssueLink: vi.fn().mockResolvedValue(undefined),
    },
    specCommitter: {
      commit: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    implementationPlanner: {
      plan: vi.fn().mockResolvedValue({ status: 'complete', plan_path: '/ws/request-001/docs/superpowers/plans/implementation-plan.md' }),
    },
    implementer: {
      implement: vi.fn().mockResolvedValue({
        status: 'complete',
        summary: 'Done',
        testing_instructions: 'npm test',
      }),
    },
    implFeedbackPage: {
      create: vi.fn().mockResolvedValue({ id: 'feedback-page-id', url: 'https://example.test/feedback-page-id' }),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      readFeedback: vi.fn(),
      update: vi.fn(),
      setPRLink: vi.fn(),
    },
    prManager: {
      createPR: vi.fn(),
      mergePR: vi.fn(),
    },
    issueManager: {
      writeIssue: vi.fn(),
      create: vi.fn(),
    },
    issueFiler: {
      file: vi.fn(),
    },
    channelRepoMap: new Map([
      testChannelBinding(),
    ]),
    postMessage: vi.fn().mockResolvedValue(undefined),
    postError: vi.fn().mockResolvedValue(undefined),
    transition: vi.fn((run: Run, stage: Run['stage']) => { run.stage = stage; }),
    failRun: vi.fn().mockResolvedValue(undefined),
    persist: vi.fn(),
    reactToRunMessage: vi.fn().mockResolvedValue(undefined),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    branchGuard: { check: vi.fn().mockResolvedValue(undefined) },
    validatePlanPath: vi.fn((_workspacePath: string, planPath: string) => planPath),
  };
}

describe('buildDefaultHandlerRegistry', () => {
  it('routes artifact approval through approval and implementation handlers', async () => {
    const deps = makeDeps();
    const registry = buildDefaultHandlerRegistry(deps);
    const run = makeRun();
    const feedback = makeFeedback();
    const event: InboundEvent = { type: 'thread_message', payload: feedback };

    const handler = registry.resolve({
      event_type: 'thread_message',
      stage: 'reviewing_spec',
      intent: 'approval',
    });

    expect(handler).toBeDefined();
    await handler?.(event, run);

    expect(deps.specCommitter.commit).toHaveBeenCalledWith('/ws/request-001', 'CANVAS-TYPED', '/ws/request-001/context-human/specs/typed-feature.md');
    expect(deps.implementer.implement).toHaveBeenCalledWith(
      '/ws/request-001/context-human/specs/typed-feature.md',
      '/ws/request-001',
      undefined,
      expect.any(Function),
      expect.objectContaining({ run_id: 'run-001', request_id: 'request-001' }),
      '/ws/request-001/docs/superpowers/plans/implementation-plan.md',
    );
    expect(run.stage).toBe('reviewing_implementation');
  });

  it('does not start implementation when lifecycle policy marks it unnecessary', async () => {
    const deps = {
      ...makeDeps(),
      artifactPolicies: {
        feature_spec: {
          commit_on_approval: true,
          sync_issue_on_approval: false,
          implementation_required: false,
        },
        bug_triage: {
          commit_on_approval: false,
          sync_issue_on_approval: true,
          implementation_required: true,
        },
        chore_plan: {
          commit_on_approval: false,
          sync_issue_on_approval: true,
          implementation_required: true,
        },
      },
    };
    const registry = buildDefaultHandlerRegistry(deps);
    const run = makeRun();
    const event: InboundEvent = { type: 'thread_message', payload: makeFeedback() };

    const handler = registry.resolve({
      event_type: 'thread_message',
      stage: 'reviewing_spec',
      intent: 'approval',
    });

    await handler?.(event, run);

    expect(deps.specCommitter.commit).toHaveBeenCalled();
    expect(deps.implementer.implement).not.toHaveBeenCalled();
    expect(run.stage).toBe('done');
  });

  it('re-enters planning with human context when planning previously needed input', async () => {
    const deps = makeDeps();
    const registry = buildDefaultHandlerRegistry(deps);
    const run = makeRun({ stage: 'awaiting_planning_input' });
    const feedback = makeFeedback({ content: 'Use the adapter composition path.' });
    const event: InboundEvent = { type: 'thread_message', payload: feedback };

    const handler = registry.resolve({
      event_type: 'thread_message',
      stage: 'awaiting_planning_input',
      intent: 'feedback',
    });

    expect(handler).toBeDefined();
    await handler?.(event, run);

    expect(deps.implementationPlanner.plan).toHaveBeenCalledWith(
      '/ws/request-001/context-human/specs/typed-feature.md',
      '/ws/request-001',
      expect.any(Function),
      expect.objectContaining({ run_id: 'run-001', request_id: 'request-001' }),
      'Use the adapter composition path.',
    );
    expect(deps.implementer.implement).toHaveBeenCalled();
    expect(run.implementation_plan_path).toBe('/ws/request-001/docs/superpowers/plans/implementation-plan.md');
    expect(run.stage).toBe('reviewing_implementation');
  });

  it('does not mutate or persist pr_open runs when handling non-actionable feedback', async () => {
    const deps = makeDeps();
    const registry = buildDefaultHandlerRegistry(deps);
    const run = makeRun({ stage: 'pr_open' });
    const event: InboundEvent = { type: 'thread_message', payload: makeFeedback({ content: 'another note' }) };

    const handler = registry.resolve({
      event_type: 'thread_message',
      stage: 'pr_open',
      intent: 'feedback',
    });

    await handler?.(event, run);

    expect(deps.postMessage).toHaveBeenCalledWith(TEST_CONVERSATION, 'A PR is already open — merge it or close it first.');
    expect(deps.transition).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
    expect(run.stage).toBe('pr_open');
  });

  describe('handler instrumentation', () => {
    it('logs handler.entered and handler.completed for a successful handler', async () => {
      const dest = new PassThrough();
      const lines: string[] = [];
      dest.on('data', (c: Buffer) => {
        c.toString().split('\n').filter(Boolean).forEach(l => lines.push(l));
      });
      const logger = pino({ level: 'info' }, dest);
      const deps = { ...makeDeps(), logger };
      const registry = buildDefaultHandlerRegistry(deps);
      const run = makeRun({ stage: 'pr_open' });
      const event: InboundEvent = { type: 'thread_message', payload: makeFeedback({ content: 'some note' }) };

      const handler = registry.resolve({
        event_type: 'thread_message',
        stage: 'pr_open',
        intent: 'feedback',
      });

      expect(handler).toBeDefined();
      await handler?.(event, run);

      // Flush the stream
      await new Promise<void>(resolve => dest.end(resolve));

      const parsed = lines.map(l => JSON.parse(l));
      expect(parsed.find(l => l.event === 'handler.entered')).toBeDefined();
      expect(parsed.find(l => l.event === 'handler.completed')).toBeDefined();
    });

    it('logs handler.failed when handler throws', async () => {
      const dest = new PassThrough();
      const lines: string[] = [];
      dest.on('data', (c: Buffer) => {
        c.toString().split('\n').filter(Boolean).forEach(l => lines.push(l));
      });
      const logger = pino({ level: 'info' }, dest);
      const deps = makeDeps();
      // Make workspaceManager.create throw and failRun rethrow so wrapHandler sees the error
      (deps.workspaceManager.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('workspace error'));
      (deps.failRun as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('workspace error'));
      const depsWithLogger = { ...deps, logger };

      const registry = buildDefaultHandlerRegistry(depsWithLogger);
      const run = makeRun({ stage: 'new_thread', intent: 'idea' });

      const newRequestHandler = registry.resolve({
        event_type: 'new_request',
        stage: 'new_thread',
        intent: 'idea',
      });

      const requestEvent: InboundEvent = {
        type: 'new_request',
        payload: {
          request_id: 'request-001',
          channel: run.channel,
          conversation: run.conversation,
          origin: run.origin,
          author: 'U123',
          content: 'Build me a feature',
          intent: 'idea',
          received_at: new Date().toISOString(),
        },
      };

      try {
        await newRequestHandler?.(requestEvent, run);
      } catch {
        // expected
      }

      await new Promise<void>(resolve => dest.end(resolve));

      const parsed = lines.map(l => JSON.parse(l));
      expect(parsed.find(l => l.event === 'handler.entered')).toBeDefined();
      expect(parsed.find(l => l.event === 'handler.failed')).toBeDefined();
    });

    it('includes run_id and request_id in log context', async () => {
      const dest = new PassThrough();
      const lines: string[] = [];
      dest.on('data', (c: Buffer) => {
        c.toString().split('\n').filter(Boolean).forEach(l => lines.push(l));
      });
      const logger = pino({ level: 'info' }, dest);
      const deps = { ...makeDeps(), logger };
      const registry = buildDefaultHandlerRegistry(deps);
      const run = makeRun({ stage: 'pr_open', id: 'run-xyz', request_id: 'req-xyz' });
      const event: InboundEvent = { type: 'thread_message', payload: makeFeedback() };

      const handler = registry.resolve({
        event_type: 'thread_message',
        stage: 'pr_open',
        intent: 'feedback',
      });

      await handler?.(event, run);
      await new Promise<void>(resolve => dest.end(resolve));

      const parsed = lines.map(l => JSON.parse(l));
      const entered = parsed.find(l => l.event === 'handler.entered');
      expect(entered?.run_id).toBe('run-xyz');
      expect(entered?.request_id).toBe('req-xyz');
    });
  });

  it('passes specReviewCoordinator through to artifact creation handler', async () => {
    const runSpecReview = vi.fn().mockResolvedValue({ status: 'complete', artifact_path: '/ws/request-001/spec.md' });
    const deps = {
      ...makeDeps(),
      specReviewCoordinator: { runSpecReview },
    };
    (deps.workspaceManager.create as ReturnType<typeof vi.fn>).mockResolvedValue({ workspace_path: '/ws/request-001', branch: 'spec/request-001' });
    (deps.artifactAuthoringAgent.create as ReturnType<typeof vi.fn>).mockResolvedValue({ artifact_path: '/ws/request-001/spec.md' });
    (deps.artifactPublisher.createArtifact as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'CANVAS-X', url: 'https://x' });

    const registry = buildDefaultHandlerRegistry(deps);
    const run = makeRun({ stage: 'new_thread', intent: 'idea' });

    const handler = registry.resolve({ event_type: 'new_request', stage: 'new_thread', intent: 'idea' });
    const event: InboundEvent = {
      type: 'new_request',
      payload: {
        request_id: 'request-001',
        channel: run.channel,
        conversation: run.conversation,
        origin: run.origin,
        author: 'U123',
        content: 'idea',
        intent: 'idea',
        received_at: new Date().toISOString(),
      },
    };
    await handler?.(event, run);
    expect(runSpecReview).toHaveBeenCalled();
  });

  it('passes specReviewCoordinator through to artifact feedback handler', async () => {
    const runSpecReview = vi.fn().mockResolvedValue({ status: 'complete', artifact_path: '/ws/request-001/spec.md' });
    const deps = {
      ...makeDeps(),
      specReviewCoordinator: { runSpecReview },
    };
    (deps.artifactAuthoringAgent.revise as ReturnType<typeof vi.fn>).mockResolvedValue({ comment_responses: [], page_content: '# Revised' });

    const registry = buildDefaultHandlerRegistry(deps);
    const run = makeRun();
    const event: InboundEvent = { type: 'thread_message', payload: makeFeedback({ content: 'tweak this' }) };

    const handler = registry.resolve({ event_type: 'thread_message', stage: 'reviewing_spec', intent: 'feedback' });
    await handler?.(event, run);
    expect(runSpecReview).toHaveBeenCalled();
  });

  it('passes the artifact local_path to the implementer after bug triage approval without deleting it', async () => {
    const bugLocalPath = '/ws/request-001/.autocatalyst/triage/triage-bug-login.md';
    const deps = {
      ...makeDeps(),
      artifactContentSource: {
        getContent: vi.fn().mockResolvedValue('# Bug: login broken\n\nDetails here.'),
      },
    };
    (deps.issueManager.create as ReturnType<typeof vi.fn>).mockResolvedValue({ number: 42 });

    const registry = buildDefaultHandlerRegistry(deps);
    const run = makeRun({
      intent: 'bug',
      artifact: {
        kind: 'bug_triage',
        local_path: bugLocalPath,
        published_ref: { provider: 'artifact_publisher', id: 'CANVAS-BUG' },
        status: 'waiting_on_feedback',
      },
    });
    const feedback = makeFeedback();
    const event: InboundEvent = { type: 'thread_message', payload: feedback };

    const handler = registry.resolve({
      event_type: 'thread_message',
      stage: 'reviewing_spec',
      intent: 'approval',
    });

    expect(handler).toBeDefined();
    await handler?.(event, run);

    expect(deps.implementer.implement).toHaveBeenCalledWith(
      bugLocalPath,
      '/ws/request-001',
      undefined,
      expect.any(Function),
      expect.objectContaining({ run_id: 'run-001', request_id: 'request-001' }),
      '/ws/request-001/docs/superpowers/plans/implementation-plan.md',
    );
    expect(run.stage).toBe('reviewing_implementation');
  });
});
