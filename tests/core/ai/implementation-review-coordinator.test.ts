import { describe, it, expect, vi } from 'vitest';
import { ImplementationReviewCoordinator } from '../../../src/core/ai/implementation-review-coordinator.js';
import type { AgentRunner, AgentRoutingPolicy, ImplementationAgent, ImplementationResult, ImplementationReviewResult, AgentProfile } from '../../../src/types/ai.js';
import type { Run } from '../../../src/types/runs.js';

const WORKING_DIR = '/ws/test';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-001',
    request_id: 'req-001',
    intent: 'idea',
    stage: 'implementing',
    workspace_path: WORKING_DIR,
    branch: 'spec/req-001',
    impl_feedback_ref: undefined,
    issue: undefined,
    attempt: 1,
    pr_url: undefined,
    last_impl_result: undefined,
    review_exchanges: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeCompleteResult(overrides: Partial<ImplementationResult> = {}): ImplementationResult {
  return { status: 'complete', summary: 'Done.', testing_steps: ['npm test'], review_summary: { changes: ['A'], confirm: ['B'] }, ...overrides };
}

function makeAgentProfile(name = 'review-agent'): AgentProfile {
  return { id: name, provider: 'claude_agent_sdk', model: 'claude-sonnet-4-6' };
}

function makeRoutingPolicy(initialProfile: AgentProfile | null = makeAgentProfile(), finalProfile: AgentProfile | null = null): AgentRoutingPolicy {
  return {
    resolve: vi.fn().mockImplementation((route: { task: string }) => {
      if (route.task === 'implementation.run') return makeAgentProfile('impl-agent');
      throw new Error(`No route for ${route.task}`);
    }),
    resolveOptional: vi.fn().mockImplementation((route: { task: string }) => {
      if (route.task === 'implementation.review.initial') return initialProfile;
      if (route.task === 'implementation.review.final') return finalProfile;
      if (route.task === 'implementation.run') return makeAgentProfile('impl-agent');
      return null;
    }),
  };
}

function makeRunner(): AgentRunner {
  return {
    run: vi.fn().mockReturnValue((async function* () {})()),
  };
}

function makeImplementer(result: ImplementationResult = makeCompleteResult()): Pick<ImplementationAgent, 'implement'> {
  return { implement: vi.fn().mockResolvedValue(result) };
}

