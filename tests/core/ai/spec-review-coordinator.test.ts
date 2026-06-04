import { describe, expect, it, vi } from 'vitest';
import { SpecReviewCoordinator } from '../../../src/core/ai/spec-review-coordinator.js';
import type { AgentProfile, AgentRunner, AgentRoutingPolicy, ArtifactAuthoringAgent, SpecReviewAuthorResponseResult, SpecReviewResult } from '../../../src/types/ai.js';
import type { Run } from '../../../src/types/runs.js';

const WORKING_DIR = '/ws/test';
const ARTIFACT_PATH = '/ws/test/context-human/specs/enhancement-x.md';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-001',
    request_id: 'req-001',
    intent: 'idea',
    stage: 'speccing',
    workspace_path: WORKING_DIR,
    branch: 'spec/req-001',
    artifact: { kind: 'feature_spec', local_path: ARTIFACT_PATH, status: 'drafting' },
    impl_feedback_ref: undefined,
    issue: undefined,
    attempt: 1,
    pr_url: undefined,
    last_impl_result: undefined,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeAgentProfile(name = 'review-agent'): AgentProfile {
  return { id: name, provider: 'claude_agent_sdk', model: 'claude-sonnet-4-6' };
}

function makeRoutingPolicy(reviewProfile: AgentProfile | null = makeAgentProfile()): AgentRoutingPolicy {
  return {
    resolve: vi.fn().mockImplementation((route: { task: string }) => {
      throw new Error(`No route for ${route.task}`);
    }),
    resolveOptional: vi.fn().mockImplementation((route: { task: string }) => {
      if (route.task === 'spec.review') return reviewProfile;
      if (route.task === 'artifact.revise') return makeAgentProfile('artifact-agent');
      return null;
    }),
  };
}

function makeRunner(): AgentRunner {
  return {
    run: vi.fn().mockReturnValue((async function* () {})()),
  };
}

function makeAuthoringAgent(authorResponse: SpecReviewAuthorResponseResult = {
  status: 'complete',
  responses: [{ id: 'SPEC-1', disposition: 'fixed', response: 'Updated acceptance criteria.' }],
}): Pick<ArtifactAuthoringAgent, 'respondToSpecReview'> {
  return { respondToSpecReview: vi.fn().mockResolvedValue(authorResponse) };
}

function makeDeps(
  reviewResult: SpecReviewResult = { status: 'no_findings', summary: 'Looks good.', findings: [] },
  overrides: Record<string, unknown> = {},
) {
  const reviewJson = JSON.stringify(reviewResult);
  return {
    runner: makeRunner(),
    artifactAuthoringAgent: makeAuthoringAgent(),
    routingPolicy: makeRoutingPolicy(),
    policy: { max_rounds: 1, on_review_failure: 'warn' as const, template_conformance: true },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    readFile: vi.fn().mockResolvedValue(reviewJson),
    ...overrides,
  };
}

