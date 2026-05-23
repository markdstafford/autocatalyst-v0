import { describe, expect, it, vi } from 'vitest';
import { ImplementationStartHandler } from '../../../src/core/handlers/implementation-start-handler.js';
import type { ThreadMessage } from '../../../src/types/events.js';
import type { Run } from '../../../src/types/runs.js';
import { TEST_CHANNEL, TEST_CONVERSATION, TEST_ORIGIN } from '../../helpers/channel-refs.js';
import type { ImplementationReviewCoordinator } from '../../../src/core/ai/implementation-review-coordinator.js';
import type { ImplementationReviewExchange } from '../../../src/types/ai.js';

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
      { run_id: 'run-001', request_id: 'request-001' },
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
      { run_id: 'run-001', request_id: 'request-001' },
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
    });
    expect(run.stage).toBe('reviewing_implementation');
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

  it('proceeds normally without coordinator when not configured', async () => {
    const { handler, deps } = makeHandler({ reviewCoordinator: undefined });
    const run = makeRun();
    const result = await handler.handle(run, makeFeedback());
    expect(result).toEqual({ status: 'reviewing_implementation' });
    expect(deps.implFeedbackPage?.create).toHaveBeenCalled();
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
});
