import { describe, expect, it, vi } from 'vitest';
import { ArtifactApprovalHandler } from '../../../src/core/handlers/artifact-approval-handler.js';
import type { ThreadMessage } from '../../../src/types/events.js';
import type { Run } from '../../../src/types/runs.js';
import { TEST_CHANNEL, TEST_CONVERSATION, TEST_ORIGIN, testChannelBinding } from '../../helpers/channel-refs.js';

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
    stage: 'reviewing_spec',
    workspace_path: '/ws/request-001',
    branch: 'spec/request-001',
    spec_path: '/ws/request-001/context-human/specs/feature-test.md',
    publisher_ref: 'CANVAS001',
    artifact: {
      kind: 'feature_spec',
      local_path: '/ws/request-001/context-human/specs/feature-test.md',
      published_ref: { provider: 'artifact_publisher', id: 'CANVAS001' },
      status: 'waiting_on_feedback',
    },
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

function makeHandler(overrides: Partial<ConstructorParameters<typeof ArtifactApprovalHandler>[0]> = {}) {
  const deps = {
    artifactPublisher: {
      updateStatus: vi.fn().mockResolvedValue(undefined),
      setIssueLink: vi.fn().mockResolvedValue(undefined),
    },
    artifactContentSource: {
      getContent: vi.fn().mockResolvedValue('# Artifact\n\nBody.'),
    },
    specCommitter: {
      commit: vi.fn().mockResolvedValue(undefined),
    },
    issueManager: {
      writeIssue: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue({ number: 99 }),
    },
    channelRepoMap: new Map([
      testChannelBinding(),
    ]),
    postMessage: vi.fn().mockResolvedValue(undefined),
    transition: vi.fn((run: Run, stage: Run['stage']) => { run.stage = stage; }),
    failRun: vi.fn().mockResolvedValue(undefined),
    persist: vi.fn(),
    logger: {
      info: vi.fn(),
      error: vi.fn(),
    },
    branchGuard: { check: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };

  return { handler: new ArtifactApprovalHandler(deps), deps };
}

describe('ArtifactApprovalHandler', () => {
  it('approves feature specs using typed artifact refs when legacy spec fields are absent', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({
      spec_path: undefined,
      publisher_ref: undefined,
      artifact: {
        kind: 'feature_spec',
        local_path: '/ws/request-001/context-human/specs/typed-feature.md',
        published_ref: { provider: 'artifact_publisher', id: 'CANVAS-TYPED' },
        status: 'waiting_on_feedback',
      },
    });

    const result = await handler.handle(run, makeFeedback());

    expect(result).toMatchObject({ status: 'approved', implementation_required: true });
    expect(deps.specCommitter.commit).toHaveBeenCalledWith('/ws/request-001', 'CANVAS-TYPED', '/ws/request-001/context-human/specs/typed-feature.md');
    expect(deps.artifactPublisher.updateStatus).toHaveBeenCalledWith('CANVAS-TYPED', 'approved');
    expect(deps.failRun).not.toHaveBeenCalled();
    expect(run.artifact).toMatchObject({ status: 'approved' });
  });

  it('commits feature specs on approval without syncing issues', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toMatchObject({ status: 'approved', implementation_required: true });
    expect(deps.specCommitter.commit).toHaveBeenCalledWith('/ws/request-001', 'CANVAS001', '/ws/request-001/context-human/specs/feature-test.md');
    expect(deps.issueManager.create).not.toHaveBeenCalled();
    expect(deps.artifactPublisher.setIssueLink).not.toHaveBeenCalled();
    expect(run.attempt).toBe(1);
    expect(run.stage).toBe('planning');
    expect(run.artifact?.status).toBe('approved');
  });

  it('uses injected lifecycle policy overrides for approval behavior', async () => {
    const { handler, deps } = makeHandler({
      artifactPolicies: {
        feature_spec: {
          commit_on_approval: false,
          sync_issue_on_approval: true,
          implementation_required: true,
        },
        bug_triage: {
          commit_on_approval: false,
          sync_issue_on_approval: true,
          implementation_required: true,
        },
        chore_plan: {
          commit_on_approval: false,
          sync_issue_on_approval: true,
          implementation_required: true,
        },
      },
      artifactContentSource: {
        getContent: vi.fn().mockResolvedValue('# Feature: typed approval\n\nBody.'),
      },
    } as Partial<ConstructorParameters<typeof ArtifactApprovalHandler>[0]>);
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toMatchObject({ status: 'approved', implementation_required: true });
    expect(deps.specCommitter.commit).not.toHaveBeenCalled();
    expect(deps.issueManager.create).toHaveBeenCalledWith('/ws/request-001', 'Feature: typed approval', '# Feature: typed approval\n\nBody.');
    expect(deps.artifactPublisher.setIssueLink).toHaveBeenCalledWith('CANVAS001', 'https://example.test/org/repo.git/issues/99');
  });

  it('syncs bug triage to an issue without committing the artifact', async () => {
    const { handler, deps } = makeHandler({
      artifactPublisher: {
        updateStatus: vi.fn().mockResolvedValue(undefined),
        setIssueLink: vi.fn().mockResolvedValue(undefined),
      },
      artifactContentSource: {
        getContent: vi.fn().mockResolvedValue('---\nstatus: triaged\n---\n# Bug: login broken\n\nDetails here.'),
      },
    });
    const run = makeRun({
      intent: 'bug',
      artifact: {
        kind: 'bug_triage',
        local_path: '/ws/request-001/context-human/specs/bug-login.md',
        published_ref: { provider: 'artifact_publisher', id: 'CANVAS001' },
        status: 'waiting_on_feedback',
      },
    });

    const result = await handler.handle(run, makeFeedback());

    expect(result).toMatchObject({ status: 'approved', implementation_required: true });
    expect(deps.specCommitter.commit).not.toHaveBeenCalled();
    expect(deps.issueManager.create).toHaveBeenCalledWith('/ws/request-001', 'Bug: login broken', '# Bug: login broken\n\nDetails here.');
    expect(deps.artifactPublisher.setIssueLink).toHaveBeenCalledWith('CANVAS001', 'https://example.test/org/repo.git/issues/99');
    expect(deps.artifactPublisher.updateStatus).toHaveBeenCalledWith('CANVAS001', 'approved');
    expect(run.issue).toBe(99);
    expect(run.artifact).toMatchObject({
      status: 'approved',
      linked_issue: { provider: 'issue_tracker', number: 99 },
    });
  });

  it('updates an existing issue for chore artifacts', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({
      intent: 'chore',
      issue: 55,
      artifact: {
        kind: 'chore_plan',
        local_path: '/ws/request-001/context-human/specs/chore-node.md',
        published_ref: { provider: 'artifact_publisher', id: 'CANVAS001' },
        status: 'waiting_on_feedback',
      },
    });

    await handler.handle(run, makeFeedback());

    expect(deps.issueManager.writeIssue).toHaveBeenCalledWith('/ws/request-001', 55, '# Artifact\n\nBody.');
    expect(deps.issueManager.create).not.toHaveBeenCalled();
    expect(run.artifact).toMatchObject({
      status: 'approved',
      linked_issue: { provider: 'issue_tracker', number: 55 },
    });
  });

  it('fails the run and stops approval when reviewed content cannot be fetched', async () => {
    const error = new Error('content fetch failed');
    const { handler, deps } = makeHandler({
      artifactPublisher: {
        updateStatus: vi.fn().mockResolvedValue(undefined),
        setIssueLink: vi.fn().mockResolvedValue(undefined),
      },
      artifactContentSource: {
        getContent: vi.fn().mockRejectedValue(error),
      },
    });
    const run = makeRun({
      intent: 'bug',
      artifact: {
        kind: 'bug_triage',
        local_path: '/ws/request-001/context-human/specs/bug-login.md',
        published_ref: { provider: 'artifact_publisher', id: 'CANVAS001' },
        status: 'waiting_on_feedback',
      },
    });

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, error);
    expect(deps.issueManager.create).not.toHaveBeenCalled();
    expect(deps.specCommitter.commit).not.toHaveBeenCalled();
  });

  it('does not transition to implementation or log implementation start when approval side effects fail', async () => {
    const error = new Error('commit failed');
    const { handler, deps } = makeHandler({
      specCommitter: {
        commit: vi.fn().mockRejectedValue(error),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, error);
    expect(deps.transition).not.toHaveBeenCalledWith(run, 'implementing');
    expect(deps.logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'implementation.started' }),
      expect.any(String),
    );
  });

  it('does not log implementation start when lifecycle policy does not require implementation', async () => {
    const { handler, deps } = makeHandler({
      artifactPolicies: {
        feature_spec: {
          commit_on_approval: false,
          sync_issue_on_approval: false,
          implementation_required: false,
        },
        bug_triage: {
          commit_on_approval: false,
          sync_issue_on_approval: true,
          implementation_required: true,
        },
        chore_plan: {
          commit_on_approval: false,
          sync_issue_on_approval: true,
          implementation_required: true,
        },
      },
    } as Partial<ConstructorParameters<typeof ArtifactApprovalHandler>[0]>);
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'approved', implementation_required: false });
    expect(deps.transition).toHaveBeenCalledWith(run, 'done');
    expect(deps.logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'implementation.started' }),
      expect.any(String),
    );
  });

  it('does not delete the triage artifact from disk after syncing it to an issue', async () => {
    const { handler } = makeHandler({
      artifactContentSource: {
        getContent: vi.fn().mockResolvedValue('---\nstatus: triaged\n---\n# Bug: login broken\n\nDetails here.'),
      },
    });
    const run = makeRun({
      intent: 'bug',
      artifact: {
        kind: 'bug_triage',
        local_path: '/ws/request-001/.autocatalyst/triage/triage-bug-login.md',
        published_ref: { provider: 'artifact_publisher', id: 'CANVAS001' },
        status: 'waiting_on_feedback',
      },
    });

    // Should succeed without error — no deleteFile dep means no deletion attempt
    const result = await handler.handle(run, makeFeedback());

    expect(result).toMatchObject({ status: 'approved', implementation_required: true });
    expect(run.artifact?.local_path).toBe('/ws/request-001/.autocatalyst/triage/triage-bug-login.md');
  });

  it('fails the run before commit when the workspace branch does not match run.branch', async () => {
    const branchDriftError = new Error(
      'Agent changed branches from spec/request-001 to feat/something. Autocatalyst owns run branches; this run cannot continue safely.',
    );
    const { handler, deps } = makeHandler({
      branchGuard: {
        check: vi.fn().mockRejectedValue(branchDriftError),
      },
    });
    const run = makeRun();  // uses feature_spec which has commit_on_approval

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, expect.anything(), branchDriftError);
    expect(deps.specCommitter?.commit).not.toHaveBeenCalled();
  });

  it('fails the run before issue sync when the workspace branch has drifted', async () => {
    const branchDriftError = new Error(
      'Agent changed branches from spec/request-001 to feat/something. Autocatalyst owns run branches; this run cannot continue safely.',
    );
    const { handler, deps } = makeHandler({
      branchGuard: {
        check: vi.fn().mockRejectedValue(branchDriftError),
      },
      artifactContentSource: {
        getContent: vi.fn().mockResolvedValue('# Bug: login broken\n\nDetails here.'),
      },
    });
    const run = makeRun({
      intent: 'bug',
      artifact: {
        kind: 'bug_triage',
        local_path: '/ws/request-001/context-human/specs/bug-login.md',
        published_ref: { provider: 'artifact_publisher', id: 'CANVAS001' },
        status: 'waiting_on_feedback',
      },
    });

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, expect.anything(), branchDriftError);
    expect(deps.issueManager?.create).not.toHaveBeenCalled();
    expect(deps.issueManager?.writeIssue).not.toHaveBeenCalled();
  });
});
