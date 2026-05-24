import { describe, expect, it, vi } from 'vitest';
import {
  AI_ACTIVE_STAGES,
  clearAgentRequestContext,
  isAiActiveStage,
  makeRunAgentRequestRecorder,
  recordAgentRequest,
} from '../../src/core/run-ai-context.js';
import type { Run } from '../../src/types/runs.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-001',
    request_id: 'req-001',
    intent: 'idea',
    stage: 'speccing',
    workspace_path: '/ws/req-001',
    branch: 'feature/req-001',
    artifact: undefined,
    impl_feedback_ref: undefined,
    issue: undefined,
    attempt: 0,
    channel: undefined,
    conversation: undefined,
    origin: undefined,
    pr_url: undefined,
    last_impl_result: undefined,
    created_at: '2026-05-24T00:00:00.000Z',
    updated_at: '2026-05-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('run AI context helpers', () => {
  it('defines the approved AI-active stage set', () => {
    expect([...AI_ACTIVE_STAGES]).toEqual(['speccing', 'planning', 'implementing']);
    expect(isAiActiveStage('speccing')).toBe(true);
    expect(isAiActiveStage('planning')).toBe(true);
    expect(isAiActiveStage('implementing')).toBe(true);
    expect(isAiActiveStage('reviewing_spec')).toBe(false);
    expect(isAiActiveStage('reviewing_implementation')).toBe(false);
    expect(isAiActiveStage('awaiting_planning_input')).toBe(false);
    expect(isAiActiveStage('awaiting_impl_input')).toBe(false);
    expect(isAiActiveStage('pr_open')).toBe(false);
    expect(isAiActiveStage('done')).toBe(false);
    expect(isAiActiveStage('failed')).toBe(false);
  });

  it('records model and timestamp, using unknown for blank model names', () => {
    const run = makeRun();
    recordAgentRequest(run, 'claude-sonnet-4-5', new Date('2026-05-24T01:02:03.004Z'));
    expect(run.current_model).toBe('claude-sonnet-4-5');
    expect(run.last_agent_request_at).toBe('2026-05-24T01:02:03.004Z');

    recordAgentRequest(run, '   ', new Date('2026-05-24T01:03:00.000Z'));
    expect(run.current_model).toBe('unknown');
    expect(run.last_agent_request_at).toBe('2026-05-24T01:03:00.000Z');
  });

  it('records unknown when model is undefined', () => {
    const run = makeRun();
    recordAgentRequest(run, undefined, new Date('2026-05-24T01:02:03.004Z'));
    expect(run.current_model).toBe('unknown');
  });

  it('clears both metadata fields', () => {
    const run = makeRun({ current_model: 'claude-sonnet-4-5', last_agent_request_at: '2026-05-24T01:02:03.004Z' });
    clearAgentRequestContext(run);
    expect(run.current_model).toBeUndefined();
    expect(run.last_agent_request_at).toBeUndefined();
  });

  it('recorder callback mutates, persists, and logs route fields', () => {
    const run = makeRun();
    const persist = vi.fn();
    const logger = { info: vi.fn() };
    const recorder = makeRunAgentRequestRecorder(run, persist, logger);

    recorder({
      model: 'claude-sonnet-4-5',
      requested_at: '2026-05-24T01:02:03.004Z',
      route: { task: 'implementation.run', stage: 'implementing', intent: 'idea' },
    });

    expect(run.current_model).toBe('claude-sonnet-4-5');
    expect(run.last_agent_request_at).toBe('2026-05-24T01:02:03.004Z');
    expect(persist).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      {
        event: 'run.agent_request_recorded',
        run_id: 'run-001',
        request_id: 'req-001',
        model: 'claude-sonnet-4-5',
        route_task: 'implementation.run',
        route_stage: 'implementing',
        route_intent: 'idea',
      },
      'Agent request metadata recorded',
    );
  });

  it('recorder uses unknown for blank model', () => {
    const run = makeRun();
    const persist = vi.fn();
    const logger = { info: vi.fn() };
    const recorder = makeRunAgentRequestRecorder(run, persist, logger);

    recorder({
      model: '  ',
      requested_at: '2026-05-24T01:02:03.004Z',
      route: { task: 'artifact.create' },
    });

    expect(run.current_model).toBe('unknown');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'unknown' }),
      'Agent request metadata recorded',
    );
  });
});
