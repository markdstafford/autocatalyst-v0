import { describe, expect, it, vi } from 'vitest';
import { ImplementationStartHandler } from '../../../src/core/handlers/implementation-start-handler.js';
import type { ThreadMessage } from '../../../src/types/events.js';
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
    content: 'approved',
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
    stage: 'implementing',
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
    implementation_plan_path: '/ws/request-001/docs/superpowers/plans/implementation-plan.md',
    impl_feedback_ref: undefined,
    issue: undefined,
    attempt: 1,
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

function makeHandler(overrides: Partial<ConstructorParameters<typeof ImplementationStartHandler>[0]> = {}) {
  const deps = {
    implementer: {
      implement: vi.fn().mockResolvedValue({
        status: 'complete',
        summary: 'Implemented the feature successfully.',
        testing_instructions: 'npm test',
        review_summary: {
          changes: ['Added feature X', 'Wired config loader'],
          confirm: ['Feature X works', 'Config loads correctly'],
        },
        testing_steps: ['cd /ws/request-001', 'npm install', 'npm test'],
      }),
    },
    implFeedbackPage: {
      create: vi.fn().mockResolvedValue({ id: 'feedback-page-id', url: 'https://example.test/feedback-page-id' }),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    postMessage: vi.fn().mockResolvedValue(undefined),
    transition: vi.fn((run: Run, stage: Run['stage']) => { run.stage = stage; }),
    failRun: vi.fn().mockResolvedValue(undefined),
    persist: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    branchGuard: { check: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };

  return { handler: new ImplementationStartHandler(deps), deps };
}

describe('ImplementationStartHandler', () => {
  it('fails the run when starting initial implementation without a plan path', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({ implementation_plan_path: undefined });

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(
      run,
      TEST_CONVERSATION,
      expect.objectContaining({ message: 'Run missing implementation plan path for implementation' }),
    );
    expect(deps.implementer.implement).not.toHaveBeenCalled();
  });

  it('starts implementation from typed artifact refs when legacy spec fields are absent', async () => {
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

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'reviewing_implementation' });
    expect(deps.implementer.implement).toHaveBeenCalledWith(
      '/ws/request-001/context-human/specs/typed-feature.md',
      '/ws/request-001',
      undefined,
      expect.any(Function),
      expect.objectContaining({ run_id: 'run-001', request_id: 'request-001' }),
      '/ws/request-001/docs/superpowers/plans/implementation-plan.md',
    );
    expect(deps.implFeedbackPage?.create).toHaveBeenCalledWith({
      artifact_ref: 'CANVAS-TYPED',
      artifact_url: undefined,
      title: 'Typed feature',
      workspace_path: '/ws/request-001',
      branch: 'spec/request-001',
      summary: 'Implemented the feature successfully.',
      testing_instructions: 'npm test',
      review_summary: {
        changes: ['Added feature X', 'Wired config loader'],
        confirm: ['Feature X works', 'Config loads correctly'],
      },
      testing_steps: ['cd /ws/request-001', 'npm install', 'npm test'],
    });
    expect(deps.failRun).not.toHaveBeenCalled();
  });

  it('runs implementation with a progress callback and creates the implementation feedback page on completion', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun();
    const feedback = makeFeedback();

    const result = await handler.handle(run, feedback);

    expect(result).toEqual({ status: 'reviewing_implementation' });
    expect(deps.implementer.implement).toHaveBeenCalledWith(
      '/ws/request-001/context-human/specs/feature-test.md',
      '/ws/request-001',
      undefined,
      expect.any(Function),
      expect.objectContaining({ run_id: 'run-001', request_id: 'request-001' }),
      '/ws/request-001/docs/superpowers/plans/implementation-plan.md',
    );
    expect(deps.implFeedbackPage?.create).toHaveBeenCalledWith({
      artifact_ref: 'CANVAS001',
      artifact_url: undefined,
      title: 'Test',
      workspace_path: '/ws/request-001',
      branch: 'spec/request-001',
      summary: 'Implemented the feature successfully.',
      testing_instructions: 'npm test',
      review_summary: {
        changes: ['Added feature X', 'Wired config loader'],
        confirm: ['Feature X works', 'Config loads correctly'],
      },
      testing_steps: ['cd /ws/request-001', 'npm install', 'npm test'],
    });
    expect(run.impl_feedback_ref).toBe('feedback-page-id');
    expect(run.last_impl_result).toEqual({
      summary: 'Implemented the feature successfully.',
      testing_instructions: 'npm test',
      review_summary: {
        changes: ['Added feature X', 'Wired config loader'],
        confirm: ['Feature X works', 'Config loads correctly'],
      },
      testing_steps: ['cd /ws/request-001', 'npm install', 'npm test'],
    });
    expect(run.stage).toBe('reviewing_implementation');
  });

  it('onAgentRequest callback updates run fields and persists', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun();

    await handler.handle(run, makeFeedback());

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

  it('relays implementation progress to the channel without failing on post errors', async () => {
    let onProgress: ((message: string) => Promise<void>) | undefined;
    const { handler, deps } = makeHandler({
      implementer: {
        implement: vi.fn().mockImplementation(async (_spec, _workspace, _context, progress) => {
          onProgress = progress;
          return { status: 'complete', summary: 'Done', testing_instructions: 'Test' };
        }),
      },
      postMessage: vi.fn().mockRejectedValue(new Error('channel timeout')),
    });

    await handler.handle(makeRun(), makeFeedback());
    await onProgress?.('Task 3 of 7');

    expect(deps.postMessage).toHaveBeenCalledWith(TEST_CONVERSATION, 'Task 3 of 7');
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'progress_failed', phase: 'implementation', run_id: 'run-001' }),
      'Failed to post progress update',
    );
  });

  it('updates an existing implementation feedback page to in progress before running', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({ impl_feedback_ref: 'existing-page-id' });

    await handler.handle(run, makeFeedback());

    expect(deps.implFeedbackPage?.updateStatus).toHaveBeenCalledWith('existing-page-id', 'in_progress');
  });

  it('asks for more input when the implementer needs clarification', async () => {
    const { handler, deps } = makeHandler({
      implementer: {
        implement: vi.fn().mockResolvedValue({ status: 'needs_input', question: 'Which approach do you prefer?' }),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'needs_input' });
    expect(deps.postMessage).toHaveBeenCalledWith(TEST_CONVERSATION, expect.stringContaining('Which approach do you prefer?'));
    expect(deps.implFeedbackPage?.create).not.toHaveBeenCalled();
    expect(run.stage).toBe('awaiting_impl_input');
  });

  it('fails the run when the implementer fails', async () => {
    const { handler, deps } = makeHandler({
      implementer: {
        implement: vi.fn().mockResolvedValue({ status: 'failed', error: 'agent crashed' }),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, expect.any(Error));
    expect(deps.implFeedbackPage?.create).not.toHaveBeenCalled();
  });

  it('passes workspace_path and branch to implFeedbackPage.create()', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun();

    await handler.handle(run, makeFeedback());

    expect(deps.implFeedbackPage?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_path: '/ws/request-001',
        branch: 'spec/request-001',
      }),
    );
  });

  it('maps review_summary and testing_steps from result into ImplementationReviewInput', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun();

    await handler.handle(run, makeFeedback());

    expect(deps.implFeedbackPage?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        review_summary: {
          changes: ['Added feature X', 'Wired config loader'],
          confirm: ['Feature X works', 'Config loads correctly'],
        },
        testing_steps: ['cd /ws/request-001', 'npm install', 'npm test'],
      }),
    );
  });

  it('falls back to legacy fields when structured fields are omitted and logs review_contract_legacy', async () => {
    const { handler, deps } = makeHandler({
      implementer: {
        implement: vi.fn().mockResolvedValue({
          status: 'complete',
          summary: 'Legacy summary.',
          testing_instructions: 'Legacy instructions.',
        }),
      },
    });
    const run = makeRun();

    await handler.handle(run, makeFeedback());

    expect(deps.implFeedbackPage?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: 'Legacy summary.',
        testing_instructions: 'Legacy instructions.',
        review_summary: undefined,
        testing_steps: undefined,
      }),
    );
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'implementation.review_contract_legacy', run_id: 'run-001' }),
      expect.any(String),
    );
  });

  it('fails the run when the implementation agent changes branches', async () => {
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
    expect(deps.implFeedbackPage?.create).not.toHaveBeenCalled();
  });

  it('continues in degraded mode when feedback page creation or completion notification fails', async () => {
    const { handler, deps } = makeHandler({
      implFeedbackPage: {
        create: vi.fn().mockRejectedValue(new Error('review page creation failed')),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
      postMessage: vi.fn().mockRejectedValue(new Error('channel failed')),
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'reviewing_implementation' });
    expect(deps.failRun).not.toHaveBeenCalled();
    expect(run.stage).toBe('reviewing_implementation');
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.feedback_page_failed', run_id: 'run-001' }),
      'Failed to create implementation feedback page; continuing in degraded state',
    );
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.notify_failed', run_id: 'run-001' }),
      'Failed to post completion notification',
    );
  });
});

