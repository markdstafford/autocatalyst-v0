import { describe, it, expect, vi } from 'vitest';
import { makePruneHandler, makePruneConfirmHandler } from '../../../src/core/commands/prune-command.js';
import type { Run } from '../../../src/types/runs.js';
import type { CommandEvent } from '../../../src/types/commands.js';

function makeRun(overrides: Partial<Run> & { request_id: string }): Run {
  return {
    id: overrides.id ?? `id-${overrides.request_id}`,
    request_id: overrides.request_id,
    intent: 'idea',
    stage: overrides.stage ?? 'done',
    workspace_path: overrides.workspace_path ?? `/workspaces/${overrides.request_id}`,
    branch: 'main',
    impl_feedback_ref: undefined,
    issue: undefined,
    attempt: 1,
    pr_url: undefined,
    last_impl_result: undefined,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00.000Z',
    channel: overrides.channel ?? { provider: 'slack', id: 'C123' },
    conversation: overrides.conversation ?? { provider: 'slack', channel_id: 'C123', conversation_id: `ts-${overrides.request_id}` },
    ...overrides,
  };
}

function makeEvent(args: string[], overrides?: Partial<CommandEvent>): CommandEvent {
  return {
    command: 'prune',
    args,
    channel: { provider: 'slack', id: 'C123' },
    conversation: { provider: 'slack', channel_id: 'C123', conversation_id: 'root-ts' },
    origin: { provider: 'slack', channel_id: 'C123', conversation_id: 'root-ts', message_id: 'root-ts' },
    author: 'U123',
    received_at: '2026-05-28T00:00:00.000Z',
    ...overrides,
  };
}

function makeDeps(runs: Map<string, Run> = new Map()) {
  const replies: string[] = [];
  const replyFn = async (text: string) => { replies.push(text); };
  const confirmationRegistry = {
    create: vi.fn().mockReturnValue({ id: 'conf-001' }),
    consume: vi.fn(),
    hasPending: vi.fn().mockReturnValue(false),
    sweepExpired: vi.fn().mockReturnValue(0),
  };
  const workspacePruner = { prune: vi.fn() };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps = {
    runs,
    confirmationRegistry,
    workspacePruner: workspacePruner as any,
    channelRepoMap: new Map(),
    persist: vi.fn(),
    logger,
  };
  return { deps, replyFn, replies, confirmationRegistry, logger };
}

