import { describe, expect, it, vi } from 'vitest';
import { IssueFilingHandler } from '../../../src/core/handlers/issue-filing-handler.js';
import type { Request } from '../../../src/types/events.js';
import type { Run } from '../../../src/types/runs.js';
import { TEST_CHANNEL, TEST_CONVERSATION, TEST_ORIGIN, testChannelBinding } from '../../helpers/channel-refs.js';

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: 'request-001',
    channel: TEST_CHANNEL,
    conversation: TEST_CONVERSATION,
    origin: TEST_ORIGIN,
    content: 'file the issues in this thread',
    author: 'U123',
    received_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-001',
    request_id: 'request-001',
    intent: 'file_issues',
    stage: 'intake',
    workspace_path: '',
    branch: '',
    spec_path: undefined,
    publisher_ref: undefined,
    artifact: undefined,
    impl_feedback_ref: undefined,
    issue: undefined,
    attempt: 0,
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

function makeHandler(overrides: Partial<ConstructorParameters<typeof IssueFilingHandler>[0]> = {}) {
  const deps = {
    workspaceManager: {
      create: vi.fn().mockResolvedValue({ workspace_path: '/ws/request-001', branch: 'file/request-001' }),
      destroy: vi.fn().mockResolvedValue(undefined),
    },
    issueFiler: {
      file: vi.fn().mockResolvedValue({
        status: 'complete',
        summary: 'Filed 1 new issue: #10 New issue',
        filed_issues: [
          { number: 10, title: 'New issue', action: 'filed' },
          { number: 45, title: 'Duplicate issue', action: 'duplicate' },
        ],
      }),
    },
    channelRepoMap: new Map([
      testChannelBinding(),
    ]),
    postMessage: vi.fn().mockResolvedValue(undefined),
    transition: vi.fn((run: Run, stage: Run['stage']) => { run.stage = stage; }),
    failRun: vi.fn().mockResolvedValue(undefined),
    persist: vi.fn(),
    reactToRunMessage: vi.fn().mockResolvedValue(undefined),
    reacjiComplete: 'white_check_mark',
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };

  return { handler: new IssueFilingHandler(deps), deps };
}

describe('IssueFilingHandler', () => {
  it('creates a workspace, files issues, emits issue events, posts the summary, and marks the run done', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun();
    const request = makeRequest();

    const result = await handler.handle(run, request);

    expect(result).toEqual({ status: 'done' });
    expect(deps.workspaceManager.create).toHaveBeenCalledWith('request-001', 'https://example.test/org/repo.git', '/tmp/workspaces');
    expect(run.workspace_path).toBe('/ws/request-001');
    expect(run.branch).toBe('file/request-001');
    expect(deps.issueFiler.file).toHaveBeenCalledWith(request, '/ws/request-001', expect.any(Function), expect.objectContaining({ run_id: 'run-001', request_id: 'request-001' }));
    expect(deps.workspaceManager.destroy).toHaveBeenCalledWith('/ws/request-001');
    expect(deps.postMessage).toHaveBeenCalledWith(TEST_CONVERSATION, 'Filed 1 new issue: #10 New issue');
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'filing.issue_filed', issue_number: 10 }),
      'Issue filed',
    );
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'filing.duplicate_detected', existing_issue_number: 45 }),
      'Duplicate issue detected',
    );
    expect(run.stage).toBe('done');
    expect(deps.reactToRunMessage).toHaveBeenCalledWith(run, 'white_check_mark');
  });

  it('fails the run and does not file issues when workspace creation fails', async () => {
    const error = new Error('clone failed');
    const { handler, deps } = makeHandler({
      workspaceManager: {
        create: vi.fn().mockRejectedValue(error),
        destroy: vi.fn().mockResolvedValue(undefined),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeRequest());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.issueFiler.file).not.toHaveBeenCalled();
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, error);
  });

  it('destroys the workspace and fails the run when filing throws', async () => {
    const error = new Error('enrichment failed');
    const { handler, deps } = makeHandler({
      issueFiler: {
        file: vi.fn().mockRejectedValue(error),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeRequest());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.workspaceManager.destroy).toHaveBeenCalledWith('/ws/request-001');
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, error);
  });

  it('destroys the workspace and fails the run when filing returns failed status', async () => {
    const { handler, deps } = makeHandler({
      issueFiler: {
        file: vi.fn().mockResolvedValue({
          status: 'failed',
          summary: '',
          filed_issues: [],
          error: 'enrichment agent error',
        }),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeRequest());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.workspaceManager.destroy).toHaveBeenCalledWith('/ws/request-001');
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, expect.any(Error));
  });

  it('passes onAgentRequest to issueFiler.file() and updates run metadata when callback fires', async () => {
    let capturedOnAgentRequest: ((metadata: { model: string; requested_at: string; route: { task: string } }) => void) | undefined;
    const { handler, deps } = makeHandler({
      issueFiler: {
        file: vi.fn().mockImplementation(async (_req, _ws, _progress, telemetry: { onAgentRequest?: (metadata: { model: string; requested_at: string; route: { task: string } }) => void }) => {
          capturedOnAgentRequest = telemetry?.onAgentRequest;
          return { status: 'complete', summary: 'Filed 1 issue', filed_issues: [] };
        }),
      },
    });
    const run = makeRun();

    await handler.handle(run, makeRequest());

    expect(capturedOnAgentRequest).toBeDefined();
    capturedOnAgentRequest?.({ model: 'claude-sonnet-4-6', requested_at: '2026-01-03T00:00:00.000Z', route: { task: 'issue.triage' } });
    expect(run.current_model).toBe('claude-sonnet-4-6');
    expect(run.last_agent_request_at).toBe('2026-01-03T00:00:00.000Z');
    expect(deps.persist).toHaveBeenCalled();
  });

  it('continues to done when workspace cleanup, summary notification, or completion reaction fail', async () => {
    const { handler, deps } = makeHandler({
      workspaceManager: {
        create: vi.fn().mockResolvedValue({ workspace_path: '/ws/request-001', branch: 'file/request-001' }),
        destroy: vi.fn().mockRejectedValue(new Error('cleanup failed')),
      },
      postMessage: vi.fn().mockRejectedValue(new Error('channel failed')),
      reactToRunMessage: vi.fn().mockRejectedValue(new Error('reaction failed')),
    });
    const run = makeRun();

    const result = await handler.handle(run, makeRequest());

    expect(result).toEqual({ status: 'done' });
    expect(deps.failRun).not.toHaveBeenCalled();
    expect(run.stage).toBe('done');
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'workspace.destroy_failed', run_id: 'run-001' }),
      'Failed to destroy workspace after filing',
    );
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.notify_failed', run_id: 'run-001' }),
      'Failed to post filing summary',
    );
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.notify_failed', run_id: 'run-001' }),
      'Failed to post completion reaction',
    );
  });
});
