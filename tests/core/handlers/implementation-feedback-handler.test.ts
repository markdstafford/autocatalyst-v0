import { describe, expect, it, vi } from 'vitest';
import { ImplementationFeedbackHandler } from '../../../src/core/handlers/implementation-feedback-handler.js';
import type { ThreadMessage } from '../../../src/types/events.js';
import type { FeedbackItem } from '../../../src/types/impl-feedback-page.js';
import type { Run } from '../../../src/types/runs.js';
import { TEST_CHANNEL, TEST_CONVERSATION, TEST_ORIGIN } from '../../helpers/channel-refs.js';
import type { ImplementationReviewCoordinator } from '../../../src/core/ai/implementation-review-coordinator.js';
import type { GateReviewExchange, ImplementationReviewExchange } from '../../../src/types/ai.js';

function makeReviewExchange(overrides: Partial<ImplementationReviewExchange> = {}): ImplementationReviewExchange {
  return {
    id: 'exchange-001',
    phase: 'initial',
    created_at: new Date().toISOString(),
    implementation_profile: { profile: 'impl-agent', provider: 'claude_agent_sdk' },
    review_profile: { profile: 'review-agent', provider: 'claude_agent_sdk' },
    review_status: 'no_findings',
    review_summary: 'Looks good.',
    findings: [],
    responses: [],
    requires_human_retest: false,
    ...overrides,
  };
}

