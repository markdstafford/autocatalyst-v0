import { describe, it, expect, vi } from 'vitest';
import { ImplementationReviewCoordinator } from '../../../src/core/ai/implementation-review-coordinator.js';
import { ModelSessionBudget } from '../../../src/core/journal/model-session-budget.js';
import type { AgentRunner, AgentRoutingPolicy, ImplementationAgent, ImplementationResult, ImplementationReviewResult, AgentProfile, GateReviewExchange } from '../../../src/types/ai.js';
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
    policy: { max_initial_rounds: 1, max_final_rounds: 1, on_review_failure: 'warn' as const, retest_on_behavior_change: true, convergence: { enabled: false, allow_same_model: false } },
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

  describe('convergence disabled', () => {
    it('keeps legacy one-pass-plus-response behavior without gate_exchanges', async () => {
      const findingsResult: ImplementationReviewResult = {
        status: 'findings',
        summary: 'Found issue.',
        findings: [{ id: 'INIT-1', severity: 'blocker', category: 'test', finding: 'Missing test.' }],
      };
      const implResult = makeCompleteResult({
        summary: 'Updated once.',
        review_responses: [{ id: 'INIT-1', disposition: 'fixed', response: 'Added test.' }],
      });
      const deps = makeDeps(findingsResult, { implementer: makeImplementer(implResult) });
      // Ensure convergence is disabled (it is by default in makeDeps)
      deps.policy = { ...deps.policy, convergence: { enabled: false, allow_same_model: false } };
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();

      const result = await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });

      expect(result.summary).toBe('Updated once.');
      // One critic (runner.run) call, one implementer call
      expect(deps.runner.run).toHaveBeenCalledTimes(1);
      expect(deps.implementer.implement).toHaveBeenCalledTimes(1);
      // review_exchanges has exactly one entry
      expect(run.review_exchanges).toHaveLength(1);
      // gate_exchanges is not set
      expect((run as Record<string, unknown>)['gate_exchanges']).toBeUndefined();
    });
  });

  describe('convergence enabled', () => {
    function makeConvergenceDeps(reviewResults: ImplementationReviewResult[], overrides: Record<string, unknown> = {}) {
      let callCount = 0;
      const readFile = vi.fn().mockImplementation(async () => {
        const result = reviewResults[callCount] ?? { status: 'no_findings', summary: 'ok', findings: [] };
        callCount++;
        return JSON.stringify(result);
      });
      const deps = makeDeps({ status: 'no_findings', summary: 'unused', findings: [] }, { readFile, ...overrides });
      deps.policy = { ...deps.policy, max_initial_rounds: 2, max_final_rounds: 2, convergence: { enabled: true, allow_same_model: true } };
      return deps;
    }

    it('re-reviews after a proposer response and converges on round 2', async () => {
      const deps = makeConvergenceDeps([
        { status: 'findings', summary: 'Round 1.', findings: [{ id: 'INIT-1', severity: 'blocker', category: 'test', finding: 'Missing test.' }] },
        { status: 'no_findings', summary: 'Round 2 clean.', findings: [] },
      ], {
        implementer: makeImplementer(makeCompleteResult({ summary: 'Updated after round 1.', review_responses: [{ id: 'INIT-1', disposition: 'fixed', response: 'Added test.' }] })),
      });
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();

      const result = await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });

      expect(result.summary).toBe('Updated after round 1.');
      expect(deps.runner.run).toHaveBeenCalledTimes(2);
      expect(deps.implementer.implement).toHaveBeenCalledTimes(1);
      expect(run.gate_exchanges).toHaveLength(2);
      expect(run.gate_exchanges![0]).toMatchObject({ gate: 'initial', round: 1, converged: false, review_status: 'addressed' });
      expect(run.gate_exchanges![1]).toMatchObject({ gate: 'initial', round: 2, converged: true, review_status: 'converged' });
    });

    it('treats info-only findings as converged and does not call proposer', async () => {
      const deps = makeConvergenceDeps([
        { status: 'findings', summary: 'Only notes.', findings: [{ id: 'INIT-INFO-1', severity: 'info', category: 'docs', finding: 'Optional note.' }] },
      ]);
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();

      const result = await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });

      expect(result.status).toBe('complete');
      expect(deps.implementer.implement).not.toHaveBeenCalled();
      expect(run.gate_exchanges![0]).toMatchObject({ converged: true, review_status: 'converged' });
      expect((run.gate_exchanges as GateReviewExchange[])[0].findings[0].severity).toBe('info');
    });

    it('fails immediately with max_rounds when max_initial_rounds is 1 and blockers are present', async () => {
      const deps = makeConvergenceDeps([
        { status: 'findings', summary: 'Still blocked.', findings: [{ id: 'INIT-1', severity: 'blocker', category: 'correctness', finding: 'Bug remains.' }] },
      ]);
      deps.policy = { ...deps.policy, max_initial_rounds: 1 };
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();

      const result = await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });

      expect(result.status).toBe('failed');
      expect(result.error).toContain('initial did not converge');
      expect(deps.implementer.implement).not.toHaveBeenCalled();
      expect(run.gate_exchanges![0]).toMatchObject({ converged: false, review_status: 'non_converged', non_convergence_reason: 'max_rounds' });
    });

    it('calls captureFeedback once per gate exchange during convergence', async () => {
      const captureFeedback = vi.fn();
      const deps = makeConvergenceDeps([
        { status: 'findings', summary: 'Round 1.', findings: [{ id: 'INIT-1', severity: 'blocker', category: 'test', finding: 'Missing test.' }] },
        { status: 'no_findings', summary: 'Round 2 clean.', findings: [] },
      ], {
        implementer: makeImplementer(makeCompleteResult({ review_responses: [{ id: 'INIT-1', disposition: 'fixed', response: 'Added test.' }] })),
      });
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();

      await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR, captureFeedback });

      expect(captureFeedback).toHaveBeenCalledTimes(2); // once per gate exchange
      expect(captureFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ gate: 'initial', round: 1 }),
        run,
      );
      expect(captureFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ gate: 'initial', round: 2, converged: true }),
        run,
      );
      expect(run.review_exchanges).toHaveLength(0); // no legacy exchanges in convergence mode
    });

    it('captureSession for critic includes role: critic, round, and gate', async () => {
      const deps = makeConvergenceDeps([
        { status: 'findings', summary: 'Round 1.', findings: [{ id: 'INIT-1', severity: 'blocker', category: 'test', finding: 'Missing test.' }] },
        { status: 'no_findings', summary: 'Round 2 clean.', findings: [] },
      ], {
        implementer: makeImplementer(makeCompleteResult({ review_responses: [{ id: 'INIT-1', disposition: 'fixed', response: 'Added test.' }] })),
      });
      const captureSession = vi.fn();
      const coordinator = new ImplementationReviewCoordinator(deps);

      await coordinator.runInitialReview({ run: makeRun(), artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR, captureSession });

      // Both critic sessions (round 1 and round 2) should have role, round, and gate
      const criticCalls = (captureSession.mock.calls as Array<[Record<string, unknown>]>)
        .map(c => c[0])
        .filter(r => r['role'] === 'critic');
      expect(criticCalls).toHaveLength(2);
      expect(criticCalls[0]).toMatchObject({ role: 'critic', round: 1, gate: 'initial' });
      expect(criticCalls[1]).toMatchObject({ role: 'critic', round: 2, gate: 'initial' });
    });

    it('passes the proposer role route into the actual implementer review-response call', async () => {
      const deps = makeConvergenceDeps([
        { status: 'findings', summary: 'Round 1.', findings: [{ id: 'INIT-1', severity: 'blocker', category: 'test', finding: 'Missing test.' }] },
        { status: 'no_findings', summary: 'Round 2 clean.', findings: [] },
      ], {
        implementer: makeImplementer(makeCompleteResult({ review_responses: [{ id: 'INIT-1', disposition: 'fixed', response: 'Added test.' }] })),
      });
      const coordinator = new ImplementationReviewCoordinator(deps);

      await coordinator.runInitialReview({ run: makeRun(), artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });

      expect(deps.implementer.implement).toHaveBeenCalledWith(
        '/ws/spec.md',
        WORKING_DIR,
        expect.stringContaining('Convergence gate: initial'),
        expect.any(Function),
        expect.objectContaining({
          phase: 'implementation_review_initial_proposer',
          route: { task: 'implementation.run', role: 'proposer' },
        }),
      );
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

  describe('convergence oscillation', () => {
    function makeOscillationDeps(reviewResults: ImplementationReviewResult[]) {
      let callCount = 0;
      const readFile = vi.fn().mockImplementation(async () => {
        const result = reviewResults[callCount] ?? { status: 'no_findings', summary: 'ok', findings: [] };
        callCount++;
        return JSON.stringify(result);
      });
      // Need enough rounds (3) for oscillation
      const proposerResult = makeCompleteResult({ review_responses: [{ id: 'INIT-1', disposition: 'declined', response: 'Not applicable.' }] });
      const deps = makeDeps({ status: 'no_findings', summary: 'ok', findings: [] }, {
        readFile,
        implementer: makeImplementer(proposerResult),
      });
      deps.policy = { ...deps.policy, max_initial_rounds: 3, max_final_rounds: 3, convergence: { enabled: true, allow_same_model: true } };
      return deps;
    }

    it('detects repeated non-shrinking blocker signature and fails with oscillation', async () => {
      const sameFinding = { id: 'INIT-1', severity: 'blocker' as const, category: 'correctness' as const, finding: 'Bug remains unchanged.' };
      const deps = makeOscillationDeps([
        { status: 'findings', summary: 'Round 1.', findings: [sameFinding] },
        { status: 'findings', summary: 'Round 2 same.', findings: [sameFinding] },
        { status: 'no_findings', summary: 'Round 3.', findings: [] }, // should never reach
      ]);
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();

      const result = await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });

      expect(result.status).toBe('failed');
      expect(result.error).toContain('oscillation');
      expect(run.gate_exchanges!.at(-1)).toMatchObject({ review_status: 'non_converged', non_convergence_reason: 'oscillation' });
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'implementation.review.oscillation_detected' }),
        expect.any(String),
      );
    });

    it('does not trigger oscillation for info-only repeated findings', async () => {
      // Info-only repeated findings should converge (info doesn't count for oscillation)
      const deps = makeOscillationDeps([
        { status: 'findings', summary: 'Round 1 info only.', findings: [{ id: 'INIT-INFO-1', severity: 'info' as const, category: 'docs' as const, finding: 'Note about docs.' }] },
      ]);
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();

      const result = await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });

      expect(result.status).toBe('complete');
      expect(run.gate_exchanges![0]).toMatchObject({ converged: true });
    });
  });

  describe('convergence same-model enforcement', () => {
    function makeSameModelDeps(allow_same_model: boolean) {
      // Create a routing policy where both implementation.run and implementation.review.initial
      // resolve to the same profile id
      const sameProfile: AgentProfile = { id: 'same-agent', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-6' };
      const routingPolicy: AgentRoutingPolicy = {
        resolve: vi.fn().mockReturnValue(sameProfile),
        resolveOptional: vi.fn().mockReturnValue(sameProfile),
      };
      const deps = makeDeps({ status: 'no_findings', summary: 'ok', findings: [] }, { routingPolicy });
      deps.policy = { ...deps.policy, convergence: { enabled: true, allow_same_model } };
      return { deps, sameProfile };
    }

    it('fails before critic execution when same profile and allow_same_model is false', async () => {
      const { deps } = makeSameModelDeps(false);
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();

      const result = await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });

      expect(result.status).toBe('failed');
      expect(result.error).toContain('requires distinct proposer and critic profiles for initial review');
      expect(deps.runner.run).not.toHaveBeenCalled();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'implementation.review.same_model_rejected', profile_id: 'same-agent' }),
        expect.any(String),
      );
    });

    it('allows same profile when allow_same_model is true and logs a warning', async () => {
      const { deps } = makeSameModelDeps(true);
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();

      const result = await coordinator.runInitialReview({ run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR });

      expect(result.status).toBe('complete');
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'implementation.review.same_model_allowed', profile_id: 'same-agent' }),
        expect.any(String),
      );
    });
  });

  describe('runLayeredImplementation', () => {
    it('returns single-pass behavior when convergence is disabled', async () => {
      const deps = makeDeps();
      deps.policy = { ...deps.policy, convergence: { enabled: false, allow_same_model: false } };
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const original = makeCompleteResult();
      const result = await coordinator.runLayeredImplementation(
        { run, artifact_path: '/ws/spec.md', implementation_result: original, working_directory: WORKING_DIR },
        { altitudes: ['layout', 'build'] },
      );
      expect(result).toBe(original);
      // Used legacy review_exchanges, not gate_exchanges
      expect(run.review_exchanges).toHaveLength(1);
      expect((run as Record<string, unknown>)['gate_exchanges']).toBeUndefined();
    });

    it('delegates to existing build convergence for build-only depth and preserves gate: "initial"', async () => {
      let callCount = 0;
      const readFile = vi.fn().mockImplementation(async () => {
        const result = callCount === 0
          ? { status: 'no_findings', summary: 'Round 1 clean.', findings: [] }
          : { status: 'no_findings', summary: 'unused', findings: [] };
        callCount++;
        return JSON.stringify(result);
      });
      const deps = makeDeps(undefined, { readFile });
      deps.policy = { ...deps.policy, max_initial_rounds: 2, convergence: { enabled: true, allow_same_model: true } };
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const result = await coordinator.runLayeredImplementation(
        { run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR },
        { altitudes: ['build'] },
      );
      expect(result.status).toBe('complete');
      expect(run.gate_exchanges).toHaveLength(1);
      expect(run.gate_exchanges![0].gate).toBe('initial'); // build-only preserves "initial"
    });

    it('for layered depth, runs altitudes in order and persists altitude gate names', async () => {
      // Two altitudes, each converges on first round (no_findings)
      const readFile = vi.fn().mockImplementation(async () => {
        return JSON.stringify({ status: 'no_findings', summary: 'Clean.', findings: [] });
      });
      const deps = makeDeps(undefined, { readFile });
      deps.policy = { ...deps.policy, max_initial_rounds: 2, convergence: { enabled: true, allow_same_model: true } };
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const result = await coordinator.runLayeredImplementation(
        { run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR },
        { altitudes: ['layout', 'build'] },
      );
      expect(result.status).toBe('complete');
      expect(run.gate_exchanges).toHaveLength(2);
      expect(run.gate_exchanges![0].gate).toBe('layout');
      expect(run.gate_exchanges![1].gate).toBe('build');
    });

    it('depth: public_api runs layout, public_api, then build in order', async () => {
      const readFile = vi.fn().mockImplementation(async () => {
        return JSON.stringify({ status: 'no_findings', summary: 'Clean.', findings: [] });
      });
      const deps = makeDeps(undefined, { readFile });
      deps.policy = { ...deps.policy, max_initial_rounds: 2, convergence: { enabled: true, allow_same_model: true } };
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const result = await coordinator.runLayeredImplementation(
        { run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR },
        { altitudes: ['layout', 'public_api', 'build'] },
      );
      expect(result.status).toBe('complete');
      expect(run.gate_exchanges).toHaveLength(3);
      expect(run.gate_exchanges!.map(g => g.gate)).toEqual(['layout', 'public_api', 'build']);
    });

    it('depth: full runs all four altitudes in order', async () => {
      const readFile = vi.fn().mockImplementation(async () => {
        return JSON.stringify({ status: 'no_findings', summary: 'Clean.', findings: [] });
      });
      const deps = makeDeps(undefined, { readFile });
      deps.policy = { ...deps.policy, max_initial_rounds: 2, convergence: { enabled: true, allow_same_model: true } };
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const result = await coordinator.runLayeredImplementation(
        { run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR },
        { altitudes: ['layout', 'public_api', 'private_api', 'build'] },
      );
      expect(result.status).toBe('complete');
      expect(run.gate_exchanges).toHaveLength(4);
      expect(run.gate_exchanges!.map(g => g.gate)).toEqual(['layout', 'public_api', 'private_api', 'build']);
    });

    it('fails immediately when an early altitude does not converge', async () => {
      // layout: blocker on round 1 with max_initial_rounds=1 → fails
      const readFile = vi.fn().mockImplementation(async () => {
        return JSON.stringify({ status: 'findings', summary: 'Blocked.', findings: [{ id: 'L1', severity: 'blocker', category: 'maintainability', finding: 'Bad layout.', scope: 'current_altitude', reason_code: 'layout_boundary' }] });
      });
      const deps = makeDeps(undefined, { readFile });
      deps.policy = { ...deps.policy, max_initial_rounds: 1, convergence: { enabled: true, allow_same_model: true } };
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const result = await coordinator.runLayeredImplementation(
        { run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR },
        { altitudes: ['layout', 'build'] },
      );
      expect(result.status).toBe('failed');
      // Should not have run the build altitude after layout failed
      expect(run.gate_exchanges).toHaveLength(1);
      expect(run.gate_exchanges![0].gate).toBe('layout');
      expect(run.gate_exchanges![0].converged).toBe(false);
    });
  });

  describe('runLayeredImplementation — telemetry and progress', () => {
    function makeLayeredDeps(overrides: Record<string, unknown> = {}) {
      const readFile = vi.fn().mockImplementation(async () => {
        return JSON.stringify({ status: 'no_findings', summary: 'Clean.', findings: [] });
      });
      const deps = makeDeps(undefined, { readFile, ...overrides });
      deps.policy = { ...deps.policy, max_initial_rounds: 2, convergence: { enabled: true, allow_same_model: true } };
      return deps;
    }

    it('logs implementation.layered.started with run_id, depth, enabled_altitudes, and model_session_budget', async () => {
      const deps = makeLayeredDeps();
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      await coordinator.runLayeredImplementation(
        { run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR },
        { altitudes: ['layout', 'build'] },
      );

      const infoCalls: Array<Record<string, unknown>> = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as Record<string, unknown>,
      );
      const started = infoCalls.find(l => l['event'] === 'implementation.layered.started');

      expect(started).toBeDefined();
      expect(started!['run_id']).toBe('run-001');
      expect(started!['enabled_altitudes']).toEqual(['layout', 'build']);
      expect(typeof started!['model_session_budget']).toBe('number');
    });

    it('logs implementation.layer.started for each named altitude', async () => {
      const deps = makeLayeredDeps();
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      await coordinator.runLayeredImplementation(
        { run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR },
        { altitudes: ['layout', 'build'] },
      );

      const infoCalls: Array<Record<string, unknown>> = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as Record<string, unknown>,
      );
      const layerStarted = infoCalls.filter(l => l['event'] === 'implementation.layer.started');

      // Should have one layer.started per altitude
      expect(layerStarted).toHaveLength(2);
      expect(layerStarted[0]!['gate']).toBe('layout');
      expect(layerStarted[1]!['gate']).toBe('build');
    });

    it('logs implementation.layer.completed when altitude converges', async () => {
      const deps = makeLayeredDeps();
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      await coordinator.runLayeredImplementation(
        { run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR },
        { altitudes: ['layout', 'build'] },
      );

      const infoCalls: Array<Record<string, unknown>> = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as Record<string, unknown>,
      );
      const layerCompleted = infoCalls.filter(l => l['event'] === 'implementation.layer.completed');

      expect(layerCompleted).toHaveLength(2);
      expect(layerCompleted[0]!['gate']).toBe('layout');
      expect(typeof layerCompleted[0]!['elapsed_ms']).toBe('number');
    });

    it('progress message includes depth information when layered mode is activated', async () => {
      const deps = makeLayeredDeps();
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const progressMessages: string[] = [];
      const onProgress = vi.fn().mockImplementation((msg: string) => { progressMessages.push(msg); return Promise.resolve(); });

      await coordinator.runLayeredImplementation(
        { run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR, onProgress },
        { altitudes: ['layout', 'build'] },
      );

      const depthMsg = progressMessages.find(m => m.includes('Layered implementation enabled'));
      expect(depthMsg).toBeDefined();
      expect(depthMsg).toContain('layout+build');
    });

    it('progress message for altitude start includes altitude label and proposer profile', async () => {
      const deps = makeLayeredDeps();
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const progressMessages: string[] = [];
      const onProgress = vi.fn().mockImplementation((msg: string) => { progressMessages.push(msg); return Promise.resolve(); });

      await coordinator.runLayeredImplementation(
        { run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR, onProgress },
        { altitudes: ['layout', 'build'] },
      );

      const layoutMsg = progressMessages.find(m => m.includes('Layout pass started'));
      expect(layoutMsg).toBeDefined();
    });

    it('progress callback that throws does not alter review outcome', async () => {
      const deps = makeLayeredDeps();
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      // onProgress throws every time
      const onProgress = vi.fn().mockRejectedValue(new Error('progress delivery failed'));

      const result = await coordinator.runLayeredImplementation(
        { run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR, onProgress },
        { altitudes: ['layout', 'build'] },
      );

      // Review should still succeed despite progress failures
      expect(result.status).toBe('complete');
      // progress_failed should be logged, not thrown
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'progress_failed' }),
        expect.any(String),
      );
    });

    it('progress failure in sendProgress does not propagate as exception', async () => {
      // Test specifically the sendProgress path inside the convergence loop
      let callCount = 0;
      const readFile = vi.fn().mockImplementation(async () => {
        const result = callCount === 0
          ? { status: 'findings', summary: 'Round 1.', findings: [{ id: 'L1', severity: 'blocker', category: 'maintainability', finding: 'Layout issue.' }] }
          : { status: 'no_findings', summary: 'Clean.', findings: [] };
        callCount++;
        return JSON.stringify(result);
      });
      const deps = makeDeps(undefined, {
        readFile,
        implementer: makeImplementer(makeCompleteResult({ review_responses: [{ id: 'L1', disposition: 'fixed', response: 'Fixed.' }] })),
      });
      deps.policy = { ...deps.policy, max_initial_rounds: 2, convergence: { enabled: true, allow_same_model: true } };
      const coordinator = new ImplementationReviewCoordinator(deps);
      const run = makeRun();
      const onProgress = vi.fn().mockRejectedValue(new Error('network error'));

      const result = await coordinator.runLayeredImplementation(
        { run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR, onProgress },
        { altitudes: ['layout', 'build'] },
      );

      expect(result.status).toBe('complete');
    });
  });
});

