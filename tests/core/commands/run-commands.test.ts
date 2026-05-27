import { describe, it, expect, vi } from 'vitest';
import { makeRunStatusHandler, makeRunListHandler, makeRunCancelHandler, makeRunLogsHandler } from '../../../src/core/commands/run-commands.js';
import type { CommandEvent } from '../../../src/types/commands.js';
import type { Run } from '../../../src/types/runs.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-001',
    request_id: 'req-001',
    intent: 'idea',
    stage: 'speccing',
    workspace_path: '/ws/req-001',
    branch: 'spec/req-001',
    spec_path: undefined,
    publisher_ref: undefined,
    impl_feedback_ref: undefined,
    issue: undefined,
    attempt: 0,
    channel_id: 'C001',
    thread_ts: '1000.0',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<CommandEvent> = {}): CommandEvent {
  return {
    command: 'run.status',
    args: [],
    source: 'slack',
    channel_id: 'C001',
    thread_ts: '1000.0',
    author: 'U001',
    received_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('run.status handler', () => {
  it('with inferred_context.request_id → replies with stage, intent, and time in stage', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001', stage: 'speccing', intent: 'idea' }));
    const handler = makeRunStatusHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ inferred_context: { request_id: 'req-001' } }), reply);

    expect(reply).toHaveBeenCalledOnce();
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('speccing');
    expect(msg).toContain('idea');
  });

  it('includes workspace immediately after run ID when workspace is allocated', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T01:12:00.000Z'));
    try {
      const runs = new Map<string, Run>();
      runs.set('req-001', makeRun({ id: 'run-001', request_id: 'req-001', stage: 'intake', workspace_path: '/ws/req-001', updated_at: '2026-05-24T01:11:52.000Z' }));
      const handler = makeRunStatusHandler(runs);
      const reply = vi.fn().mockResolvedValue(undefined);

      await handler(makeEvent({ inferred_context: { request_id: 'req-001' } }), reply);

      expect(reply.mock.calls[0][0]).toBe([
        '*Run:* `run-001`',
        '*Workspace:* `/ws/req-001`',
        '*Intent:* `idea`',
        '*Stage:* `intake`',
        '*Time in stage:* 8s',
      ].join('\n'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows not yet allocated for empty or whitespace workspace paths', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001', workspace_path: '   ', stage: 'intake' }));
    const handler = makeRunStatusHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ inferred_context: { request_id: 'req-001' } }), reply);

    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('*Workspace:* not yet allocated');
    expect(msg).not.toContain('*Workspace:* ``');
  });

  it('shows model and relative last request for AI-active stages with metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T01:12:00.000Z'));
    try {
      const runs = new Map<string, Run>();
      runs.set('req-001', makeRun({
        id: 'run-001',
        request_id: 'req-001',
        stage: 'implementing',
        workspace_path: '/ws/req-001',
        current_model: 'claude-sonnet-4-5',
        last_agent_request_at: '2026-05-24T01:09:00.000Z',
        updated_at: '2026-05-24T01:00:48.000Z',
      }));
      const handler = makeRunStatusHandler(runs);
      const reply = vi.fn().mockResolvedValue(undefined);

      await handler(makeEvent({ inferred_context: { request_id: 'req-001' } }), reply);

      expect(reply.mock.calls[0][0]).toBe([
        '*Run:* `run-001`',
        '*Workspace:* `/ws/req-001`',
        '*Intent:* `idea`',
        '*Stage:* `implementing`',
        '*Time in stage:* 11m',
        '*Model:* `claude-sonnet-4-5`',
        '*Last request:* 3m ago',
      ].join('\n'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows AI placeholders during AI-active stages before metadata is recorded', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001', stage: 'planning' }));
    const handler = makeRunStatusHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ inferred_context: { request_id: 'req-001' } }), reply);

    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('*Model:* not yet requested');
    expect(msg).toContain('*Last request:* not yet requested');
  });

  it('omits stale AI metadata for waiting and terminal stages', async () => {
    for (const stage of ['awaiting_impl_input', 'awaiting_planning_input', 'done', 'failed'] as const) {
      const runs = new Map<string, Run>();
      runs.set('req-001', makeRun({ request_id: 'req-001', stage, current_model: 'claude-sonnet-4-5', last_agent_request_at: '2026-05-24T01:09:00.000Z' }));
      const handler = makeRunStatusHandler(runs);
      const reply = vi.fn().mockResolvedValue(undefined);

      await handler(makeEvent({ inferred_context: { request_id: 'req-001' } }), reply);

      const msg = reply.mock.calls[0][0] as string;
      expect(msg).not.toContain('*Model:*');
      expect(msg).not.toContain('*Last request:*');
    }
  });

  it('with explicit request_id as first arg → looks up by request_id; replies correctly', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001', stage: 'implementing' }));
    const handler = makeRunStatusHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ args: ['req-001'] }), reply);

    expect(reply).toHaveBeenCalledOnce();
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('implementing');
  });

  it('with explicit run.id as first arg → looks up by run.id; replies correctly', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ id: 'run-uuid-001', request_id: 'req-001', stage: 'implementing' }));
    const handler = makeRunStatusHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ args: ['run-uuid-001'] }), reply);

    expect(reply).toHaveBeenCalledOnce();
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('implementing');
  });

  it('run ID not found → replies with "no active run" message', async () => {
    const runs = new Map<string, Run>();
    const handler = makeRunStatusHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ args: ['nonexistent'] }), reply);

    expect(reply).toHaveBeenCalledWith(expect.stringContaining('no active run'));
  });

  it('no inferred context, no args → replies "no run found in this thread"', async () => {
    const runs = new Map<string, Run>();
    const handler = makeRunStatusHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent(), reply);

    expect(reply).toHaveBeenCalledWith(expect.stringMatching(/no run found/i));
  });

  it('run in terminal state (done) → reply shows final stage and status', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001', stage: 'done' }));
    const handler = makeRunStatusHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ inferred_context: { request_id: 'req-001' } }), reply);

    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('done');
  });

  it('reply posted to correct thread_ts', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001' }));
    const handler = makeRunStatusHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ thread_ts: '9999.0', inferred_context: { request_id: 'req-001' } }), reply);

    // reply fn is called by the handler; the orchestrator wires thread_ts into it
    expect(reply).toHaveBeenCalledOnce();
  });
});