describe('makePruneHandler', () => {
  it('completed mode selects only done runs for the command channel', async () => {
    const runs = new Map([
      ['req-001', makeRun({ request_id: 'req-001', stage: 'done' })],
      ['req-002', makeRun({ request_id: 'req-002', stage: 'failed' })],
      ['req-003', makeRun({ request_id: 'req-003', stage: 'implementing' })],
    ]);
    const { deps, replyFn, confirmationRegistry } = makeDeps(runs);
    const handler = makePruneHandler(deps);
    await handler(makeEvent(['completed']), replyFn);
    expect(confirmationRegistry.create).toHaveBeenCalledOnce();
    const payload = confirmationRegistry.create.mock.calls[0][0].payload;
    expect(payload.request_ids).toEqual(['req-001']);
    expect(payload.mode).toBe('completed');
  });

  it('completed mode excludes runs from a different channel', async () => {
    const runs = new Map([
      ['req-001', makeRun({ request_id: 'req-001', stage: 'done', channel: { provider: 'slack', id: 'CDIFFERENT' } })],
    ]);
    const { deps, replyFn, replies } = makeDeps(runs);
    const handler = makePruneHandler(deps);
    await handler(makeEvent(['completed']), replyFn);
    expect(replies[0]).toContain('No completed runs found');
    expect(replies.length).toBe(1);
  });

  it('completed mode excludes failed, pr_open, and active stages', async () => {
    const runs = new Map([
      ['req-001', makeRun({ request_id: 'req-001', stage: 'failed' })],
      ['req-002', makeRun({ request_id: 'req-002', stage: 'pr_open' })],
      ['req-003', makeRun({ request_id: 'req-003', stage: 'implementing' })],
      ['req-004', makeRun({ request_id: 'req-004', stage: 'done' })],
    ]);
    const { deps, replyFn, confirmationRegistry } = makeDeps(runs);
    await makePruneHandler(deps)(makeEvent(['completed']), replyFn);
    const payload = confirmationRegistry.create.mock.calls[0][0].payload;
    expect(payload.request_ids).toEqual(['req-004']);
  });

  it('completed mode sorts by updated_at ascending then request_id ascending', async () => {
    const runs = new Map([
      ['req-b', makeRun({ request_id: 'req-b', stage: 'done', updated_at: '2026-01-03T00:00:00.000Z' })],
      ['req-a', makeRun({ request_id: 'req-a', stage: 'done', updated_at: '2026-01-01T00:00:00.000Z' })],
      ['req-c', makeRun({ request_id: 'req-c', stage: 'done', updated_at: '2026-01-01T00:00:00.000Z' })],
    ]);
    const { deps, replyFn, confirmationRegistry } = makeDeps(runs);
    await makePruneHandler(deps)(makeEvent(['completed']), replyFn);
    const payload = confirmationRegistry.create.mock.calls[0][0].payload;
    expect(payload.request_ids).toEqual(['req-a', 'req-c', 'req-b']);
  });

  it('explicit IDs resolve by request_id', async () => {
    const runs = new Map([['req-001', makeRun({ request_id: 'req-001' })]]);
    const { deps, replyFn, confirmationRegistry } = makeDeps(runs);
    await makePruneHandler(deps)(makeEvent(['req-001']), replyFn);
    expect(confirmationRegistry.create).toHaveBeenCalledOnce();
    const payload = confirmationRegistry.create.mock.calls[0][0].payload;
    expect(payload.request_ids).toEqual(['req-001']);
    expect(payload.mode).toBe('explicit');
  });

  it('explicit IDs resolve by run.id', async () => {
    const run = makeRun({ request_id: 'req-001', id: 'uuid-abc-123' });
    const runs = new Map([['req-001', run]]);
    const { deps, replyFn, confirmationRegistry } = makeDeps(runs);
    await makePruneHandler(deps)(makeEvent(['uuid-abc-123']), replyFn);
    expect(confirmationRegistry.create).toHaveBeenCalledOnce();
    const payload = confirmationRegistry.create.mock.calls[0][0].payload;
    expect(payload.request_ids).toEqual(['req-001']);
  });

  it('multiple IDs deduplicate preserving order', async () => {
    const runs = new Map([
      ['req-001', makeRun({ request_id: 'req-001' })],
      ['req-002', makeRun({ request_id: 'req-002' })],
    ]);
    const { deps, replyFn, confirmationRegistry } = makeDeps(runs);
    // req-001 appears twice (once by request_id, once by run id)
    const run1 = runs.get('req-001')!;
    await makePruneHandler(deps)(makeEvent(['req-002', 'req-001', run1.id]), replyFn);
    expect(confirmationRegistry.create).toHaveBeenCalledOnce();
    const payload = confirmationRegistry.create.mock.calls[0][0].payload;
    expect(payload.request_ids).toEqual(['req-002', 'req-001']);
  });

  it('unknown IDs reject without creating pending confirmation', async () => {
    const { deps, replyFn, replies, confirmationRegistry } = makeDeps(new Map());
    await makePruneHandler(deps)(makeEvent(['unknown-id']), replyFn);
    expect(confirmationRegistry.create).not.toHaveBeenCalled();
    expect(replies.length).toBe(1);
    expect(replies[0]).toContain('unknown-id');
  });

  it('non-terminal IDs without --active reject without creating pending', async () => {
    const runs = new Map([
      ['req-001', makeRun({ request_id: 'req-001', stage: 'implementing' })],
    ]);
    const { deps, replyFn, replies, confirmationRegistry } = makeDeps(runs);
    await makePruneHandler(deps)(makeEvent(['req-001']), replyFn);
    expect(confirmationRegistry.create).not.toHaveBeenCalled();
    expect(replies.length).toBe(1);
    expect(replies[0]).toContain('implementing');
  });

  it('non-terminal IDs with --active create preview with ACTIVE text', async () => {
    const runs = new Map([
      ['req-001', makeRun({ request_id: 'req-001', stage: 'implementing' })],
    ]);
    const { deps, replyFn, replies, confirmationRegistry } = makeDeps(runs);
    await makePruneHandler(deps)(makeEvent(['req-001', '--active']), replyFn);
    expect(confirmationRegistry.create).toHaveBeenCalledOnce();
    const payload = confirmationRegistry.create.mock.calls[0][0].payload;
    expect(payload.allow_active).toBe(true);
    expect(replies[0]).toContain('ACTIVE');
  });

  it('empty args return usage without creating pending confirmation', async () => {
    const { deps, replyFn, replies, confirmationRegistry } = makeDeps(new Map());
    await makePruneHandler(deps)(makeEvent([]), replyFn);
    expect(confirmationRegistry.create).not.toHaveBeenCalled();
    expect(replies.length).toBe(1);
    expect(replies[0]).toContain('Usage:');
  });

  it('only --active with no positional args returns usage', async () => {
    const { deps, replyFn, replies, confirmationRegistry } = makeDeps(new Map());
    await makePruneHandler(deps)(makeEvent(['--active']), replyFn);
    expect(confirmationRegistry.create).not.toHaveBeenCalled();
    expect(replies[0]).toContain('Usage:');
  });

  it('sweepExpired is called and logs when count > 0', async () => {
    const { deps, replyFn, logger, confirmationRegistry } = makeDeps(new Map());
    confirmationRegistry.sweepExpired.mockReturnValue(3);
    await makePruneHandler(deps)(makeEvent([]), replyFn);
    expect(confirmationRegistry.sweepExpired).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'prune.expired', count: 3 }),
      expect.any(String),
    );
  });

  it('preview text contains run details', async () => {
    const runs = new Map([
      ['req-001', makeRun({
        request_id: 'req-001',
        id: 'abcdef1234567',
        stage: 'done',
        workspace_path: '/workspaces/req-001',
        conversation: { provider: 'slack', channel_id: 'C123', conversation_id: 'ts-req-001' },
      })],
    ]);
    const { deps, replyFn, replies } = makeDeps(runs);
    await makePruneHandler(deps)(makeEvent(['req-001']), replyFn);
    expect(replies[0]).toContain('abcdef1');
    expect(replies[0]).toContain('req-001');
    expect(replies[0]).toContain('done');
    expect(replies[0]).toContain('/workspaces/req-001');
    expect(replies[0]).toContain('C123');
    expect(replies[0]).toContain('ts-req-001');
  });

  it('preview text shows (none) for empty workspace_path', async () => {
    const runs = new Map([
      ['req-001', makeRun({ request_id: 'req-001', stage: 'done', workspace_path: '' })],
    ]);
    const { deps, replyFn, replies } = makeDeps(runs);
    await makePruneHandler(deps)(makeEvent(['req-001']), replyFn);
    expect(replies[0]).toContain('(none)');
  });

  it('preview text shows (unknown) for runs without conversation', async () => {
    const run = makeRun({ request_id: 'req-001', stage: 'done' });
    delete (run as any).conversation;
    const runs = new Map([['req-001', run]]);
    const { deps, replyFn, replies } = makeDeps(runs);
    await makePruneHandler(deps)(makeEvent(['req-001']), replyFn);
    expect(replies[0]).toContain('(unknown)');
  });

  it('logs prune.preview_created with correct fields', async () => {
    const runs = new Map([['req-001', makeRun({ request_id: 'req-001', stage: 'done' })]]);
    const { deps, replyFn, logger } = makeDeps(runs);
    await makePruneHandler(deps)(makeEvent(['completed']), replyFn);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'prune.preview_created',
        mode: 'completed',
        count: 1,
        author: 'U123',
        channel_id: 'C123',
      }),
      expect.any(String),
    );
  });
});