function makeFeedback(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    request_id: 'request-001',
    channel: TEST_CHANNEL,
    conversation: TEST_CONVERSATION,
    origin: TEST_ORIGIN,
    content: 'go with the subtype approach',
    author: 'U456',
    received_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-001',
    request_id: 'request-001',
    intent: 'idea',
    stage: 'reviewing_implementation',
    workspace_path: '/ws/request-001',
    branch: 'spec/request-001',
    spec_path: '/ws/request-001/context-human/specs/feature-test.md',
    publisher_ref: 'CANVAS001',
    artifact: {
      kind: 'feature_spec',
      local_path: '/ws/request-001/context-human/specs/feature-test.md',
      published_ref: { provider: 'artifact_publisher', id: 'CANVAS001' },
      status: 'approved',
    },
    impl_feedback_ref: 'feedback-page-id',
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

function makeHandler(overrides: Partial<ConstructorParameters<typeof ImplementationFeedbackHandler>[0]> = {}) {
  const deps = {
    implementer: {
      implement: vi.fn().mockResolvedValue({
        status: 'complete',
        summary: 'Fixed it',
        testing_instructions: 'npm test',
        review_summary: {
          changes: ['Resolved feedback item', 'Updated regression coverage'],
          confirm: ['Feedback no longer reproduces', 'Regression test passes'],
        },
        testing_steps: ['cd /ws/request-001', 'npm test'],
      }),
    },
    implFeedbackPage: {
      readFeedback: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
    },
    postMessage: vi.fn().mockResolvedValue(undefined),
    transition: vi.fn((run: Run, stage: Run['stage']) => { run.stage = stage; }),
    failRun: vi.fn().mockResolvedValue(undefined),
    persist: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    branchGuard: { check: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };

  return { handler: new ImplementationFeedbackHandler(deps), deps };
}

describe('ImplementationFeedbackHandler', () => {
  it('continues implementation feedback using typed artifact refs when legacy spec fields are absent', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({
      spec_path: undefined,
      publisher_ref: undefined,
      artifact: {
        kind: 'feature_spec',
        local_path: '/ws/request-001/context-human/specs/typed-feature.md',
        published_ref: { provider: 'artifact_publisher', id: 'CANVAS-TYPED' },
        status: 'approved',
      },
    });

    const result = await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(result).toEqual({ status: 'updated' });
    expect(deps.implementer.implement).toHaveBeenCalledWith(
      '/ws/request-001/context-human/specs/typed-feature.md',
      '/ws/request-001',
      expect.any(String),     // additionalContext
      expect.any(Function),   // onProgress
      expect.objectContaining({ run_id: 'run-001', request_id: 'request-001' }),
    );
    expect(deps.failRun).not.toHaveBeenCalled();
  });

  it('reads unresolved feedback page items and passes them as implementation context', async () => {
    const feedbackItems: FeedbackItem[] = [
      { id: 'item-1', text: 'Fix the bug', resolved: false, conversation: ['Some context'] },
      { id: 'item-2', text: 'Already done', resolved: true, conversation: [] },
    ];
    const { handler, deps } = makeHandler({
      implFeedbackPage: {
        readFeedback: vi.fn().mockResolvedValue(feedbackItems),
        update: vi.fn().mockResolvedValue(undefined),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(result).toEqual({ status: 'updated' });
    expect(deps.implFeedbackPage?.readFeedback).toHaveBeenCalledWith('feedback-page-id');
    expect(deps.implementer.implement).toHaveBeenCalledWith(
      '/ws/request-001/context-human/specs/feature-test.md',
      '/ws/request-001',
      expect.stringContaining('Fix the bug'),
      expect.any(Function),   // onProgress
      expect.objectContaining({ run_id: 'run-001', request_id: 'request-001' }),
    );
    const context = (deps.implementer.implement as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    expect(context).toContain('Some context');
    expect(context).not.toContain('Already done');
    expect(run.attempt).toBe(1);
    expect(run.last_impl_result).toEqual({
      summary: 'Fixed it',
      testing_instructions: 'npm test',
      review_summary: {
        changes: ['Resolved feedback item', 'Updated regression coverage'],
        confirm: ['Feedback no longer reproduces', 'Regression test passes'],
      },
      testing_steps: ['cd /ws/request-001', 'npm test'],
    });
    expect(run.stage).toBe('reviewing_implementation');
  });

  it('uses the channel message as context while awaiting implementation input', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({ stage: 'awaiting_impl_input' });
    const feedback = makeFeedback({ content: 'use adapter composition' });

    const result = await handler.handle(run, feedback, 'awaiting_impl_input');

    expect(result).toEqual({ status: 'updated' });
    expect(deps.implFeedbackPage?.readFeedback).not.toHaveBeenCalled();
    expect(deps.implementer.implement).toHaveBeenCalledWith(
      '/ws/request-001/context-human/specs/feature-test.md',
      '/ws/request-001',
      'use adapter composition',
      expect.any(Function),   // onProgress
      expect.objectContaining({ run_id: 'run-001', request_id: 'request-001' }),
    );
  });

  it('fails the run when feedback items cannot be read', async () => {
    const error = new Error('review read failed');
    const { handler, deps } = makeHandler({
      implFeedbackPage: {
        readFeedback: vi.fn().mockRejectedValue(error),
        update: vi.fn().mockResolvedValue(undefined),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, error);
    expect(deps.implementer.implement).not.toHaveBeenCalled();
  });

  it('asks for more input when the implementer needs clarification', async () => {
    const { handler, deps } = makeHandler({
      implementer: {
        implement: vi.fn().mockResolvedValue({ status: 'needs_input', question: 'Which refactor pattern?' }),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(result).toEqual({ status: 'needs_input' });
    expect(deps.postMessage).toHaveBeenCalledWith(TEST_CONVERSATION, expect.stringContaining('Which refactor pattern?'));
    expect(run.stage).toBe('awaiting_impl_input');
  });

  it('fails the run when the implementer fails', async () => {
    const { handler, deps } = makeHandler({
      implementer: {
        implement: vi.fn().mockResolvedValue({ status: 'failed', error: 'agent crashed' }),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, expect.any(Error));
    expect(deps.implFeedbackPage?.update).not.toHaveBeenCalled();
  });

  it('does not fail the run when updating the feedback page or notifying the channel fails', async () => {
    const { handler, deps } = makeHandler({
      implFeedbackPage: {
        readFeedback: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockRejectedValue(new Error('review update failed')),
      },
      postMessage: vi.fn().mockRejectedValue(new Error('channel failed')),
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(result).toEqual({ status: 'updated' });
    expect(deps.failRun).not.toHaveBeenCalled();
    expect(run.stage).toBe('reviewing_implementation');
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.feedback_page_update_failed', run_id: 'run-001' }),
      'Failed to update implementation feedback page; continuing in degraded state',
    );
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.notify_failed', run_id: 'run-001' }),
      'Failed to post completion notification',
    );
  });

  it('serializes unresolved feedback with [FEEDBACK_ID: ...] markers', async () => {
    const feedbackItems: FeedbackItem[] = [
      { id: 'block-id-1', text: 'Custom transform swallowed on add', resolved: false, conversation: ['I tested and it disappears'] },
      { id: 'block-id-2', text: 'Config example missing provider field', resolved: false, conversation: [] },
      { id: 'block-id-3', text: 'Already resolved', resolved: true, conversation: [] },
    ];
    const { handler, deps } = makeHandler({
      implFeedbackPage: {
        readFeedback: vi.fn().mockResolvedValue(feedbackItems),
        update: vi.fn().mockResolvedValue(undefined),
      },
    });
    const run = makeRun();

    await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    const context = (deps.implementer.implement as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    expect(context).toContain('[FEEDBACK_ID: block-id-1]');
    expect(context).toContain('Custom transform swallowed on add');
    expect(context).toContain('I tested and it disappears');
    expect(context).toContain('[FEEDBACK_ID: block-id-2]');
    expect(context).toContain('Config example missing provider field');
    expect(context).not.toContain('block-id-3');
    expect(context).not.toContain('Already resolved');
  });

  it('uses Slack message content when no unresolved feedback exists and logs feedback_empty', async () => {
    const { handler, deps } = makeHandler({
      implFeedbackPage: {
        readFeedback: vi.fn().mockResolvedValue([
          { id: 'block-1', text: 'Already done', resolved: true, conversation: [] },
        ]),
        update: vi.fn().mockResolvedValue(undefined),
      },
    });
    const run = makeRun();
    const feedback = makeFeedback({ content: 'please check the edge case' });

    await handler.handle(run, feedback, 'reviewing_implementation');

    const context = (deps.implementer.implement as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    expect(context).toBe('please check the edge case');
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'implementation.feedback_empty', run_id: 'run-001' }),
      expect.any(String),
    );
  });

  it('onAgentRequest callback updates run fields and persists', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun();

    await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    const implementCall = (deps.implementer.implement as ReturnType<typeof vi.fn>).mock.calls[0];
    const telemetry = implementCall[4] as { onAgentRequest?: (metadata: { model: string; requested_at: string; route: { task: string } }) => void };
    telemetry.onAgentRequest?.({ model: 'claude-opus-4-5', requested_at: '2026-01-01T00:00:00.000Z', route: { task: 'some.task' } });

    expect(run.current_model).toBe('claude-opus-4-5');
    expect(run.last_agent_request_at).toBe('2026-01-01T00:00:00.000Z');
    expect(deps.persist).toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.agent_request_recorded', run_id: 'run-001' }),
      expect.any(String),
    );
  });

  it('passes onProgress callback to implementer.implement() during feedback', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun();

    await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(deps.implementer.implement).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ run_id: expect.any(String) }),
    );
  });

  it('onProgress posts to Slack with the original conversation ref', async () => {
    let capturedOnProgress: ((msg: string) => Promise<void>) | undefined;
    const { handler, deps } = makeHandler({
      implementer: {
        implement: vi.fn().mockImplementation(async (_spec, _workspace, _ctx, onProgress: (msg: string) => Promise<void>) => {
          capturedOnProgress = onProgress;
          return { status: 'complete', summary: 'Done', testing_instructions: 'npm test' };
        }),
      },
    });
    const run = makeRun();

    await handler.handle(run, makeFeedback(), 'reviewing_implementation');
    await capturedOnProgress!('Reviewing 2 feedback items');

    expect(deps.postMessage).toHaveBeenCalledWith(TEST_CONVERSATION, 'Reviewing 2 feedback items');
  });

  it('onProgress postMessage failure logs progress_failed and does not fail the run', async () => {
    let capturedOnProgress: ((msg: string) => Promise<void>) | undefined;
    const { handler, deps } = makeHandler({
      implementer: {
        implement: vi.fn().mockImplementation(async (_spec, _workspace, _ctx, onProgress: (msg: string) => Promise<void>) => {
          capturedOnProgress = onProgress;
          return { status: 'complete', summary: 'Done', testing_instructions: 'npm test' };
        }),
      },
      postMessage: vi.fn().mockRejectedValue(new Error('Slack timeout')),
    });
    const run = makeRun();

    await handler.handle(run, makeFeedback(), 'reviewing_implementation');
    // Should not throw
    await expect(capturedOnProgress!('Progress message')).resolves.toBeUndefined();

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'progress_failed', phase: 'implementation_feedback', run_id: 'run-001' }),
      expect.any(String),
    );
  });

  it('calls implFeedbackPage.update() with resolved_items from the implementation result', async () => {
    const { handler, deps } = makeHandler({
      implementer: {
        implement: vi.fn().mockResolvedValue({
          status: 'complete',
          summary: 'Fixed',
          resolved_feedback_items: [
            { id: 'block-id-1', resolution_comment: 'Fixed by wiring persistence' },
          ],
        }),
      },
      implFeedbackPage: {
        readFeedback: vi.fn().mockResolvedValue([
          { id: 'block-id-1', text: 'Persistence broken', resolved: false, conversation: [] },
        ]),
        update: vi.fn().mockResolvedValue(undefined),
      },
    });
    const run = makeRun();

    await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(deps.implFeedbackPage?.update).toHaveBeenCalledWith(
      'feedback-page-id',
      expect.objectContaining({
        resolved_items: [{ id: 'block-id-1', resolution_comment: 'Fixed by wiring persistence' }],
      }),
    );
  });

  it('calls implFeedbackPage.update() with review_summary and testing_steps when present', async () => {
    const { handler, deps } = makeHandler({
      implementer: {
        implement: vi.fn().mockResolvedValue({
          status: 'complete',
          summary: 'Done',
          review_summary: {
            changes: ['Added config', 'Updated tests'],
            confirm: ['Config loads', 'Tests pass'],
          },
          testing_steps: ['cd /workspace', 'npm test'],
          resolved_feedback_items: [],
        }),
      },
    });
    const run = makeRun();

    await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(deps.implFeedbackPage?.update).toHaveBeenCalledWith(
      'feedback-page-id',
      expect.objectContaining({
        review_summary: {
          changes: ['Added config', 'Updated tests'],
          confirm: ['Config loads', 'Tests pass'],
        },
        testing_steps: ['cd /workspace', 'npm test'],
      }),
    );
  });

  it('fails the run when the feedback implementation agent changes branches', async () => {
    const branchDriftError = new Error(
      'Agent changed branches from spec/request-001 to feat/something. Autocatalyst owns run branches; this run cannot continue safely.',
    );
    const { handler, deps } = makeHandler({
      branchGuard: {
        check: vi.fn().mockRejectedValue(branchDriftError),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, expect.anything(), branchDriftError);
    expect(deps.implFeedbackPage?.update).not.toHaveBeenCalled();
  });

  it('logs review_contract_legacy warning when structured fields are absent from feedback result', async () => {
    const { handler, deps } = makeHandler({
      implementer: {
        implement: vi.fn().mockResolvedValue({
          status: 'complete',
          summary: 'Legacy only',
          testing_instructions: 'npm test',
          // no review_summary or testing_steps
        }),
      },
    });
    const run = makeRun();

    await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'implementation.review_contract_legacy', run_id: 'run-001' }),
      expect.any(String),
    );
  });

  it('passes gate_exchanges to implFeedbackPage.update when present', async () => {
    const gateExchange: GateReviewExchange = {
      id: 'gate-001',
      gate: 'initial',
      round: 1,
      created_at: new Date().toISOString(),
      proposer_profile: { profile: 'impl-agent', provider: 'claude_agent_sdk' },
      critic_profile: { profile: 'review-agent', provider: 'claude_agent_sdk' },
      review_status: 'no_findings',
      review_summary: 'Gate passed.',
      findings: [],
      responses: [],
      converged: true,
      requires_human_retest: false,
    };
    const { handler, deps } = makeHandler();
    const run = makeRun({ impl_feedback_ref: 'feedback-page-id', gate_exchanges: [gateExchange] });

    await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(deps.implFeedbackPage?.update).toHaveBeenCalledWith(
      'feedback-page-id',
      expect.objectContaining({ gate_exchanges: [gateExchange] }),
    );
  });
});