describe('run.list handler', () => {
  it('no active runs → replies with "no active runs"', async () => {
    const runs = new Map<string, Run>();
    const handler = makeRunListHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'run.list' }), reply);

    expect(reply).toHaveBeenCalledWith(expect.stringMatching(/no active runs/i));
  });

  it('one active run → replies with summary including ID, stage, intent', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001', id: 'run-001', stage: 'speccing', intent: 'idea' }));
    const handler = makeRunListHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'run.list' }), reply);

    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('run-001');
    expect(msg).toContain('speccing');
    expect(msg).toContain('idea');
  });

  it('done and failed runs excluded from list', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001', id: 'run-001', stage: 'speccing' }));
    runs.set('req-002', makeRun({ request_id: 'req-002', id: 'run-002', stage: 'done' }));
    runs.set('req-003', makeRun({ request_id: 'req-003', id: 'run-003', stage: 'failed' }));
    const handler = makeRunListHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'run.list' }), reply);

    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('run-001');
    expect(msg).not.toContain('run-002');
    expect(msg).not.toContain('run-003');
  });

  it('multiple active runs → all listed', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001', id: 'run-001', stage: 'speccing' }));
    runs.set('req-002', makeRun({ request_id: 'req-002', id: 'run-002', stage: 'implementing' }));
    const handler = makeRunListHandler(runs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'run.list' }), reply);

    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('run-001');
    expect(msg).toContain('run-002');
  });
});

