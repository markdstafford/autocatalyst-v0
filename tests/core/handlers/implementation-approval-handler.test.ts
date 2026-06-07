import { describe, expect, it, vi } from 'vitest';
import { ImplementationApprovalHandler } from '../../../src/core/handlers/implementation-approval-handler.js';
import type { ThreadMessage } from '../../../src/types/events.js';
import type { Run } from '../../../src/types/runs.js';
import { TEST_CHANNEL, TEST_CONVERSATION, TEST_ORIGIN } from '../../helpers/channel-refs.js';
import type { ImplementationReviewCoordinator } from '../../../src/core/ai/implementation-review-coordinator.js';
import type { GateReviewExchange, ImplementationResult } from '../../../src/types/ai.js';

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
    attempt: 1,
    pr_url: undefined,
    last_impl_result: {
      summary: 'Implemented it.',
      testing_instructions: 'npm test',
      review_summary: {
        changes: ['Added approval path data', 'Kept PR body fields'],
        confirm: ['Approval creates PR', 'PR body has review checklist'],
      },
      testing_steps: ['cd /ws/request-001', 'npm test'],
    },
    channel: TEST_CHANNEL,
    conversation: TEST_CONVERSATION,
    origin: TEST_ORIGIN,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeReviewCoordinator(resultOverrides: Partial<ImplementationResult> = {}): Pick<ImplementationReviewCoordinator, 'runFinalReview'> {
  const result: ImplementationResult = {
    status: 'complete',
    summary: 'Post-final-review.',
    requires_human_retest: false,
    testing_steps: ['npm test'],
    review_summary: { changes: ['A'], confirm: ['B'] },
    ...resultOverrides,
  };
  return { runFinalReview: vi.fn().mockResolvedValue(result) };
}

