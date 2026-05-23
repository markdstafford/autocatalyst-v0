import { describe, it, expect, vi } from 'vitest';
import { createSetStatusHandler } from '../../../src/core/commands/set-status-command.js';
import { VALID_RUN_STAGES } from '../../../src/types/runs.js';
import type { CommandEvent } from '../../../src/types/commands.js';
import type { Run } from '../../../src/types/runs.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-uuid-001',
    request_id: 'req-001',
    intent: 'idea',
    stage: 'implementing',
    workspace_path: '/ws/req-001',
    branch: 'spec/req-001',
    artifact: undefined,
    impl_feedback_ref: undefined,
    issue: undefined,
    attempt: 0,
    channel: { provider: 'slack', id: 'C001' },
    conversation: { provider: 'slack', channel_id: 'C001', conversation_id: '1000.0' },
    origin: { provider: 'slack', channel_id: 'C001', conversation_id: '1000.0', message_id: '1000.0' },
    pr_url: undefined,
    last_impl_result: undefined,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<CommandEvent> = {}): CommandEvent {
  return {
    command: 'run.set-status',
    args: [],
    channel: { provider: 'slack', id: 'C001' },
    conversation: { provider: 'slack', channel_id: 'C001', conversation_id: '1000.0' },
    origin: { provider: 'slack', channel_id: 'C001', conversation_id: '1000.0', message_id: '1001.0' },
    author: 'U001',
    received_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('createSetStatusHandler', () => {
  it('valid stage in known thread → calls overrideRunStage, replies with old and new stage', async () => {
    const run = makeRun({ stage: 'implementing', id: 'run-uuid-001', request_id: 'req-001' });
    const findRunById = vi.fn().mockReturnValue(run);
    const overrideRunStage = vi.fn().mockReturnValue('updated');
    const handler = createSetStatusHandler({ findRunById, overrideRunStage });
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(
      makeEvent({
        args: ['reviewing_implementation'],
        inferred_context: { request_id: 'req-001' },
      }),
      reply,
    );

    expect(overrideRunStage).toHaveBeenCalledWith('req-001', 'reviewing_implementation');
    expect(reply).toHaveBeenCalledOnce();
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('run-uuid');
    expect(msg).toContain('implementing');
    expect(msg).toContain('reviewing_implementation');
    expect(msg).toContain('persisted');
  });

  it('stage text with mixed case is normalized and accepted', async () => {
    const run = makeRun({ stage: 'implementing', request_id: 'req-001' });
    const findRunById = vi.fn().mockReturnValue(run);
    const overrideRunStage = vi.fn().mockReturnValue('updated');
    const handler = createSetStatusHandler({ findRunById, overrideRunStage });
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(
      makeEvent({
        args: ['Reviewing_Implementation'],
        inferred_context: { request_id: 'req-001' },
      }),
      reply,
    );

    expect(overrideRunStage).toHaveBeenCalledWith('req-001', 'reviewing_implementation');
  });

  it('invalid stage → replies with valid stage list, does NOT call overrideRunStage', async () => {
    const run = makeRun({ request_id: 'req-001' });
    const findRunById = vi.fn().mockReturnValue(run);
    const overrideRunStage = vi.fn();
    const handler = createSetStatusHandler({ findRunById, overrideRunStage });
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(
      makeEvent({
        messageText: 'implemneting',
        inferred_context: { request_id: 'req-001' },
      }),
      reply,
    );

    expect(overrideRunStage).not.toHaveBeenCalled();
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('implemneting');
    expect(msg).toContain('Valid stages');
    for (const stage of VALID_RUN_STAGES) {
      expect(msg).toContain(stage);
    }
  });

  it('unknown thread (no inferred_context.request_id) → replies with not-in-thread error', async () => {
    const findRunById = vi.fn().mockReturnValue(undefined);
    const overrideRunStage = vi.fn();
    const handler = createSetStatusHandler({ findRunById, overrideRunStage });
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(
      makeEvent({
        messageText: 'reviewing_implementation',
        inferred_context: undefined,
      }),
      reply,
    );

    expect(overrideRunStage).not.toHaveBeenCalled();
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('thread linked to an active run');
  });

  it('stage provided via args (text command path) → updates stage', async () => {
    const run = makeRun({ stage: 'implementing', id: 'run-uuid-001', request_id: 'req-001' });
    const findRunById = vi.fn().mockReturnValue(run);
    const overrideRunStage = vi.fn().mockReturnValue('updated');
    const handler = createSetStatusHandler({ findRunById, overrideRunStage });
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(
      makeEvent({
        args: ['reviewing_implementation'],
        inferred_context: { request_id: 'req-001' },
      }),
      reply,
    );

    expect(overrideRunStage).toHaveBeenCalledWith('req-001', 'reviewing_implementation');
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('reviewing_implementation');
    expect(msg).toContain('persisted');
  });

  it('run in terminal stage (done) can be updated to any valid stage', async () => {
    const run = makeRun({ stage: 'done', id: 'run-uuid-001', request_id: 'req-001' });
    const findRunById = vi.fn().mockReturnValue(run);
    const overrideRunStage = vi.fn().mockReturnValue('updated');
    const handler = createSetStatusHandler({ findRunById, overrideRunStage });
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(
      makeEvent({
        args: ['implementing'],
        inferred_context: { request_id: 'req-001' },
      }),
      reply,
    );

    expect(overrideRunStage).toHaveBeenCalledWith('req-001', 'implementing');
    expect(reply).toHaveBeenCalledOnce();
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('done');
    expect(msg).toContain('implementing');
    expect(msg).toContain('persisted');
  });

  it('run in terminal stage (failed) can be updated to any valid stage', async () => {
    const run = makeRun({ stage: 'failed', id: 'run-uuid-001', request_id: 'req-001' });
    const findRunById = vi.fn().mockReturnValue(run);
    const overrideRunStage = vi.fn().mockReturnValue('updated');
    const handler = createSetStatusHandler({ findRunById, overrideRunStage });
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(
      makeEvent({
        args: ['reviewing_implementation'],
        inferred_context: { request_id: 'req-001' },
      }),
      reply,
    );

    expect(overrideRunStage).toHaveBeenCalledWith('req-001', 'reviewing_implementation');
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('failed');
    expect(msg).toContain('reviewing_implementation');
  });

  it('empty args and empty messageText → replies with usage error and valid stage list', async () => {
    const findRunById = vi.fn();
    const overrideRunStage = vi.fn();
    const handler = createSetStatusHandler({ findRunById, overrideRunStage });
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ args: [], messageText: '' }), reply);

    expect(overrideRunStage).not.toHaveBeenCalled();
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('ac-set-status:');
    expect(msg).toContain('Valid stages');
  });

  it('whitespace-only messageText with no args → replies with usage error', async () => {
    const findRunById = vi.fn();
    const overrideRunStage = vi.fn();
    const handler = createSetStatusHandler({ findRunById, overrideRunStage });
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ args: [], messageText: '   ' }), reply);

    expect(overrideRunStage).not.toHaveBeenCalled();
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('ac-set-status:');
  });

  it('undefined messageText with no args → replies with usage error', async () => {
    const findRunById = vi.fn();
    const overrideRunStage = vi.fn();
    const handler = createSetStatusHandler({ findRunById, overrideRunStage });
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ args: [], messageText: undefined }), reply);

    expect(overrideRunStage).not.toHaveBeenCalled();
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('ac-set-status:');
  });

  it('empty args with messageText only → does not update run (messageText fallback removed)', async () => {
    const run = makeRun({ stage: 'implementing', request_id: 'req-001' });
    const findRunById = vi.fn().mockReturnValue(run);
    const overrideRunStage = vi.fn();
    const handler = createSetStatusHandler({ findRunById, overrideRunStage });
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(
      makeEvent({
        args: [],
        messageText: 'reviewing_implementation',
        inferred_context: { request_id: 'req-001' },
      }),
      reply,
    );

    expect(overrideRunStage).not.toHaveBeenCalled();
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('ac-set-status:');
    expect(msg).toContain('Valid stages');
  });
});
