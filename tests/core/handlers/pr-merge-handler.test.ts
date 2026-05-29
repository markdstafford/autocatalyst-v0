import { describe, expect, it, vi } from 'vitest';
import { PrMergeHandler } from '../../../src/core/handlers/pr-merge-handler.js';
import type { ThreadMessage } from '../../../src/types/events.js';
import type { Run } from '../../../src/types/runs.js';
import { TEST_CHANNEL, TEST_CONVERSATION, TEST_ORIGIN } from '../../helpers/channel-refs.js';

function makeFeedback(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    request_id: 'request-001',
    channel: TEST_CHANNEL,
    conversation: TEST_CONVERSATION,
    origin: TEST_ORIGIN,
    content: 'merge it',
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
    stage: 'pr_open',
    workspace_path: '/ws/request-001',
    branch: 'spec/request-001',
    spec_path: '/ws/request-001/context-human/specs/feature-test.md',
    publisher_ref: 'CANVAS001',
    artifact: undefined,
    impl_feedback_ref: undefined,
    issue: undefined,
    attempt: 1,
    pr_url: 'https://example.test/org/repo/pull/42',
    channel: TEST_CHANNEL,
    conversation: TEST_CONVERSATION,
    origin: TEST_ORIGIN,
    last_impl_result: undefined,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeHandler(overrides: Partial<ConstructorParameters<typeof PrMergeHandler>[0]> = {}) {
  const deps = {
    prManager: {
      mergePR: vi.fn().mockResolvedValue(undefined),
    },
    postMessage: vi.fn().mockResolvedValue(undefined),
    transition: vi.fn((run: Run, stage: Run['stage']) => { run.stage = stage; }),
    failRun: vi.fn().mockResolvedValue(undefined),
    reactToRunMessage: vi.fn().mockResolvedValue(undefined),
    reacjiComplete: 'white_check_mark',
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
    ...overrides,
  };

  return { handler: new PrMergeHandler(deps), deps };
}

describe('PrMergeHandler', () => {
  it('merges the PR, posts confirmation, marks the run done, and reacts to the source message', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'done' });
    expect(deps.prManager.mergePR).toHaveBeenCalledWith('/ws/request-001', 'https://example.test/org/repo/pull/42');
    expect(deps.postMessage).toHaveBeenCalledWith(TEST_CONVERSATION, 'PR merged.');
    expect(run.stage).toBe('done');
    expect(deps.reactToRunMessage).toHaveBeenCalledWith(run, 'white_check_mark');
  });

  it('posts a guard message and does not merge when the run has no PR URL', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({ pr_url: undefined });

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'missing_pr_url' });
    expect(deps.prManager.mergePR).not.toHaveBeenCalled();
    expect(deps.postMessage).toHaveBeenCalledWith(TEST_CONVERSATION, expect.stringContaining('no PR URL'));
    expect(run.stage).toBe('pr_open');
  });

  it('fails the run when mergePR fails', async () => {
    const error = new Error('merge conflict');
    const { handler, deps } = makeHandler({
      prManager: {
        mergePR: vi.fn().mockRejectedValue(error),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, error);
  });

  it('does not fail the run when confirmation or completion reaction fails', async () => {
    const { handler, deps } = makeHandler({
      postMessage: vi.fn().mockRejectedValue(new Error('channel failed')),
      reactToRunMessage: vi.fn().mockRejectedValue(new Error('reaction failed')),
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'done' });
    expect(deps.failRun).not.toHaveBeenCalled();
    expect(run.stage).toBe('done');
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.notify_failed', run_id: 'run-001' }),
      'Failed to post PR merged notification',
    );
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.notify_failed', run_id: 'run-001' }),
      'Failed to post completion reaction',
    );
  });
});

describe('PrMergeHandler — auto-prune', () => {
  it('auto-prunes workspace after successful merge when enabled', async () => {
    const workspacePruner = { prune: vi.fn().mockResolvedValue({ status: 'deleted', workspace_path: '/ws/request-001', workspace_root: '/ws' }) };
    const persist = vi.fn();
    const { handler, deps } = makeHandler({
      autoPruneWorkspace: true,
      workspacePruner,
      workspaceRootForRun: () => '/ws',
      persist,
    });
    const run = makeRun({ workspace_path: '/ws/request-001' });

    const result = await handler.handle(run, makeFeedback());

    // Allow async auto-prune to complete
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(result).toEqual({ status: 'done' });
    expect(workspacePruner.prune).toHaveBeenCalledWith({
      run_id: run.id,
      request_id: run.request_id,
      workspace_root: '/ws',
      workspace_path: '/ws/request-001',
      mode: 'auto',
      allowEmpty: true,
    });
    expect(run.workspace_path).toBe('');
    expect(persist).toHaveBeenCalled();
  });

  it('does not auto-prune when autoPruneWorkspace is false', async () => {
    const workspacePruner = { prune: vi.fn() };
    const { handler } = makeHandler({
      autoPruneWorkspace: false,
      workspacePruner,
      workspaceRootForRun: () => '/ws',
      persist: vi.fn(),
    });
    const run = makeRun();

    await handler.handle(run, makeFeedback());
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(workspacePruner.prune).not.toHaveBeenCalled();
  });

  it('leaves workspace_path unchanged when pruner fails', async () => {
    const workspacePruner = { prune: vi.fn().mockResolvedValue({ status: 'failed', workspace_path: '/ws/request-001', workspace_root: '/ws', error: new Error('rm failed') }) };
    const persist = vi.fn();
    const { handler } = makeHandler({
      autoPruneWorkspace: true,
      workspacePruner,
      workspaceRootForRun: () => '/ws',
      persist,
    });
    const run = makeRun({ workspace_path: '/ws/request-001' });

    const result = await handler.handle(run, makeFeedback());
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(result).toEqual({ status: 'done' });
    expect(run.workspace_path).toBe('/ws/request-001'); // unchanged
    expect(persist).not.toHaveBeenCalled();
  });

  it('does not auto-prune when merge fails', async () => {
    const workspacePruner = { prune: vi.fn() };
    const { handler } = makeHandler({
      autoPruneWorkspace: true,
      workspacePruner,
      workspaceRootForRun: () => '/ws',
      persist: vi.fn(),
      prManager: { mergePR: vi.fn().mockRejectedValue(new Error('merge failed')) },
    });

    const result = await handler.handle(makeRun(), makeFeedback());
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(result).toEqual({ status: 'failed' });
    expect(workspacePruner.prune).not.toHaveBeenCalled();
  });
});