describe('runLayeredImplementation — regression: no forbidden git operations', () => {
  it('runner.run is never called with a prompt containing checkout, push, merge, or branch-create commands', async () => {
    const capturedPrompts: string[] = [];
    const capturingRunner: AgentRunner = {
      run: vi.fn().mockImplementation((params: { prompt: string }) => {
        capturedPrompts.push(params.prompt);
        return (async function* () {})();
      }),
    };
    const readFile = vi.fn().mockImplementation(async () => {
      return JSON.stringify({ status: 'no_findings', summary: 'Clean.', findings: [] });
    });
    const deps = makeDeps(undefined, { runner: capturingRunner, readFile });
    deps.policy = { ...deps.policy, max_initial_rounds: 2, convergence: { enabled: true, allow_same_model: true } };
    const coordinator = new ImplementationReviewCoordinator(deps);
    const run = makeRun();

    await coordinator.runLayeredImplementation(
      { run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR },
      { altitudes: ['layout', 'public_api', 'build'] },
    );

    for (const prompt of capturedPrompts) {
      // No prompt should instruct the agent to run forbidden git operations
      expect(prompt).not.toMatch(/git\s+checkout/i);
      expect(prompt).not.toMatch(/git\s+push/i);
      expect(prompt).not.toMatch(/git\s+merge/i);
      expect(prompt).not.toMatch(/git\s+branch\s+-[cCmM]/i);
      expect(prompt).not.toMatch(/gh pr create/i);
    }
  });

  it('early altitude prompts instruct the critic not to file missing-body or missing-test findings', async () => {
    const capturedPrompts: Map<number, string> = new Map();
    let callIndex = 0;
    const capturingRunner: AgentRunner = {
      run: vi.fn().mockImplementation((params: { prompt: string }) => {
        capturedPrompts.set(callIndex++, params.prompt);
        return (async function* () {})();
      }),
    };
    const readFile = vi.fn().mockImplementation(async () => {
      return JSON.stringify({ status: 'no_findings', summary: 'Clean.', findings: [] });
    });
    const deps = makeDeps(undefined, { runner: capturingRunner, readFile });
    deps.policy = { ...deps.policy, max_initial_rounds: 2, convergence: { enabled: true, allow_same_model: true } };
    const coordinator = new ImplementationReviewCoordinator(deps);
    const run = makeRun();

    await coordinator.runLayeredImplementation(
      { run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR },
      { altitudes: ['layout', 'public_api', 'build'] },
    );

    // layout (call 0) and public_api (call 1) prompts must include the early-gate restriction
    const layoutPrompt = capturedPrompts.get(0);
    const publicApiPrompt = capturedPrompts.get(1);
    const buildPrompt = capturedPrompts.get(2);

    expect(layoutPrompt).toBeDefined();
    expect(layoutPrompt).toContain('Do not file missing-body, missing-test, or missing-implementation findings');

    expect(publicApiPrompt).toBeDefined();
    expect(publicApiPrompt).toContain('Do not file missing-body, missing-test, or missing-implementation findings');

    // build prompt must NOT contain the early-gate restriction
    expect(buildPrompt).toBeDefined();
    expect(buildPrompt).not.toContain('Do not file missing-body');
  });

  it('early altitude proposer prompt does not contain build/test run instructions', async () => {
    // Criteria 8: the proposer (implementer) at early altitudes must stay within
    // the altitude contract. When the layout critic finds a blocker, the coordinator
    // calls implementer.implement with buildLayeredRevisePrompt, which restricts work
    // to the current altitude and must not instruct the agent to run npm test, build, or lint.
    const capturedProposerPrompts: string[] = [];
    const capturingImplementer: Pick<ImplementationAgent, 'implement'> = {
      implement: vi.fn().mockImplementation((_specPath: string, _workDir: string, prompt: string) => {
        capturedProposerPrompts.push(prompt);
        // Return complete with a review_responses entry so convergence proceeds
        return Promise.resolve(makeCompleteResult({
          review_responses: [{ id: 'L1', disposition: 'fixed', response: 'Fixed layout.' }],
        }));
      }),
    };
    let callCount = 0;
    const readFile = vi.fn().mockImplementation(async () => {
      // Round 1: layout blocker → triggers proposer revision; Round 2: clean
      const result = callCount === 0
        ? { status: 'findings', summary: 'Blocked.', findings: [{ id: 'L1', severity: 'blocker', category: 'maintainability', finding: 'Bad layout.', scope: 'current_altitude', reason_code: 'layout_boundary' }] }
        : { status: 'no_findings', summary: 'Clean.', findings: [] };
      callCount++;
      return JSON.stringify(result);
    });
    const deps = makeDeps(undefined, { readFile, implementer: capturingImplementer });
    deps.policy = { ...deps.policy, max_initial_rounds: 2, convergence: { enabled: true, allow_same_model: true } };
    const coordinator = new ImplementationReviewCoordinator(deps);
    const run = makeRun();

    await coordinator.runLayeredImplementation(
      { run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR },
      { altitudes: ['layout', 'build'] },
    );

    // The proposer was called during the layout revise round
    expect(capturedProposerPrompts.length).toBeGreaterThanOrEqual(1);
    const layoutRevisePrompt = capturedProposerPrompts[0]!;

    // Must not instruct the agent to run build/test/lint commands
    expect(layoutRevisePrompt).not.toMatch(/npm\s+(test|run\s+build|run\s+lint)/i);
    expect(layoutRevisePrompt).not.toMatch(/yarn\s+(test|build|lint)/i);
    expect(layoutRevisePrompt).not.toMatch(/pnpm\s+(test|build|lint)/i);

    // Must include the altitude-contract restriction (stay within current altitude)
    expect(layoutRevisePrompt).toContain('altitude contract');
  });

  it('build altitude proposer prompt includes instructions to implement bodies and tests', async () => {
    // Criteria 9: the proposer at build altitude must be mandated to address
    // test coverage, code, and docs — not just restricted to a skeleton altitude.
    // buildImplementerResponsePrompt (used for build) includes "code/tests/docs" and
    // requests testing_steps, whereas early gates use the altitude-limited revise prompt.
    const capturedProposerPrompts: string[] = [];
    const capturingImplementer: Pick<ImplementationAgent, 'implement'> = {
      implement: vi.fn().mockImplementation((_specPath: string, _workDir: string, prompt: string) => {
        capturedProposerPrompts.push(prompt);
        return Promise.resolve(makeCompleteResult({
          review_responses: [{ id: 'B1', disposition: 'fixed', response: 'Added tests.' }],
        }));
      }),
    };
    let callCount = 0;
    const readFile = vi.fn().mockImplementation(async () => {
      // Round 1 of build: blocker → triggers proposer revision; Round 2: clean
      const result = callCount === 0
        ? { status: 'findings', summary: 'Missing tests.', findings: [{ id: 'B1', severity: 'blocker', category: 'test', finding: 'No tests written.' }] }
        : { status: 'no_findings', summary: 'Clean.', findings: [] };
      callCount++;
      return JSON.stringify(result);
    });
    const deps = makeDeps(undefined, { readFile, implementer: capturingImplementer });
    deps.policy = { ...deps.policy, max_initial_rounds: 2, convergence: { enabled: true, allow_same_model: true } };
    const coordinator = new ImplementationReviewCoordinator(deps);
    const run = makeRun();

    await coordinator.runLayeredImplementation(
      { run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR },
      { altitudes: ['build'] },
    );

    // The proposer was called during the build revise round
    expect(capturedProposerPrompts.length).toBeGreaterThanOrEqual(1);
    const buildRevisePrompt = capturedProposerPrompts[0]!;

    // Build proposer must include test/docs mandate (from buildImplementerResponsePrompt)
    expect(buildRevisePrompt).toMatch(/code\/tests\/docs|tests?|testing_steps/i);

    // Build proposer must NOT contain the early-altitude altitude-contract restriction
    // (which would incorrectly limit the proposer to skeleton-only work)
    expect(buildRevisePrompt).not.toContain('do not add lower-altitude work');
  });

  it('convergence disabled falls back to single-pass and review_exchanges is used, not gate_exchanges', async () => {
    const freshDeps = makeDeps();
    freshDeps.policy = { ...freshDeps.policy, convergence: { enabled: false, allow_same_model: false } };
    const coordinator = new ImplementationReviewCoordinator(freshDeps);
    const run = makeRun();
    const original = makeCompleteResult();

    const result = await coordinator.runLayeredImplementation(
      { run, artifact_path: '/ws/spec.md', implementation_result: original, working_directory: WORKING_DIR },
      { altitudes: ['layout', 'public_api', 'build'] },
    );

    // Single-pass behavior: review_exchanges is populated, gate_exchanges is not
    expect(result).toBe(original);
    expect(run.review_exchanges).toHaveLength(1);
    expect((run as Record<string, unknown>)['gate_exchanges']).toBeUndefined();
    // Runner called at most once (single-pass review)
    expect(freshDeps.runner.run).toHaveBeenCalledTimes(1);
  });
});