function makeHandler(overrides: Partial<ConstructorParameters<typeof ImplementationApprovalHandler>[0]> = {}) {
  const deps = {
    specCommitter: {
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    artifactPublisher: {
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    prManager: {
      createPR: vi.fn().mockResolvedValue('https://example.test/org/repo/pull/42'),
    },
    prTitleGenerator: {
      generate: vi.fn().mockResolvedValue('generated title'),
    },
    implFeedbackPage: {
      setPRLink: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    },
    postMessage: vi.fn().mockResolvedValue(undefined),
    transition: vi.fn((run: Run, stage: Run['stage']) => { run.stage = stage; }),
    failRun: vi.fn().mockResolvedValue(undefined),
    persist: vi.fn(),
    logger: {
      error: vi.fn(),
      info: vi.fn(),
    },
    now: () => new Date('2026-04-25T00:00:00.000Z'),
    branchGuard: { check: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };

  return { handler: new ImplementationApprovalHandler(deps), deps };
}

describe('ImplementationApprovalHandler', () => {
  it('creates the PR using typed artifact refs when legacy spec fields are absent', async () => {
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

    expect(result).toEqual({ status: 'pr_open' });
    expect(deps.specCommitter?.updateStatus).toHaveBeenCalledWith(
      '/ws/request-001',
      '/ws/request-001/context-human/specs/typed-feature.md',
      { status: 'complete', last_updated: '2026-04-25' },
    );
    expect(deps.artifactPublisher.updateStatus).toHaveBeenCalledWith('CANVAS-TYPED', 'complete');
    expect(deps.prManager.createPR).toHaveBeenCalledWith(
      '/ws/request-001',
      'spec/request-001',
      '/ws/request-001/context-human/specs/typed-feature.md',
      expect.objectContaining({ run_intent: 'idea' }),
    );
    expect(run.artifact?.status).toBe('complete');
    expect(deps.failRun).not.toHaveBeenCalled();
  });

  it('marks the artifact complete, creates a PR, stores the PR URL, and opens the PR stage', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'pr_open' });
    expect(deps.specCommitter?.updateStatus).toHaveBeenCalledWith(
      '/ws/request-001',
      '/ws/request-001/context-human/specs/feature-test.md',
      { status: 'complete', last_updated: '2026-04-25' },
    );
    expect(deps.artifactPublisher.updateStatus).toHaveBeenCalledWith('CANVAS001', 'complete');
    expect(deps.prManager.createPR).toHaveBeenCalledWith(
      '/ws/request-001',
      'spec/request-001',
      '/ws/request-001/context-human/specs/feature-test.md',
      {
        impl_result: {
          summary: 'Implemented it.',
          testing_instructions: 'npm test',
          review_summary: {
            changes: ['Added approval path data', 'Kept PR body fields'],
            confirm: ['Approval creates PR', 'PR body has review checklist'],
          },
          testing_steps: ['cd /ws/request-001', 'npm test'],
        },
        run_intent: 'idea',
        title: 'generated title',
      },
    );
    expect(run.artifact?.status).toBe('complete');
    expect(run.pr_url).toBe('https://example.test/org/repo/pull/42');
    expect(deps.postMessage).toHaveBeenCalledWith(TEST_CONVERSATION, 'PR opened: https://example.test/org/repo/pull/42');
    expect(deps.implFeedbackPage?.setPRLink).toHaveBeenCalledWith('feedback-page-id', 'https://example.test/org/repo/pull/42');
    expect(deps.implFeedbackPage?.updateStatus).toHaveBeenCalledWith('feedback-page-id', 'approved');
    expect(run.stage).toBe('pr_open');
  });

  it('continues to create the PR when spec status or publisher status updates fail', async () => {
    const { handler, deps } = makeHandler({
      specCommitter: {
        updateStatus: vi.fn().mockRejectedValue(new Error('file missing')),
      },
      artifactPublisher: {
        updateStatus: vi.fn().mockRejectedValue(new Error('publisher down')),
      },
    });

    const result = await handler.handle(makeRun(), makeFeedback());

    expect(result).toEqual({ status: 'pr_open' });
    expect(deps.prManager.createPR).toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'spec.status_update_failed', run_id: 'run-001' }),
      'Failed to update spec status to complete; continuing',
    );
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'spec.publisher_update_failed', run_id: 'run-001' }),
      'Failed to update spec publisher status to complete; continuing',
    );
  });

  it('fails the run when PR creation fails', async () => {
    const error = new Error('pr create failed');
    const { handler, deps } = makeHandler({
      prManager: {
        createPR: vi.fn().mockRejectedValue(error),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, error);
    expect(deps.postMessage).not.toHaveBeenCalledWith(TEST_CONVERSATION, expect.stringContaining('PR opened'));
  });

  it('does not fail the run when PR notification or feedback page updates fail', async () => {
    const { handler, deps } = makeHandler({
      postMessage: vi.fn().mockRejectedValue(new Error('channel failed')),
      implFeedbackPage: {
        setPRLink: vi.fn().mockRejectedValue(new Error('link failed')),
        updateStatus: vi.fn().mockRejectedValue(new Error('status failed')),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'pr_open' });
    expect(deps.failRun).not.toHaveBeenCalled();
    expect(run.stage).toBe('pr_open');
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.notify_failed', run_id: 'run-001' }),
      'Failed to post PR link',
    );
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.status_update_failed', run_id: 'run-001' }),
      'Failed to update impl feedback page on implementation approval',
    );
  });

  it('passes run.issue as issue_number to createPR when run.issue is set', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({ intent: 'bug', issue: 54 });

    await handler.handle(run, makeFeedback());

    expect(deps.prManager.createPR).toHaveBeenCalledWith(
      '/ws/request-001',
      'spec/request-001',
      expect.any(String),
      expect.objectContaining({ issue_number: 54 }),
    );
  });

  it('uses the generator-produced title when non-null', async () => {
    const { handler, deps } = makeHandler({
      prTitleGenerator: { generate: vi.fn().mockResolvedValue('short descriptive title') },
    });
    const run = makeRun({ intent: 'bug', issue: 54 });

    await handler.handle(run, makeFeedback());

    expect(deps.prTitleGenerator.generate).toHaveBeenCalledWith({
      intent: 'bug',
      spec_path: '/ws/request-001/context-human/specs/feature-test.md',
      impl_summary: 'Implemented it.',
    });
    expect(deps.prManager.createPR).toHaveBeenCalledWith(
      '/ws/request-001',
      'spec/request-001',
      expect.any(String),
      expect.objectContaining({ title: 'short descriptive title' }),
    );
  });

  it('omits title when the generator returns null', async () => {
    const { handler, deps } = makeHandler({
      prTitleGenerator: { generate: vi.fn().mockResolvedValue(null) },
    });

    await handler.handle(makeRun({ intent: 'bug' }), makeFeedback());

    const callArg = (deps.prManager.createPR as ReturnType<typeof vi.fn>).mock.calls[0][3] as Record<string, unknown>;
    expect(callArg['title']).toBeUndefined();
  });

  it('does not pass issue_number to createPR when run.issue is undefined', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({ intent: 'idea', issue: undefined });

    await handler.handle(run, makeFeedback());

    const callArg = (deps.prManager.createPR as ReturnType<typeof vi.fn>).mock.calls[0][3] as Record<string, unknown>;
    expect(callArg['issue_number']).toBeUndefined();
  });

  it('fails the run with a branch drift error before calling createPR', async () => {
    const branchDriftError = new Error(
      'Agent changed branches from spec/request-001 to feat/debug-mode-slack. Autocatalyst owns run branches; this run cannot continue safely.',
    );
    const { handler, deps } = makeHandler({
      branchGuard: {
        check: vi.fn().mockRejectedValue(branchDriftError),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, branchDriftError);
    expect(deps.prManager.createPR).not.toHaveBeenCalled();
  });

  it('succeeds normally when the branch guard confirms no drift', async () => {
    const { handler, deps } = makeHandler({
      branchGuard: {
        check: vi.fn().mockResolvedValue(undefined),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'pr_open' });
    expect(deps.prManager.createPR).toHaveBeenCalled();
  });

  it('skips specCommitter.updateStatus for bug_triage artifacts but still creates a PR and marks artifact complete', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({
      spec_path: undefined,
      publisher_ref: undefined,
      issue: 77,
      artifact: {
        kind: 'bug_triage',
        local_path: '/ws/request-001/.autocatalyst/triage/triage-bug-77.md',
        published_ref: { provider: 'artifact_publisher', id: 'CANVAS-BUG' },
        status: 'approved',
      },
    });

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'pr_open' });
    expect(deps.specCommitter?.updateStatus).not.toHaveBeenCalled();
    expect(deps.artifactPublisher.updateStatus).toHaveBeenCalledWith('CANVAS-BUG', 'complete');
    expect(deps.prManager.createPR).toHaveBeenCalledWith(
      '/ws/request-001',
      'spec/request-001',
      '/ws/request-001/.autocatalyst/triage/triage-bug-77.md',
      expect.objectContaining({ issue_number: 77 }),
    );
    expect(run.artifact?.status).toBe('complete');
    expect(run.stage).toBe('pr_open');
  });

  it('skips specCommitter.updateStatus for chore_plan artifacts but still creates a PR and marks artifact complete', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({
      spec_path: undefined,
      publisher_ref: undefined,
      issue: 88,
      artifact: {
        kind: 'chore_plan',
        local_path: '/ws/request-001/.autocatalyst/triage/triage-chore-88.md',
        published_ref: { provider: 'artifact_publisher', id: 'CANVAS-CHORE' },
        status: 'approved',
      },
    });

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'pr_open' });
    expect(deps.specCommitter?.updateStatus).not.toHaveBeenCalled();
    expect(deps.artifactPublisher.updateStatus).toHaveBeenCalledWith('CANVAS-CHORE', 'complete');
    expect(deps.prManager.createPR).toHaveBeenCalledWith(
      '/ws/request-001',
      'spec/request-001',
      '/ws/request-001/.autocatalyst/triage/triage-chore-88.md',
      expect.objectContaining({ issue_number: 88 }),
    );
    expect(run.artifact?.status).toBe('complete');
    expect(run.stage).toBe('pr_open');
  });

  it('still calls specCommitter.updateStatus for feature_spec artifacts', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({
      artifact: {
        kind: 'feature_spec',
        local_path: '/ws/request-001/context-human/specs/feature-test.md',
        published_ref: { provider: 'artifact_publisher', id: 'CANVAS001' },
        status: 'approved',
      },
    });

    await handler.handle(run, makeFeedback());

    expect(deps.specCommitter?.updateStatus).toHaveBeenCalledWith(
      '/ws/request-001',
      '/ws/request-001/context-human/specs/feature-test.md',
      { status: 'complete', last_updated: '2026-04-25' },
    );
  });
});