describe('ImplementationFeedbackHandler with reviewCoordinator', () => {
  it('calls coordinator after complete feedback-pass result before updating testing guide', async () => {
    const exchange = makeReviewExchange({ phase: 'initial' });
    const coord: Pick<ImplementationReviewCoordinator, 'runInitialReview'> = {
      runInitialReview: vi.fn().mockImplementation(async ({ run }: { run: Run }) => {
        run.review_exchanges = [...(run.review_exchanges ?? []), exchange];
        return {
          status: 'complete',
          summary: 'Post-review.',
          testing_steps: ['npm test'],
          review_summary: { changes: ['A'], confirm: ['B'] },
        };
      }),
    };
    const { handler, deps } = makeHandler({ reviewCoordinator: coord });
    const run = makeRun({ impl_feedback_ref: 'page-id' });
    await handler.handle(run, makeFeedback());
    expect(coord.runInitialReview).toHaveBeenCalled();
    expect(deps.implFeedbackPage?.update).toHaveBeenCalledWith(
      'page-id',
      expect.objectContaining({ review_exchanges: [exchange] }),
    );
  });

  it('stores structured fields from the reviewed feedback implementation result', async () => {
    const coord: Pick<ImplementationReviewCoordinator, 'runInitialReview'> = {
      runInitialReview: vi.fn().mockResolvedValue({
        status: 'complete',
        summary: 'Reviewed feedback pass.',
        testing_instructions: 'Reviewed feedback tests.',
        review_summary: {
          changes: ['Updated persisted result', 'Kept feedback checklist'],
          confirm: ['PR options contain changes', 'PR options contain test steps'],
        },
        testing_steps: ['cd /ws/request-001', 'npm test -- implementation-feedback-handler'],
      }),
    };
    const { handler } = makeHandler({ reviewCoordinator: coord });
    const run = makeRun({ impl_feedback_ref: 'page-id' });

    await handler.handle(run, makeFeedback());

    expect(run.last_impl_result).toEqual({
      summary: 'Reviewed feedback pass.',
      testing_instructions: 'Reviewed feedback tests.',
      review_summary: {
        changes: ['Updated persisted result', 'Kept feedback checklist'],
        confirm: ['PR options contain changes', 'PR options contain test steps'],
      },
      testing_steps: ['cd /ws/request-001', 'npm test -- implementation-feedback-handler'],
    });
  });

  it('fails run when coordinator returns non-convergence failed result', async () => {
    const coord: Pick<ImplementationReviewCoordinator, 'runInitialReview'> = {
      runInitialReview: vi.fn().mockResolvedValue({
        status: 'failed',
        error: 'Implementation review initial did not converge after 2 rounds',
      }),
    };
    const { handler, deps } = makeHandler({ reviewCoordinator: coord });
    const run = makeRun({ impl_feedback_ref: 'page-id' });

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalled();
    expect(deps.implFeedbackPage?.update).not.toHaveBeenCalled();
  });

  it('proceeds normally without coordinator when not configured', async () => {
    const { handler, deps } = makeHandler({ reviewCoordinator: undefined });
    const run = makeRun({ impl_feedback_ref: 'page-id' });
    const result = await handler.handle(run, makeFeedback());
    expect(result).toEqual({ status: 'updated' });
    expect(deps.implFeedbackPage?.update).toHaveBeenCalled();
  });

  it('passes onAgentRequest to runInitialReview so review agent updates run metadata', async () => {
    let capturedOnAgentRequest: ((metadata: { model: string; requested_at: string; route: { task: string } }) => void) | undefined;
    const coord: Pick<ImplementationReviewCoordinator, 'runInitialReview'> = {
      runInitialReview: vi.fn().mockImplementation(async (params: { onAgentRequest?: (metadata: { model: string; requested_at: string; route: { task: string } }) => void }) => {
        capturedOnAgentRequest = params.onAgentRequest;
        return { status: 'complete', summary: 'Review ok', testing_instructions: 'npm test' };
      }),
    };
    const { handler, deps } = makeHandler({ reviewCoordinator: coord });
    const run = makeRun({ impl_feedback_ref: 'page-id' });

    await handler.handle(run, makeFeedback());

    expect(capturedOnAgentRequest).toBeDefined();
    capturedOnAgentRequest?.({ model: 'claude-opus-4-7', requested_at: '2026-01-02T00:00:00.000Z', route: { task: 'implementation.review.initial' } });
    expect(run.current_model).toBe('claude-opus-4-7');
    expect(run.last_agent_request_at).toBe('2026-01-02T00:00:00.000Z');
    expect(deps.persist).toHaveBeenCalled();
  });

  it('uses feedback_depth to choose altitudes for runLayeredImplementation', async () => {
    const coord = {
      runInitialReview: vi.fn().mockResolvedValue({ status: 'complete', summary: 'unused', testing_instructions: 'unused' }),
      runLayeredImplementation: vi.fn().mockResolvedValue({ status: 'complete', summary: 'ok', testing_instructions: 'npm test' }),
    };
    const { handler } = makeHandler({
      reviewCoordinator: coord,
      convergencePolicy: {
        enabled: true,
        allow_same_model: false,
        depth: 'full',
        feedback_depth: 'layout',
        max_model_sessions_per_run: 24,
      },
    });
    await handler.handle(makeRun(), makeFeedback(), 'reviewing_implementation');
    expect(coord.runLayeredImplementation).toHaveBeenCalledWith(
      expect.any(Object),
      { altitudes: ['layout', 'build'] },
    );
    expect(coord.runInitialReview).not.toHaveBeenCalled();
  });

  it('defaults to build_only behavior when no convergencePolicy is provided', async () => {
    const coord = {
      runInitialReview: vi.fn().mockResolvedValue({ status: 'complete', summary: 'ok', testing_instructions: 'npm test' }),
      runLayeredImplementation: vi.fn().mockResolvedValue({ status: 'complete', summary: 'ok', testing_instructions: 'npm test' }),
    };
    const { handler } = makeHandler({ reviewCoordinator: coord });
    await handler.handle(makeRun(), makeFeedback(), 'reviewing_implementation');
    expect(coord.runInitialReview).toHaveBeenCalled();
    expect(coord.runLayeredImplementation).not.toHaveBeenCalled();
  });
});

