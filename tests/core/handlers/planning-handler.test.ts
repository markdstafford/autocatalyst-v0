import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanningHandler } from '../../../src/core/handlers/planning-handler.js';
import type { ThreadMessage } from '../../../src/types/events.js';
import type { Run } from '../../../src/types/runs.js';
import { TEST_CHANNEL, TEST_CONVERSATION, TEST_ORIGIN } from '../../helpers/channel-refs.js';

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
    stage: 'planning',
    workspace_path: '/ws/request-001',
    branch: 'spec/request-001',
    artifact: {
      kind: 'feature_spec',
      local_path: '/ws/request-001/context-human/specs/feature-test.md',
      published_ref: { provider: 'artifact_publisher', id: 'CANVAS001' },
      status: 'approved',
    },
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

function makeHandler(overrides: Partial<ConstructorParameters<typeof PlanningHandler>[0]> = {}) {
  const deps = {
    planner: {
      plan: vi.fn().mockResolvedValue({ status: 'complete', plan_path: '/ws/request-001/docs/superpowers/plans/implementation-plan.md' }),
    },
    postMessage: vi.fn().mockResolvedValue(undefined),
    transition: vi.fn((run: Run, stage: Run['stage']) => { run.stage = stage; }),
    failRun: vi.fn().mockResolvedValue(undefined),
    persist: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    validatePlanPath: vi.fn((_workspacePath: string, planPath: string) => planPath),
    ...overrides,
  };
  return { handler: new PlanningHandler(deps), deps };
}

function makeWorkspaceWithPlan(): { workspace: string; planPath: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'ac-planning-handler-'));
  const plansDir = join(workspace, 'docs', 'superpowers', 'plans');
  mkdirSync(plansDir, { recursive: true });
  const planPath = join(plansDir, 'implementation-plan.md');
  writeFileSync(planPath, '# Implementation plan\n', 'utf8');
  return { workspace: realpathSync(workspace), planPath: realpathSync(planPath) };
}

describe('PlanningHandler', () => {
  it('stores the plan path, persists, and transitions to implementing on success', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'implementing', plan_path: '/ws/request-001/docs/superpowers/plans/implementation-plan.md' });
    expect(deps.planner.plan).toHaveBeenCalledWith(
      '/ws/request-001/context-human/specs/feature-test.md',
      '/ws/request-001',
      expect.any(Function),
      expect.objectContaining({ run_id: 'run-001', request_id: 'request-001' }),
      undefined,
    );
    expect(run.implementation_plan_path).toBe('/ws/request-001/docs/superpowers/plans/implementation-plan.md');
    expect(deps.persist).toHaveBeenCalled();
    expect(run.stage).toBe('implementing');
    expect(deps.failRun).not.toHaveBeenCalled();
  });

  it('asks for input and does not start implementation when planning needs input', async () => {
    const { handler, deps } = makeHandler({
      planner: { plan: vi.fn().mockResolvedValue({ status: 'needs_input', question: 'Which scope?' }) },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'needs_input' });
    expect(deps.postMessage).toHaveBeenCalledWith(TEST_CONVERSATION, expect.stringContaining('Which scope?'));
    expect(run.stage).toBe('awaiting_planning_input');
    expect(run.implementation_plan_path).toBeUndefined();
  });

  it('passes human follow-up context when re-running planning', async () => {
    const planner = {
      plan: vi.fn().mockResolvedValue({ status: 'complete', plan_path: '/ws/request-001/docs/superpowers/plans/implementation-plan.md' }),
    };
    const { handler } = makeHandler({ planner });
    const run = makeRun({ stage: 'awaiting_planning_input' });

    const result = await handler.handle(run, makeFeedback({ content: 'Use the adapter composition path.' }), 'Use the adapter composition path.');

    expect(result).toEqual({ status: 'implementing', plan_path: '/ws/request-001/docs/superpowers/plans/implementation-plan.md' });
    expect(planner.plan).toHaveBeenCalledWith(
      '/ws/request-001/context-human/specs/feature-test.md',
      '/ws/request-001',
      expect.any(Function),
      expect.objectContaining({ run_id: 'run-001', request_id: 'request-001' }),
      'Use the adapter composition path.',
    );
  });

  it('onAgentRequest callback updates run fields and persists', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun();

    await handler.handle(run, makeFeedback());

    const planCall = (deps.planner.plan as ReturnType<typeof vi.fn>).mock.calls[0];
    const telemetry = planCall[3] as { onAgentRequest?: (metadata: { model: string; requested_at: string; route: { task: string } }) => void };
    telemetry.onAgentRequest?.({ model: 'claude-opus-4-5', requested_at: '2026-01-01T00:00:00.000Z', route: { task: 'some.task' } });

    expect(run.current_model).toBe('claude-opus-4-5');
    expect(run.last_agent_request_at).toBe('2026-01-01T00:00:00.000Z');
    expect(deps.persist).toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.agent_request_recorded', run_id: 'run-001' }),
      expect.any(String),
    );
  });

  it('fails the run when planning returns malformed complete output', async () => {
    const { handler, deps } = makeHandler({
      planner: { plan: vi.fn().mockResolvedValue({ status: 'complete' }) },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, expect.any(Error));
    expect(run.stage).toBe('planning');
  });

  it('canonicalizes an existing plan path under docs/superpowers/plans before storing it', async () => {
    const { workspace, planPath } = makeWorkspaceWithPlan();
    const { handler } = makeHandler({
      planner: { plan: vi.fn().mockResolvedValue({ status: 'complete', plan_path: 'docs/superpowers/plans/implementation-plan.md' }) },
      validatePlanPath: undefined,
    });
    const run = makeRun({
      workspace_path: workspace,
      artifact: {
        kind: 'feature_spec',
        local_path: join(workspace, 'context-human', 'specs', 'feature-test.md'),
        published_ref: { provider: 'artifact_publisher', id: 'CANVAS001' },
        status: 'approved',
      },
    });

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'implementing', plan_path: planPath });
    expect(run.implementation_plan_path).toBe(planPath);
  });

  it('fails the run when plan_path is outside workspace docs/superpowers/plans', async () => {
    const { workspace } = makeWorkspaceWithPlan();
    const outsidePlan = join(workspace, 'outside-plan.md');
    writeFileSync(outsidePlan, '# Outside plan\n', 'utf8');
    const { handler, deps } = makeHandler({
      planner: { plan: vi.fn().mockResolvedValue({ status: 'complete', plan_path: outsidePlan }) },
      validatePlanPath: undefined,
    });
    const run = makeRun({ workspace_path: workspace });

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, expect.any(Error));
    expect(run.implementation_plan_path).toBeUndefined();
  });

  it('fails the run when planning agent returns failed status', async () => {
    const { handler, deps } = makeHandler({
      planner: { plan: vi.fn().mockResolvedValue({ status: 'failed', error: 'agent timed out' }) },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, expect.objectContaining({ message: 'agent timed out' }));
    expect(run.stage).toBe('planning');
  });
});