describe('makePruneConfirmHandler', () => {
  it('executes prune when response is exactly Yes', async () => {
    const run = makeRun({ request_id: 'req-001', stage: 'done' });
    const runs = new Map([['req-001', run]]);
    const { deps, replyFn, replies, confirmationRegistry } = makeDeps(runs);

    // Set up consumed confirmation
    confirmationRegistry.consume = vi.fn().mockReturnValue({
      id: 'conf-001',
      command: 'prune',
      conversation: makeEvent([]).conversation,
      requested_by: 'U123',
      expires_at: '2026-05-28T00:10:00.000Z',
      payload: { mode: 'completed', request_ids: ['req-001'], allow_active: false },
      response: 'Yes',
    });

    // Need a workspace root in channelRepoMap for the run's channel
    deps.channelRepoMap = new Map([['slack:C123', { channel_ref: 'slack:C123', repo_url: 'git@github.com:x/y.git', workspace_root: '/workspaces' }]]);
    deps.workspacePruner.prune = vi.fn().mockResolvedValue({ status: 'deleted', workspace_path: run.workspace_path, workspace_root: '/workspaces' });

    const handler = makePruneConfirmHandler(deps);
    await handler(makeEvent([], { messageText: 'Yes' }), replyFn);

    expect(deps.workspacePruner.prune).toHaveBeenCalledOnce();
    expect(deps.persist).toHaveBeenCalled();
    expect(runs.has('req-001')).toBe(false);
    expect(replies[0]).toContain('Prune complete');
    expect(replies[0]).toContain('OK:');
  });

  it('cancels when response is not exactly Yes', async () => {
    const { deps, replyFn, replies, confirmationRegistry } = makeDeps();
    confirmationRegistry.consume = vi.fn().mockReturnValue({
      id: 'conf-001', command: 'prune', conversation: makeEvent([]).conversation,
      requested_by: 'U123', expires_at: '2026-05-28T00:10:00.000Z',
      payload: { mode: 'completed', request_ids: [], allow_active: false },
      response: 'yes',
    });

    const handler = makePruneConfirmHandler(deps);
    await handler(makeEvent([], { messageText: 'yes' }), replyFn);

    expect(replies[0]).toBe('Prune cancelled.');
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('replies no pending when consume returns undefined', async () => {
    const { deps, replyFn, replies, confirmationRegistry } = makeDeps();
    confirmationRegistry.consume = vi.fn().mockReturnValue(undefined);

    const handler = makePruneConfirmHandler(deps);
    await handler(makeEvent([], { messageText: 'Yes' }), replyFn);

    expect(replies[0]).toBe('No pending prune confirmation.');
  });

  it('leaves run intact when workspace guard rejects', async () => {
    const run = makeRun({ request_id: 'req-001', workspace_path: '/workspaces/req-001' });
    const runs = new Map([['req-001', run]]);
    const { deps, replyFn, replies, confirmationRegistry } = makeDeps(runs);

    confirmationRegistry.consume = vi.fn().mockReturnValue({
      id: 'conf-001', command: 'prune', conversation: makeEvent([]).conversation,
      requested_by: 'U123', expires_at: '2026-05-28T00:10:00.000Z',
      payload: { mode: 'explicit', request_ids: ['req-001'], allow_active: false },
      response: 'Yes',
    });

    deps.channelRepoMap = new Map([['slack:C123', { channel_ref: 'slack:C123', repo_url: 'git@x.git', workspace_root: '/workspaces' }]]);

    // Workspace pruner returns rejected
    const guardError = new (await import('../../../src/core/workspace-pruner.js')).WorkspacePathGuardError('rejected', {});
    deps.workspacePruner.prune = vi.fn().mockResolvedValue({ status: 'rejected', error: guardError });

    const handler = makePruneConfirmHandler(deps);
    await handler(makeEvent([], { messageText: 'Yes' }), replyFn);

    // Run should still be in the map
    expect(runs.has('req-001')).toBe(true);
    expect(replies[0]).toContain('Failed:');
  });

  it('skips run changed from done after preview in completed mode', async () => {
    const run = makeRun({ request_id: 'req-001', stage: 'implementing' }); // stage changed to non-done
    const runs = new Map([['req-001', run]]);
    const { deps, replyFn, replies, confirmationRegistry } = makeDeps(runs);

    confirmationRegistry.consume = vi.fn().mockReturnValue({
      id: 'conf-001', command: 'prune', conversation: makeEvent([]).conversation,
      requested_by: 'U123', expires_at: '2026-05-28T00:10:00.000Z',
      payload: { mode: 'completed', request_ids: ['req-001'], allow_active: false },
      response: 'Yes',
    });

    const handler = makePruneConfirmHandler(deps);
    await handler(makeEvent([], { messageText: 'Yes' }), replyFn);

    expect(runs.has('req-001')).toBe(true); // not deleted
    expect(replies[0]).toContain('Failed:');
  });

  it('prunes slack thread and reports partial failures', async () => {
    const run = makeRun({ request_id: 'req-001' });
    const runs = new Map([['req-001', run]]);
    const { deps, replyFn, replies, confirmationRegistry } = makeDeps(runs);

    confirmationRegistry.consume = vi.fn().mockReturnValue({
      id: 'conf-001', command: 'prune', conversation: makeEvent([]).conversation,
      requested_by: 'U123', expires_at: '2026-05-28T00:10:00.000Z',
      payload: { mode: 'explicit', request_ids: ['req-001'], allow_active: false },
      response: 'Yes',
    });

    deps.channelRepoMap = new Map([['slack:C123', { channel_ref: 'slack:C123', repo_url: 'git@x.git', workspace_root: '/workspaces' }]]);
    deps.workspacePruner.prune = vi.fn().mockResolvedValue({ status: 'deleted', workspace_path: '/workspaces/req-001', workspace_root: '/workspaces' });

    const threadPruner = { pruneThread: vi.fn().mockResolvedValue({ status: 'partial', deleted_messages: 2, failed_messages: [{ message_id: 'ts1', error: 'cant_delete' }], errors: ['cant_delete'] }) };
    deps.threadPruner = threadPruner;

    const handler = makePruneConfirmHandler(deps);
    await handler(makeEvent([], { messageText: 'Yes' }), replyFn);

    expect(runs.has('req-001')).toBe(false); // deleted despite partial Slack failure
    expect(replies[0]).toContain('OK:');
    expect(replies[0]).toContain('partially');
  });
});