describe('ImplementationFeedbackHandler model-session budget enforcement', () => {
  it('fails the run before calling implementer when max_model_sessions_per_run is 0', async () => {
    const appendSpy = vi.fn().mockResolvedValue(undefined);
    const { handler, deps } = makeHandler({
      convergencePolicy: {
        enabled: true,
        allow_same_model: false,
        depth: 'build_only',
        feedback_depth: 'build_only',
        max_model_sessions_per_run: 0,
      },
      budgetWriter: { append: appendSpy },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(result).toEqual({ status: 'failed' });
    expect(deps.implementer.implement).not.toHaveBeenCalled();
    expect(deps.failRun).toHaveBeenCalled();
  });

  it('passes an exhausted sessionBudget to the coordinator when limit is 1', async () => {
    const appendSpy = vi.fn().mockResolvedValue(undefined);
    let capturedBudget: { used(): number; limit(): number } | undefined;
    const coord = {
      runInitialReview: vi.fn().mockImplementation(async (params: { sessionBudget?: { used(): number; limit(): number } }) => {
        capturedBudget = params.sessionBudget;
        return {
          status: 'complete',
          summary: 'Reviewed ok.',
          testing_instructions: 'npm test',
        };
      }),
    };
    const { handler } = makeHandler({
      reviewCoordinator: coord,
      convergencePolicy: {
        enabled: true,
        allow_same_model: false,
        depth: 'build_only',
        feedback_depth: 'build_only',
        max_model_sessions_per_run: 1,
      },
      budgetWriter: { append: appendSpy },
    });
    const run = makeRun();

    await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(capturedBudget).toBeDefined();
    expect(capturedBudget!.used()).toBe(1);
    expect(capturedBudget!.limit()).toBe(1);
  });
});