describe('ImplementationApprovalHandler with reviewCoordinator', () => {
  it('runs final review before PR creation', async () => {
    const coord = makeReviewCoordinator();
    const { handler, deps } = makeHandler({ reviewCoordinator: coord });
    await handler.handle(makeRun(), makeFeedback());
    const reviewCallOrder = (coord.runFinalReview as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const prCallOrder = (deps.prManager.createPR as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(reviewCallOrder).toBeLessThan(prCallOrder);
  });

  it('creates PR when final review returns complete with requires_human_retest false', async () => {
    const { handler, deps } = makeHandler({ reviewCoordinator: makeReviewCoordinator({ requires_human_retest: false }) });
    const result = await handler.handle(makeRun(), makeFeedback());
    expect(result).toEqual({ status: 'pr_open' });
    expect(deps.prManager.createPR).toHaveBeenCalled();
  });

  it('returns reviewing_implementation and does not create PR when requires_human_retest is true', async () => {
    const coord = makeReviewCoordinator({ requires_human_retest: true });
    const { handler, deps } = makeHandler({ reviewCoordinator: coord });
    const result = await handler.handle(makeRun(), makeFeedback());
    expect(result).toEqual({ status: 'reviewing_implementation' });
    expect(deps.prManager.createPR).not.toHaveBeenCalled();
    expect(deps.logger.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'implementation.review.retest_required' }),
      expect.any(String),
    );
  });

  it('transitions to awaiting_impl_input when final review returns needs_input', async () => {
    const coord = { runFinalReview: vi.fn().mockResolvedValue({ status: 'needs_input', question: 'Which?' }) };
    const { handler, deps } = makeHandler({ reviewCoordinator: coord });
    const result = await handler.handle(makeRun(), makeFeedback());
    expect(result).toEqual({ status: 'needs_input' });
    expect(deps.prManager.createPR).not.toHaveBeenCalled();
  });

  it('fails run when final review returns failed', async () => {
    const coord = { runFinalReview: vi.fn().mockResolvedValue({ status: 'failed', error: 'review crashed' }) };
    const { handler, deps } = makeHandler({ reviewCoordinator: coord });
    const result = await handler.handle(makeRun(), makeFeedback());
    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalled();
  });

  it('proceeds to PR creation without coordinator when not configured', async () => {
    const { handler, deps } = makeHandler({ reviewCoordinator: undefined });
    const result = await handler.handle(makeRun(), makeFeedback());
    expect(result).toEqual({ status: 'pr_open' });
  });

  it('onAgentRequest callback passed to runFinalReview updates run fields and persists', async () => {
    let capturedOnAgentRequest: ((metadata: { model: string; requested_at: string; route: { task: string } }) => void) | undefined;
    const coord = {
      runFinalReview: vi.fn().mockImplementation(async (params: { onAgentRequest?: (metadata: { model: string; requested_at: string; route: { task: string } }) => void }) => {
        capturedOnAgentRequest = params.onAgentRequest;
        return { status: 'complete', summary: 'Done.', requires_human_retest: false, testing_steps: ['npm test'], review_summary: { changes: ['A'], confirm: ['B'] } };
      }),
    };
    const { handler, deps } = makeHandler({ reviewCoordinator: coord });
    const run = makeRun();

    await handler.handle(run, makeFeedback());

    capturedOnAgentRequest?.({ model: 'claude-opus-4-5', requested_at: '2026-01-01T00:00:00.000Z', route: { task: 'some.task' } });

    expect(run.current_model).toBe('claude-opus-4-5');
    expect(run.last_agent_request_at).toBe('2026-01-01T00:00:00.000Z');
    expect(deps.persist).toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.agent_request_recorded', run_id: 'run-001' }),
      expect.any(String),
    );
  });

  it('passes structured implementation result fields into final review', async () => {
    const coord = makeReviewCoordinator();
    const { handler } = makeHandler({ reviewCoordinator: coord });
    const run = makeRun();

    await handler.handle(run, makeFeedback());

    expect(coord.runFinalReview).toHaveBeenCalledWith(expect.objectContaining({
      implementation_result: {
        status: 'complete',
        summary: 'Implemented it.',
        testing_instructions: 'npm test',
        review_summary: {
          changes: ['Added approval path data', 'Kept PR body fields'],
          confirm: ['Approval creates PR', 'PR body has review checklist'],
        },
        testing_steps: ['cd /ws/request-001', 'npm test'],
      },
    }));
  });

  it('stores structured fields returned by final review before creating the PR', async () => {
    const coord = makeReviewCoordinator({
      summary: 'Final reviewed summary.',
      testing_instructions: 'Final reviewed tests.',
      review_summary: {
        changes: ['Final review kept summary bullets', 'Final review kept verification items'],
        confirm: ['Summary bullets render', 'Verification checklist renders'],
      },
      testing_steps: ['cd /ws/request-001', 'npm test -- implementation-approval-handler'],
    });
    const { handler, deps } = makeHandler({ reviewCoordinator: coord });
    const run = makeRun();

    await handler.handle(run, makeFeedback());

    const expectedImplResult = {
      summary: 'Final reviewed summary.',
      testing_instructions: 'Final reviewed tests.',
      review_summary: {
        changes: ['Final review kept summary bullets', 'Final review kept verification items'],
        confirm: ['Summary bullets render', 'Verification checklist renders'],
      },
      testing_steps: ['cd /ws/request-001', 'npm test -- implementation-approval-handler'],
    };
    expect(run.last_impl_result).toEqual(expectedImplResult);
    expect(deps.prManager.createPR).toHaveBeenCalledWith(
      '/ws/request-001',
      'spec/request-001',
      '/ws/request-001/context-human/specs/feature-test.md',
      expect.objectContaining({ impl_result: expectedImplResult }),
    );
  });

  it('passes gate_exchanges to implFeedbackPage.update on final review retest path', async () => {
    const gateExchange: GateReviewExchange = {
      id: 'gate-001',
      gate: 'final',
      round: 1,
      created_at: new Date().toISOString(),
      proposer_profile: { profile: 'impl-agent', provider: 'claude_agent_sdk' },
      critic_profile: { profile: 'review-agent', provider: 'claude_agent_sdk' },
      review_status: 'no_findings',
      review_summary: 'Final gate passed.',
      findings: [],
      responses: [],
      converged: true,
      requires_human_retest: false,
    };
    const coord = makeReviewCoordinator({ requires_human_retest: true });
    const { handler, deps } = makeHandler({ reviewCoordinator: coord });
    const run = makeRun({ impl_feedback_ref: 'feedback-page-id', gate_exchanges: [gateExchange] });

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'reviewing_implementation' });
    expect(deps.implFeedbackPage?.update).toHaveBeenCalledWith(
      'feedback-page-id',
      expect.objectContaining({ gate_exchanges: [gateExchange] }),
    );
  });
});