describe('SpecReviewCoordinator', () => {
  describe('runSpecReview — no findings', () => {
    it('returns complete status without invoking author response pass', async () => {
      const d = makeDeps();
      const coordinator = new SpecReviewCoordinator(d);
      const run = makeRun();
      const result = await coordinator.runSpecReview({ run, artifact_path: ARTIFACT_PATH, working_directory: WORKING_DIR, artifact_kind: 'feature_spec' });
      expect(result.status).toBe('complete');
      expect(d.artifactAuthoringAgent.respondToSpecReview).not.toHaveBeenCalled();
    });

    it('logs spec.review.completed', async () => {
      const d = makeDeps();
      const coordinator = new SpecReviewCoordinator(d);
      const run = makeRun();
      await coordinator.runSpecReview({ run, artifact_path: ARTIFACT_PATH, working_directory: WORKING_DIR, artifact_kind: 'feature_spec' });
      const infoCalls = (d.logger.info as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(infoCalls.some(l => l['event'] === 'spec.review.completed')).toBe(true);
    });
  });

  describe('runSpecReview — missing route', () => {
    it('returns complete without invoking runner', async () => {
      const d = makeDeps({} as SpecReviewResult, { routingPolicy: makeRoutingPolicy(null) });
      const coordinator = new SpecReviewCoordinator(d);
      const run = makeRun();
      const result = await coordinator.runSpecReview({ run, artifact_path: ARTIFACT_PATH, working_directory: WORKING_DIR, artifact_kind: 'feature_spec' });
      expect(result.status).toBe('complete');
      expect(d.runner.run).not.toHaveBeenCalled();
    });

    it('logs spec.review.skipped at warn level', async () => {
      const d = makeDeps({} as SpecReviewResult, { routingPolicy: makeRoutingPolicy(null) });
      const coordinator = new SpecReviewCoordinator(d);
      const run = makeRun();
      await coordinator.runSpecReview({ run, artifact_path: ARTIFACT_PATH, working_directory: WORKING_DIR, artifact_kind: 'feature_spec' });
      expect(d.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'spec.review.skipped' }),
        expect.any(String),
      );
    });
  });

  describe('runSpecReview — findings path', () => {
    it('calls respondToSpecReview with prompt containing SPEC_REVIEW_ID tags', async () => {
      const d = makeDeps({
        status: 'findings',
        summary: 'Found issue.',
        findings: [{ id: 'SPEC-1', severity: 'warning' as const, category: 'clarity' as const, finding: 'Vague criteria.' }],
      });
      const coordinator = new SpecReviewCoordinator(d);
      const run = makeRun();
      await coordinator.runSpecReview({ run, artifact_path: ARTIFACT_PATH, working_directory: WORKING_DIR, artifact_kind: 'feature_spec' });
      expect(d.artifactAuthoringAgent.respondToSpecReview).toHaveBeenCalledWith(
        ARTIFACT_PATH,
        WORKING_DIR,
        expect.stringContaining('[SPEC_REVIEW_ID: SPEC-1]'),
        undefined,
        expect.any(Function),
        expect.anything(),
      );
    });

    it('returns complete when author responds successfully', async () => {
      const d = makeDeps({
        status: 'findings',
        summary: 'Found issue.',
        findings: [{ id: 'SPEC-1', severity: 'warning' as const, category: 'clarity' as const, finding: 'Vague.' }],
      });
      const coordinator = new SpecReviewCoordinator(d);
      const result = await coordinator.runSpecReview({ run: makeRun(), artifact_path: ARTIFACT_PATH, working_directory: WORKING_DIR, artifact_kind: 'feature_spec' });
      expect(result.status).toBe('complete');
    });

    it('calls respondToSpecReview exactly once', async () => {
      const d = makeDeps({
        status: 'findings',
        summary: 'Found issue.',
        findings: [{ id: 'SPEC-1', severity: 'blocker' as const, category: 'completeness' as const, finding: 'Missing section.' }],
      });
      const coordinator = new SpecReviewCoordinator(d);
      await coordinator.runSpecReview({ run: makeRun(), artifact_path: ARTIFACT_PATH, working_directory: WORKING_DIR, artifact_kind: 'feature_spec' });
      expect(d.artifactAuthoringAgent.respondToSpecReview).toHaveBeenCalledTimes(1);
    });
  });

  describe('runSpecReview — author needs_input', () => {
    it('returns needs_input with question when author cannot resolve a finding', async () => {
      const d = makeDeps(
        { status: 'findings', summary: 'Found issue.', findings: [{ id: 'SPEC-1', severity: 'blocker' as const, category: 'feasibility' as const, finding: 'Unclear scope.' }] },
        { artifactAuthoringAgent: makeAuthoringAgent({ status: 'needs_input', responses: [], question: 'Should the feature include migration?' }) },
      );
      const coordinator = new SpecReviewCoordinator(d);
      const result = await coordinator.runSpecReview({ run: makeRun(), artifact_path: ARTIFACT_PATH, working_directory: WORKING_DIR, artifact_kind: 'feature_spec' });
      expect(result.status).toBe('needs_input');
      expect(result.question).toBe('Should the feature include migration?');
    });
  });

  describe('runSpecReview — review model failure', () => {
    it('warn policy: returns complete and logs spec.review.degraded', async () => {
      const d = makeDeps(
        { status: 'failed', summary: '', findings: [], error: 'model unavailable' },
        { policy: { max_rounds: 1, on_review_failure: 'warn' as const, template_conformance: true } },
      );
      const coordinator = new SpecReviewCoordinator(d);
      const result = await coordinator.runSpecReview({ run: makeRun(), artifact_path: ARTIFACT_PATH, working_directory: WORKING_DIR, artifact_kind: 'feature_spec' });
      expect(result.status).toBe('complete');
      expect(d.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'spec.review.degraded' }),
        expect.any(String),
      );
    });

    it('block policy: returns failed with error', async () => {
      const d = makeDeps(
        { status: 'failed', summary: '', findings: [], error: 'model unavailable' },
        { policy: { max_rounds: 1, on_review_failure: 'block' as const, template_conformance: true } },
      );
      const coordinator = new SpecReviewCoordinator(d);
      const result = await coordinator.runSpecReview({ run: makeRun(), artifact_path: ARTIFACT_PATH, working_directory: WORKING_DIR, artifact_kind: 'feature_spec' });
      expect(result.status).toBe('failed');
      expect(result.error).toContain('model unavailable');
    });
  });

  describe('runSpecReview — full rewrite prompt forwarding', () => {
    it('author response prompt contains full rewrite instructions when requires_full_rewrite is true', async () => {
      const d = makeDeps({
        status: 'findings',
        summary: 'Template issue.',
        findings: [{ id: 'SPEC-1', severity: 'blocker' as const, category: 'template_conformance' as const, finding: 'Wrong structure.', requires_full_rewrite: true }],
      });
      const coordinator = new SpecReviewCoordinator(d);
      await coordinator.runSpecReview({ run: makeRun(), artifact_path: ARTIFACT_PATH, working_directory: WORKING_DIR, artifact_kind: 'feature_spec' });
      const call = (d.artifactAuthoringAgent.respondToSpecReview as ReturnType<typeof vi.fn>).mock.calls[0];
      const prompt = call[2] as string;
      expect(prompt).toContain('Delete the malformed original after the replacement is complete');
      expect(prompt).toContain('Rename the replacement file to the original path');
    });
  });

  describe('runSpecReview — onAgentRequest callback', () => {
    it('records agent request metadata with route task spec.review and artifact_kind', async () => {
      const d = makeDeps();
      const coordinator = new SpecReviewCoordinator(d);
      const onAgentRequest = vi.fn();
      await coordinator.runSpecReview({ run: makeRun(), artifact_path: ARTIFACT_PATH, working_directory: WORKING_DIR, artifact_kind: 'feature_spec', onAgentRequest });
      expect(onAgentRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          route: expect.objectContaining({ task: 'spec.review', artifact_kind: 'feature_spec' }),
        }),
      );
    });
  });
});