describe('runLayeredImplementation — model-session budget enforcement', () => {
  it('fails before critic execution when budget is exhausted', async () => {
    // Budget with limit 0 means no sessions can be reserved
    const w = { append: vi.fn().mockResolvedValue(undefined) };
    const sessionBudget = new ModelSessionBudget({ runId: 'run-1', requestId: 'req-1', limit: 0, writer: w });

    const findingsResult: ImplementationReviewResult = {
      status: 'has_findings',
      summary: 'Blockers found.',
      findings: [{ id: 'F1', severity: 'blocker', category: 'correctness', finding: 'Missing impl.' }],
    };
    const deps = makeDeps(findingsResult);
    deps.policy = { ...deps.policy, convergence: { enabled: true, allow_same_model: true } };
    const coordinator = new ImplementationReviewCoordinator(deps);
    const run = makeRun({ id: 'run-1' });

    const result = await coordinator.runLayeredImplementation(
      { run, artifact_path: '/ws/spec.md', implementation_result: makeCompleteResult(), working_directory: WORKING_DIR, sessionBudget },
      { altitudes: ['layout', 'build'] },
    );

    expect(result.status).toBe('failed');
    expect((result as { status: 'failed'; error: string }).error).toMatch(/budget exhausted/i);
    // Runner must NOT have been called (budget rejected before provider call)
    expect(deps.runner.run).not.toHaveBeenCalled();
  });
});