function makeDeps(reviewResult: ImplementationReviewResult = { status: 'no_findings', summary: 'Looks good.', findings: [] }, overrides: Record<string, unknown> = {}) {
  const reviewJson = JSON.stringify(reviewResult);
  return {
    runner: makeRunner(),
    implementer: makeImplementer(),
    routingPolicy: makeRoutingPolicy(),
    policy: { max_initial_rounds: 1, max_final_rounds: 1, on_review_failure: 'warn' as const, retest_on_behavior_change: true },
    branchGuard: { check: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    readFile: vi.fn().mockResolvedValue(reviewJson),
    ...overrides,
  };
}

describe('ImplementationReviewCoordinator', () => {
  describe('runInitialReview — no findings', () => {
    it('appends a no_findings exchange to run.review_exchanges', async () => {
      const deps = makeDeps();
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });
      expect(run.review_exchanges).toHaveLength(1);
      expect(run.review_exchanges![0].review_status).toBe('no_findings');
      expect(run.review_exchanges![0].phase).toBe('initial');
    });

    it('returns the original implementation result unchanged', async () => {
      const deps = makeDeps();
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const original = makeCompleteResult();
      const result = await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: original, working_directory: WORKING_DIR });
      expect(result).toBe(original);
    });

    it('does not call the implementation model a second time', async () => {
      const deps = makeDeps();
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });
      expect(deps.implementer.implement).not.toHaveBeenCalled();
    });

    it('does not invoke branch guard (no implementer commits)', async () => {
      const deps = makeDeps();
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });
      expect(deps.branchGuard.check).not.toHaveBeenCalled();
    });
  });

  describe('runInitialReview — missing route', () => {
    it('logs implementation.review.skipped at warn level', async () => {
      const deps = makeDeps({ status: 'no_findings', summary: 'ok', findings: [] } as ImplementationReviewResult, { routingPolicy: makeRoutingPolicy(null, null) });
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'implementation.review.skipped' }),
        expect.any(String),
      );
    });

    it('returns the original result without calling any AI model', async () => {
      const deps = makeDeps({ status: 'no_findings', summary: 'ok', findings: [] } as ImplementationReviewResult, { routingPolicy: makeRoutingPolicy(null, null) });
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const original = makeCompleteResult();
      const result = await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: original, working_directory: WORKING_DIR });
      expect(result).toBe(original);
      expect(deps.runner.run).not.toHaveBeenCalled();
    });
  });

  describe('runInitialReview — findings path (all fixed)', () => {
    it('calls the implementation model with structured finding context', async () => {
      const findingsResult: ImplementationReviewResult = {
        status: 'findings',
        summary: 'Found 1 issue.',
        findings: [{ id: 'INIT-1', severity: 'blocker', category: 'test', finding: 'Missing test.' }],
      };
      const implResult = makeCompleteResult({ review_responses: [{ id: 'INIT-1', disposition: 'fixed', response: 'Added test.' }] });
      const deps = makeDeps(findingsResult, { implementer: makeImplementer(implResult) });
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });
      expect(deps.implementer.implement).toHaveBeenCalledWith(
        '/ws/spec.md',
        WORKING_DIR,
        expect.stringContaining('[REVIEW_ID: INIT-1]'),
        expect.any(Function),
        expect.objectContaining({ run_id: expect.any(String) }),
      );
    });

    it('appends an addressed exchange with findings and responses', async () => {
      const findingsResult: ImplementationReviewResult = {
        status: 'findings',
        summary: 'Found 1 issue.',
        findings: [{ id: 'INIT-1', severity: 'blocker', category: 'test', finding: 'Missing test.' }],
      };
      const implResult = makeCompleteResult({ review_responses: [{ id: 'INIT-1', disposition: 'fixed', response: 'Added test.' }] });
      const deps = makeDeps(findingsResult, { implementer: makeImplementer(implResult) });
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });
      expect(run.review_exchanges).toHaveLength(1);
      expect(run.review_exchanges![0].review_status).toBe('addressed');
      expect(run.review_exchanges![0].responses).toHaveLength(1);
    });

    it('returns the implementer response result as canonical implementation result', async () => {
      const findingsResult: ImplementationReviewResult = {
        status: 'findings',
        summary: 'Found 1 issue.',
        findings: [{ id: 'INIT-1', severity: 'blocker', category: 'test', finding: 'Missing test.' }],
      };
      const implResult = makeCompleteResult({ summary: 'Updated after review.', review_responses: [{ id: 'INIT-1', disposition: 'fixed', response: 'Added test.' }] });
      const deps = makeDeps(findingsResult, { implementer: makeImplementer(implResult) });
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const result = await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });
      expect(result.summary).toBe('Updated after review.');
    });

    it('invokes branch guard after implementer response', async () => {
      const findingsResult: ImplementationReviewResult = {
        status: 'findings',
        summary: 'Found 1 issue.',
        findings: [{ id: 'INIT-1', severity: 'blocker', category: 'test', finding: 'Missing test.' }],
      };
      const implResult = makeCompleteResult({ review_responses: [{ id: 'INIT-1', disposition: 'fixed', response: 'Fixed.' }] });
      const deps = makeDeps(findingsResult, { implementer: makeImplementer(implResult) });
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });
      expect(deps.branchGuard.check).toHaveBeenCalledWith(WORKING_DIR, run.branch);
    });
  });

  describe('runInitialReview — review model failure', () => {
    it('warn policy: appends degraded exchange, logs failure, returns original result', async () => {
      const failedReview: ImplementationReviewResult = { status: 'failed', summary: '', findings: [], error: 'model crashed' };
      const deps = makeDeps(failedReview);
      deps.policy = { ...deps.policy, on_review_failure: 'warn' };
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const original = makeCompleteResult();
      const result = await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: original, working_directory: WORKING_DIR });
      expect(result).toBe(original);
      expect(run.review_exchanges![0].review_status).toBe('degraded');
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'implementation.review.failed' }),
        expect.any(String),
      );
    });

    it('block policy: returns failed result, does not call implementer', async () => {
      const failedReview: ImplementationReviewResult = { status: 'failed', summary: '', findings: [], error: 'model crashed' };
      const deps = makeDeps(failedReview);
      deps.policy = { ...deps.policy, on_review_failure: 'block' };
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const result = await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });
      expect(result.status).toBe('failed');
      expect(deps.implementer.implement).not.toHaveBeenCalled();
    });
  });

  describe('runInitialReview — implementer response failure', () => {
    it('propagates needs_input status from implementer response', async () => {
      const findingsResult: ImplementationReviewResult = {
        status: 'findings',
        summary: 'Found issue.',
        findings: [{ id: 'INIT-1', severity: 'blocker', category: 'test', finding: 'Missing test.' }],
      };
      const deps = makeDeps(findingsResult, { implementer: makeImplementer({ status: 'needs_input', question: 'Which approach?' }) });
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const result = await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });
      expect(result.status).toBe('needs_input');
    });
  });

  describe('runInitialReview — missing response IDs', () => {
    it('logs implementation.review.response_invalid for each missing finding ID', async () => {
      const findingsResult: ImplementationReviewResult = {
        status: 'findings',
        summary: 'Found issue.',
        findings: [{ id: 'INIT-1', severity: 'blocker', category: 'test', finding: 'Missing test.' }],
      };
      // Implementer returns review_responses with wrong ID
      const deps = makeDeps(findingsResult, { implementer: makeImplementer(makeCompleteResult({ review_responses: [{ id: 'WRONG-ID', disposition: 'fixed', response: 'Fixed.' }] })) });
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'implementation.review.response_invalid' }),
        expect.any(String),
      );
    });

    it('run continues without stopping when responses are incomplete', async () => {
      const findingsResult: ImplementationReviewResult = {
        status: 'findings',
        summary: 'Found issue.',
        findings: [{ id: 'INIT-1', severity: 'blocker', category: 'test', finding: 'Missing test.' }],
      };
      const deps = makeDeps(findingsResult, { implementer: makeImplementer(makeCompleteResult({ review_responses: [] })) });
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const result = await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });
      expect(result.status).toBe('complete');
    });
  });

  describe('runFinalReview — final route fallback', () => {
    it('uses implementation.review.initial when final route is absent', async () => {
      const deps = makeDeps({ status: 'no_findings', summary: 'ok', findings: [] } as ImplementationReviewResult, { routingPolicy: makeRoutingPolicy(makeAgentProfile('review-agent'), null) });
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      await coordinator.runFinalReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });
      expect(run.review_exchanges![0].phase).toBe('final');
      const calls = (deps.routingPolicy.resolveOptional as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some((c: unknown[]) => (c[0] as { task: string }).task === 'implementation.review.final')).toBe(true);
    });
  });

  describe('captureSession', () => {
    it('emits exactly one ok session with drain counts forwarded from AgentDrainSummary', async () => {
      // Runner yields assistant events so drainAgentRunner accumulates non-zero counts.
      const runner: AgentRunner = {
        run: vi.fn().mockReturnValue((async function* () {
          yield { type: 'assistant', content: [{ type: 'text', text: 'reviewing' }], tool_call_count: 2, tool_result_count: 2 };
          yield { type: 'assistant', content: [{ type: 'text', text: 'done' }] };
        })()),
      };
      const deps = makeDeps(undefined, { runner });
      const captureSession = vi.fn();
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR, captureSession });
      expect(captureSession).toHaveBeenCalledTimes(1);
      expect(captureSession).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'ok',
        step: 'implementation.review.initial',
      }));
      const record = captureSession.mock.calls[0][0] as Record<string, unknown>;
      // Counts forwarded from drainSummary, not hardcoded null
      expect(record['assistant_turns']).toBe(2);
      expect(record['tool_calls']).toBe(2);
      expect(record['tool_results']).toBe(2);
    });

    it('emits exactly one failed session and no ok session when result-file read throws', async () => {
      // The ok emit now lives after readFile inside the try block.
      // If readFile throws, only the catch-side failed session is emitted.
      const deps = makeDeps(undefined, {
        readFile: vi.fn().mockRejectedValue(new Error('ENOENT: no such file')),
      });
      const captureSession = vi.fn();
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR, captureSession });
      expect(captureSession).toHaveBeenCalledTimes(1);
      expect(captureSession).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
    });

    it('failed session after result-file read throws preserves drain counts and token usage', async () => {
      // drain completes successfully, then readFile throws — the failed session record
      // must carry the counts and token usage from the completed drain, not null.
      const runner: AgentRunner = {
        run: vi.fn().mockReturnValue((async function* () {
          yield { type: 'assistant', content: [{ type: 'text', text: 'reviewing' }], tool_call_count: 3, tool_result_count: 3 };
          yield { type: 'assistant', content: [{ type: 'text', text: 'done' }] };
          yield { type: 'result', subtype: 'success', session_id: 's1', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } };
        })()),
      };
      const deps = makeDeps(undefined, {
        runner,
        readFile: vi.fn().mockRejectedValue(new Error('ENOENT: no such file')),
      });
      const captureSession = vi.fn();
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR, captureSession });
      expect(captureSession).toHaveBeenCalledTimes(1);
      const record = captureSession.mock.calls[0][0] as Record<string, unknown>;
      expect(record['outcome']).toBe('failed');
      expect(record['assistant_turns']).toBe(2);
      expect(record['tool_calls']).toBe(3);
      expect(record['tool_results']).toBe(3);
    });

    it('emits one failed session when drainAgentRunner throws — no duplicate', async () => {
      const throwingRunner: AgentRunner = {
        run: vi.fn().mockReturnValue((async function* () {
          throw new Error('runner exploded');
        })()),
      };
      const deps = makeDeps(undefined, { runner: throwingRunner });
      const captureSession = vi.fn();
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR, captureSession });
      expect(captureSession).toHaveBeenCalledTimes(1);
      expect(captureSession).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
    });
  });

  describe('onAgentRequest callback', () => {
    it('calls onAgentRequest with model, requested_at, and route when review profile is resolved', async () => {
      const deps = makeDeps();
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const onAgentRequest = vi.fn();

      await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR, onAgentRequest });

      expect(onAgentRequest).toHaveBeenCalledWith(expect.objectContaining({
        model: expect.any(String),
        requested_at: expect.any(String),
        route: expect.objectContaining({ task: 'implementation.review.initial' }),
      }));
    });

    it('does not call onAgentRequest when no review profile is configured', async () => {
      const deps = makeDeps({} as never, { routingPolicy: makeRoutingPolicy(null, null) });
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const onAgentRequest = vi.fn();

      await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR, onAgentRequest });

      expect(onAgentRequest).not.toHaveBeenCalled();
    });
  });

  describe('review round telemetry', () => {
    it('logs implementation.review.round_started and round_completed', async () => {
      const deps = makeDeps();
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });

      const infoCalls: Array<Record<string, unknown>> = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as Record<string, unknown>,
      );

      const started = infoCalls.find(l => l['event'] === 'implementation.review.round_started');
      const completed = infoCalls.find(l => l['event'] === 'implementation.review.round_completed');

      expect(started).toBeDefined();
      expect(typeof started!['round']).toBe('number');
      expect(completed).toBeDefined();
      expect(typeof completed!['duration_ms']).toBe('number');
      expect(typeof completed!['blocker_count']).toBe('number');
      expect(typeof completed!['warning_count']).toBe('number');
      expect(typeof completed!['info_count']).toBe('number');
    });

    it('logs correct finding counts by severity', async () => {
      const findingsResult: ImplementationReviewResult = {
        status: 'findings',
        summary: 'Found issues.',
        findings: [
          { id: 'F1', severity: 'blocker', category: 'test', finding: 'Blocker.' },
          { id: 'F2', severity: 'warning', category: 'test', finding: 'Warning.' },
          { id: 'F3', severity: 'warning', category: 'test', finding: 'Another warning.' },
          { id: 'F4', severity: 'info', category: 'test', finding: 'Info.' },
        ],
      };
      const implResult = makeCompleteResult({
        review_responses: [
          { id: 'F1', disposition: 'fixed', response: 'Fixed.' },
          { id: 'F2', disposition: 'fixed', response: 'Fixed.' },
          { id: 'F3', disposition: 'fixed', response: 'Fixed.' },
          { id: 'F4', disposition: 'fixed', response: 'Fixed.' },
        ],
      });
      const deps = makeDeps(findingsResult, { implementer: makeImplementer(implResult) });
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });

      const infoCalls: Array<Record<string, unknown>> = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as Record<string, unknown>,
      );
      const completed = infoCalls.find(l => l['event'] === 'implementation.review.round_completed');

      expect(completed).toBeDefined();
      expect(completed!['blocker_count']).toBe(1);
      expect(completed!['warning_count']).toBe(2);
      expect(completed!['info_count']).toBe(1);
    });
  });

  describe('runInitialReview — heartbeat callbacks', () => {
    it('fires onAgentRequest with is_heartbeat: true on relay progress events', async () => {
      const relayRunner: AgentRunner = {
        run: vi.fn().mockReturnValue((async function* () {
          yield { type: 'assistant', content: [{ type: 'text', text: '[Relay] reviewing now' }] };
        })()),
      };
      const deps = makeDeps(undefined, { runner: relayRunner });
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const callbacks: Array<{ is_heartbeat?: boolean }> = [];
      const onAgentRequest = vi.fn((metadata: { is_heartbeat?: boolean }) => callbacks.push(metadata));
      const onProgress = vi.fn();

      await coordinator.runInitialReview({
        run,
        artifact_path: '/ws/spec.md',
        implementation_result: makeCompleteResult(),
        working_directory: WORKING_DIR,
        onProgress,
        onAgentRequest,
      });

      // Initial call (not heartbeat) + one heartbeat per relay event
      expect(callbacks.length).toBeGreaterThanOrEqual(2);
      expect(callbacks[0].is_heartbeat).toBeFalsy();
      expect(callbacks.slice(1).every(c => c.is_heartbeat === true)).toBe(true);
      expect(onProgress).toHaveBeenCalled();
    });

    it('no heartbeat callbacks when onProgress is absent', async () => {
      const relayRunner: AgentRunner = {
        run: vi.fn().mockReturnValue((async function* () {
          yield { type: 'assistant', content: [{ type: 'text', text: '[Relay] reviewing now' }] };
        })()),
      };
      const deps = makeDeps(undefined, { runner: relayRunner });
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const callbacks: Array<{ is_heartbeat?: boolean }> = [];
      const onAgentRequest = vi.fn((metadata: { is_heartbeat?: boolean }) => callbacks.push(metadata));

      await coordinator.runInitialReview({
        run,
        artifact_path: '/ws/spec.md',
        implementation_result: makeCompleteResult(),
        working_directory: WORKING_DIR,
        onAgentRequest,
        // onProgress intentionally absent
      });

      // Only the initial call, no heartbeat
      expect(callbacks).toHaveLength(1);
      expect(callbacks[0].is_heartbeat).toBeFalsy();
    });
  });
});