describe('run.cancel handler', () => {
  it('with inferred_context.request_id → cancels run; replies with confirmation', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001', stage: 'speccing' }));
    const cancelRun = vi.fn().mockReturnValue('cancelled');
    const handler = makeRunCancelHandler(runs, cancelRun);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'run.cancel', inferred_context: { request_id: 'req-001' } }), reply);

    expect(cancelRun).toHaveBeenCalledWith('req-001');
    expect(reply).toHaveBeenCalledWith(expect.stringMatching(/cancel/i));
  });

  it('with explicit ID arg → cancels by that ID; replies with confirmation', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001', stage: 'speccing' }));
    const cancelRun = vi.fn().mockReturnValue('cancelled');
    const handler = makeRunCancelHandler(runs, cancelRun);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'run.cancel', args: ['req-001'] }), reply);

    expect(cancelRun).toHaveBeenCalledWith('req-001');
  });

  it('run ID not found → replies "no active run found"', async () => {
    const runs = new Map<string, Run>();
    const cancelRun = vi.fn().mockReturnValue('not_found');
    const handler = makeRunCancelHandler(runs, cancelRun);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'run.cancel', args: ['nonexistent'] }), reply);

    expect(reply).toHaveBeenCalledWith(expect.stringContaining('no active run'));
  });

  it('no inferred context, no args → replies "no run found in this thread"', async () => {
    const runs = new Map<string, Run>();
    const cancelRun = vi.fn().mockReturnValue('not_found');
    const handler = makeRunCancelHandler(runs, cancelRun);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'run.cancel' }), reply);

    expect(reply).toHaveBeenCalledWith(expect.stringMatching(/no run found/i));
  });

  it('run already in terminal state → replies descriptively; no error thrown', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001', stage: 'done' }));
    const cancelRun = vi.fn().mockReturnValue('already_terminal');
    const handler = makeRunCancelHandler(runs, cancelRun);
    const reply = vi.fn().mockResolvedValue(undefined);

    await expect(
      handler(makeEvent({ command: 'run.cancel', inferred_context: { request_id: 'req-001' } }), reply),
    ).resolves.not.toThrow();
    expect(reply).toHaveBeenCalledWith(expect.stringMatching(/no longer active|already complete|already finished/i));
  });
});

describe('run.logs handler', () => {
  it('with inferred_context.request_id → replies with last 20 log lines in a code block', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001' }));
    const getRunLogs = vi.fn().mockReturnValue([
      '[2026-04-21T00:00:00Z] Stage: intake → speccing',
      '[2026-04-21T00:00:01Z] Stage: speccing → reviewing_spec',
    ]);
    const handler = makeRunLogsHandler(runs, getRunLogs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'run.logs', inferred_context: { request_id: 'req-001' } }), reply);

    expect(getRunLogs).toHaveBeenCalledWith('req-001');
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('speccing');
    expect(msg).toContain('```');
  });

  it('with explicit run ID arg → retrieves logs by request_id; replies correctly', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001' }));
    const getRunLogs = vi.fn().mockReturnValue(['log line 1']);
    const handler = makeRunLogsHandler(runs, getRunLogs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'run.logs', args: ['req-001'] }), reply);

    expect(getRunLogs).toHaveBeenCalledWith('req-001');
  });

  it('run ID not found → replies "no active run found"', async () => {
    const runs = new Map<string, Run>();
    const getRunLogs = vi.fn().mockReturnValue([]);
    const handler = makeRunLogsHandler(runs, getRunLogs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'run.logs', args: ['nonexistent'] }), reply);

    expect(reply).toHaveBeenCalledWith(expect.stringContaining('no active run'));
  });

  it('no inferred context, no args → replies "no run found in this thread"', async () => {
    const runs = new Map<string, Run>();
    const getRunLogs = vi.fn().mockReturnValue([]);
    const handler = makeRunLogsHandler(runs, getRunLogs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'run.logs' }), reply);

    expect(reply).toHaveBeenCalledWith(expect.stringMatching(/no run found/i));
  });

  it('empty log tail → replies "no log entries found for this run"', async () => {
    const runs = new Map<string, Run>();
    runs.set('req-001', makeRun({ request_id: 'req-001' }));
    const getRunLogs = vi.fn().mockReturnValue([]);
    const handler = makeRunLogsHandler(runs, getRunLogs);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ command: 'run.logs', inferred_context: { request_id: 'req-001' } }), reply);

    expect(reply).toHaveBeenCalledWith(expect.stringMatching(/no log entries/i));
  });
});