describe('ImplementationStartHandler with reviewCoordinator', () => {
  it('calls coordinator after complete implementation before creating testing guide', async () => {
    const exchange = makeReviewExchange();
    const coord: Pick<ImplementationReviewCoordinator, 'runInitialReview'> = {
      runInitialReview: vi.fn().mockImplementation(async ({ run }: { run: Run }) => {
        run.review_exchanges = [...(run.review_exchanges ?? []), exchange];
        return {
          status: 'complete',
          summary: 'Implemented the feature successfully.',
          testing_instructions: 'npm test',
          review_summary: { changes: ['Added feature X', 'Wired config loader'], confirm: ['Feature X works', 'Config loads correctly'] },
          testing_steps: ['cd /ws/request-001', 'npm install', 'npm test'],
        };
      }),
    };
    const { handler, deps } = makeHandler({ reviewCoordinator: coord });
    const run = makeRun();
    await handler.handle(run, makeFeedback());
    expect(coord.runInitialReview).toHaveBeenCalledWith(expect.objectContaining({
      run,
      artifact_path: '/ws/request-001/context-human/specs/feature-test.md',
    }));
    expect(deps.implFeedbackPage?.create).toHaveBeenCalledWith(
      expect.objectContaining({ review_exchanges: [exchange] }),
    );
  });

  it('stores structured fields from the reviewed implementation result', async () => {
    const coord: Pick<ImplementationReviewCoordinator, 'runInitialReview'> = {
      runInitialReview: vi.fn().mockResolvedValue({
        status: 'complete',
        summary: 'Reviewed summary.',
        testing_instructions: 'Reviewed legacy instructions.',
        review_summary: {
          changes: ['Kept generated PR data', 'Stored review checklist'],
          confirm: ['PR body has summary bullets', 'PR body has verification checklist'],
        },
        testing_steps: ['cd /ws/request-001', 'npm test -- pr-manager'],
      }),
    };
    const { handler } = makeHandler({ reviewCoordinator: coord });
    const run = makeRun();

    await handler.handle(run, makeFeedback());

    expect(run.last_impl_result).toEqual({
      summary: 'Reviewed summary.',
      testing_instructions: 'Reviewed legacy instructions.',
      review_summary: {
        changes: ['Kept generated PR data', 'Stored review checklist'],
        confirm: ['PR body has summary bullets', 'PR body has verification checklist'],
      },
      testing_steps: ['cd /ws/request-001', 'npm test -- pr-manager'],
    });
  });

  it('transitions to awaiting_impl_input when coordinator returns needs_input', async () => {
    const coord: Pick<ImplementationReviewCoordinator, 'runInitialReview'> = {
      runInitialReview: vi.fn().mockResolvedValue({ status: 'needs_input', question: 'Which approach?' }),
    };
    const { handler, deps } = makeHandler({ reviewCoordinator: coord });
    const run = makeRun();
    const result = await handler.handle(run, makeFeedback());
    expect(result).toEqual({ status: 'needs_input' });
    expect(deps.implFeedbackPage?.create).not.toHaveBeenCalled();
  });

  it('fails run when coordinator returns failed', async () => {
    const coord: Pick<ImplementationReviewCoordinator, 'runInitialReview'> = {
      runInitialReview: vi.fn().mockResolvedValue({ status: 'failed', error: 'review crashed' }),
    };
    const { handler, deps } = makeHandler({ reviewCoordinator: coord });
    const run = makeRun();
    const result = await handler.handle(run, makeFeedback());
    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalled();
  });

  it('fails run when coordinator returns non-convergence failed result', async () => {
    const coord: Pick<ImplementationReviewCoordinator, 'runInitialReview'> = {
      runInitialReview: vi.fn().mockResolvedValue({
        status: 'failed',
        error: 'Implementation review initial did not converge after 2 rounds',
      }),
    };
    const { handler, deps } = makeHandler({ reviewCoordinator: coord });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalled();
    expect(deps.implFeedbackPage?.create).not.toHaveBeenCalled();
    expect(deps.postMessage).not.toHaveBeenCalledWith(
      TEST_CONVERSATION,
      expect.stringContaining('Implementation complete'),
    );
  });

  it('proceeds normally without coordinator when not configured', async () => {
    const { handler, deps } = makeHandler({ reviewCoordinator: undefined });
    const run = makeRun();
    const result = await handler.handle(run, makeFeedback());
    expect(result).toEqual({ status: 'reviewing_implementation' });
    expect(deps.implFeedbackPage?.create).toHaveBeenCalled();
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
    const run = makeRun();

    await handler.handle(run, makeFeedback());

    expect(capturedOnAgentRequest).toBeDefined();
    capturedOnAgentRequest?.({ model: 'claude-opus-4-7', requested_at: '2026-01-02T00:00:00.000Z', route: { task: 'implementation.review.initial' } });
    expect(run.current_model).toBe('claude-opus-4-7');
    expect(run.last_agent_request_at).toBe('2026-01-02T00:00:00.000Z');
    expect(deps.persist).toHaveBeenCalled();
  });

  it('posts a labeled testing-guide link when PublishedImplementationReview includes label and url', async () => {
    const { handler, deps } = makeHandler({
      implFeedbackPage: {
        create: vi.fn().mockResolvedValue({
          id: 'feedback-page-id',
          url: 'https://example.test/feedback-page-id',
          label: 'View testing guide',
        }),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
    });
    const run = makeRun();
    await handler.handle(run, makeFeedback());
    expect(deps.postMessage).toHaveBeenCalledWith(
      TEST_CONVERSATION,
      'Implementation complete. View testing guide — https://example.test/feedback-page-id',
    );
  });

  it('falls back to url-only completion message when label is absent from PublishedImplementationReview', async () => {
    const { handler, deps } = makeHandler({
      implFeedbackPage: {
        create: vi.fn().mockResolvedValue({
          id: 'feedback-page-id',
          url: 'https://example.test/feedback-page-id',
        }),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
    });
    const run = makeRun();
    await handler.handle(run, makeFeedback());
    expect(deps.postMessage).toHaveBeenCalledWith(
      TEST_CONVERSATION,
      'Implementation complete. Feedback page: https://example.test/feedback-page-id',
    );
  });

  it('calls runLayeredImplementation when convergencePolicy enables a layered depth', async () => {
    const coord = {
      runInitialReview: vi.fn().mockResolvedValue({ status: 'complete', summary: 'unused', testing_instructions: 'unused' }),
      runLayeredImplementation: vi.fn().mockResolvedValue({
        status: 'complete',
        summary: 'Layered done.',
        testing_instructions: 'npm test',
      }),
    };
    const { handler } = makeHandler({
      reviewCoordinator: coord,
      convergencePolicy: {
        enabled: true,
        allow_same_model: false,
        depth: 'layout',
        feedback_depth: 'build_only',
        max_model_sessions_per_run: 24,
      },
    });
    await handler.handle(makeRun(), makeFeedback());
    expect(coord.runLayeredImplementation).toHaveBeenCalledWith(
      expect.objectContaining({ artifact_path: '/ws/request-001/context-human/specs/feature-test.md' }),
      { altitudes: ['layout', 'build'] },
    );
    expect(coord.runInitialReview).not.toHaveBeenCalled();
  });

  it('calls runInitialReview when convergencePolicy is build_only', async () => {
    const coord = {
      runInitialReview: vi.fn().mockResolvedValue({ status: 'complete', summary: 'unused', testing_instructions: 'unused' }),
      runLayeredImplementation: vi.fn().mockResolvedValue({ status: 'complete', summary: 'unused', testing_instructions: 'unused' }),
    };
    const { handler } = makeHandler({
      reviewCoordinator: coord,
      convergencePolicy: {
        enabled: true,
        allow_same_model: false,
        depth: 'build_only',
        feedback_depth: 'build_only',
        max_model_sessions_per_run: 24,
      },
    });
    await handler.handle(makeRun(), makeFeedback());
    expect(coord.runInitialReview).toHaveBeenCalled();
    expect(coord.runLayeredImplementation).not.toHaveBeenCalled();
  });

  it('passes gate_exchanges to implFeedbackPage.create when present', async () => {
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
    const run = makeRun({ gate_exchanges: [gateExchange] });

    await handler.handle(run, makeFeedback());

    expect(deps.implFeedbackPage?.create).toHaveBeenCalledWith(
      expect.objectContaining({ gate_exchanges: [gateExchange] }),
    );
  });
});
