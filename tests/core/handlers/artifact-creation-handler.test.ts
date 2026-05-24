import { describe, expect, it, vi } from 'vitest';
import { ArtifactCreationHandler } from '../../../src/core/handlers/artifact-creation-handler.js';
import type { Request } from '../../../src/types/events.js';
import type { Run } from '../../../src/types/runs.js';
import { TEST_CHANNEL, TEST_CONVERSATION, TEST_ORIGIN, testChannelBinding } from '../../helpers/channel-refs.js';

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: 'request-001',
    channel: TEST_CHANNEL,
    conversation: TEST_CONVERSATION,
    origin: TEST_ORIGIN,
    content: 'add a setup wizard',
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

function makeHandler(overrides: Partial<ConstructorParameters<typeof ArtifactCreationHandler>[0]> = {}) {
  const deps = {
    workspaceManager: {
      create: vi.fn().mockResolvedValue({ workspace_path: '/ws/request-001', branch: 'spec/request-001' }),
      destroy: vi.fn().mockResolvedValue(undefined),
    },
    artifactAuthoringAgent: {
      create: vi.fn().mockResolvedValue({ artifact_path: '/ws/request-001/context-human/specs/feature-test.md' }),
    },
    artifactPublisher: {
      createArtifact: vi.fn().mockResolvedValue({ id: 'CANVAS001', url: 'https://artifact.example.test/CANVAS001' }),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    channelRepoMap: new Map([
      testChannelBinding('C123'),
    ]),
    postMessage: vi.fn().mockResolvedValue(undefined),
    transition: vi.fn((run: Run, stage: Run['stage']) => { run.stage = stage; }),
    failRun: vi.fn().mockResolvedValue(undefined),
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
    persist: vi.fn(),
    branchGuard: { check: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };

  return { handler: new ArtifactCreationHandler(deps), deps };
}

describe('ArtifactCreationHandler', () => {
  it('creates, publishes, and stores a feature_spec artifact for idea requests', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({ intent: 'idea' });
    const request = makeRequest();

    await handler.handle(run, request, 'idea');

    expect(deps.workspaceManager.create).toHaveBeenCalledWith('request-001', 'https://example.test/org/repo.git', '/tmp/workspaces');
    expect(deps.artifactAuthoringAgent.create).toHaveBeenCalledWith(request, '/ws/request-001', expect.any(Function), undefined, expect.objectContaining({ run_id: 'run-001', request_id: 'request-001' }));
    expect(deps.artifactPublisher.createArtifact).toHaveBeenCalledWith(
      TEST_CONVERSATION,
      expect.objectContaining({
        kind: 'feature_spec',
        local_path: '/ws/request-001/context-human/specs/feature-test.md',
        status: 'drafting',
      }),
    );
    expect(run.artifact).toEqual({
      kind: 'feature_spec',
      local_path: '/ws/request-001/context-human/specs/feature-test.md',
      published_ref: { provider: 'artifact_publisher', id: 'CANVAS001', url: 'https://artifact.example.test/CANVAS001' },
      status: 'waiting_on_feedback',
    });
    expect(deps.postMessage).toHaveBeenCalledWith(TEST_CONVERSATION, expect.stringContaining('https://artifact.example.test/CANVAS001'));
    expect(run.stage).toBe('reviewing_spec');
  });

  it('passes bug intent to generation and records existing issues on bug triage artifacts', async () => {
    const { handler, deps } = makeHandler({
      artifactAuthoringAgent: {
        create: vi.fn().mockResolvedValue({
          artifact_path: '/ws/request-001/context-human/specs/bug-login.md',
          existing_issue: 42,
        }),
      },
    });
    const run = makeRun({ intent: 'bug' });
    const request = makeRequest();

    await handler.handle(run, request, 'bug');

    expect(deps.artifactAuthoringAgent.create).toHaveBeenCalledWith(request, '/ws/request-001', expect.any(Function), 'bug', expect.objectContaining({ run_id: 'run-001', request_id: 'request-001' }));
    expect(run.issue).toBe(42);
    expect(run.artifact).toMatchObject({
      kind: 'bug_triage',
      local_path: '/ws/request-001/context-human/specs/bug-login.md',
      status: 'waiting_on_feedback',
    });
  });

  it('destroys the workspace and fails the run when generation fails', async () => {
    const error = new Error('generation failed');
    const { handler, deps } = makeHandler({
      artifactAuthoringAgent: {
        create: vi.fn().mockRejectedValue(error),
      },
    });
    const run = makeRun();
    const request = makeRequest();

    await handler.handle(run, request, 'idea');

    expect(deps.workspaceManager.destroy).toHaveBeenCalledWith('/ws/request-001');
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, error);
    expect(deps.artifactPublisher.createArtifact).not.toHaveBeenCalled();
  });

  it('destroys the workspace and fails the run when the agent changes branches after creation', async () => {
    const branchDriftError = new Error(
      'Agent changed branches from spec/request-001 to feat/something. Autocatalyst owns run branches; this run cannot continue safely.',
    );
    const { handler, deps } = makeHandler({
      branchGuard: {
        check: vi.fn().mockRejectedValue(branchDriftError),
      },
    });
    const run = makeRun({ intent: 'idea' });
    const request = makeRequest();

    await handler.handle(run, request, 'idea');

    expect(deps.workspaceManager.destroy).toHaveBeenCalledWith('/ws/request-001');
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, branchDriftError);
    expect(deps.artifactPublisher.createArtifact).not.toHaveBeenCalled();
  });

  it('proceeds normally when the branch guard confirms no drift', async () => {
    const { handler, deps } = makeHandler({
      branchGuard: {
        check: vi.fn().mockResolvedValue(undefined),
      },
    });
    const run = makeRun({ intent: 'idea' });

    await handler.handle(run, makeRequest(), 'idea');

    expect(deps.artifactPublisher.createArtifact).toHaveBeenCalled();
    expect(deps.failRun).not.toHaveBeenCalled();
  });

  it('posts a labeled link message when ArtifactPublication includes label and url', async () => {
    const { handler, deps } = makeHandler({
      artifactPublisher: {
        createArtifact: vi.fn().mockResolvedValue({
          id: 'CANVAS001',
          url: 'https://artifact.example.test/CANVAS001',
          label: 'View spec',
        }),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
    });
    const run = makeRun({ intent: 'idea' });
    await handler.handle(run, makeRequest(), 'idea');
    expect(deps.postMessage).toHaveBeenCalledWith(
      TEST_CONVERSATION,
      'Artifact ready for review: View spec — https://artifact.example.test/CANVAS001',
    );
  });

  it('falls back to url-only message when label is absent', async () => {
    const { handler, deps } = makeHandler({
      artifactPublisher: {
        createArtifact: vi.fn().mockResolvedValue({
          id: 'CANVAS001',
          url: 'https://artifact.example.test/CANVAS001',
        }),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
    });
    const run = makeRun({ intent: 'idea' });
    await handler.handle(run, makeRequest(), 'idea');
    expect(deps.postMessage).toHaveBeenCalledWith(
      TEST_CONVERSATION,
      'Artifact ready for review: https://artifact.example.test/CANVAS001',
    );
  });

  it('onAgentRequest callback updates run fields and persists', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({ intent: 'idea' });
    const request = makeRequest();

    await handler.handle(run, request, 'idea');

    const createCall = (deps.artifactAuthoringAgent.create as ReturnType<typeof vi.fn>).mock.calls[0];
    const telemetry = createCall[4] as { onAgentRequest?: (metadata: { model: string; requested_at: string; route: { task: string } }) => void };
    telemetry.onAgentRequest?.({ model: 'claude-opus-4-5', requested_at: '2026-01-01T00:00:00.000Z', route: { task: 'some.task' } });

    expect(run.current_model).toBe('claude-opus-4-5');
    expect(run.last_agent_request_at).toBe('2026-01-01T00:00:00.000Z');
    expect(deps.persist).toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.agent_request_recorded', run_id: 'run-001' }),
      expect.any(String),
    );
  });

  it('posts no publication link when url is absent', async () => {
    const { handler, deps } = makeHandler({
      artifactPublisher: {
        createArtifact: vi.fn().mockResolvedValue({ id: 'CANVAS001' }),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
    });
    const run = makeRun({ intent: 'idea' });
    await handler.handle(run, makeRequest(), 'idea');
    expect(deps.postMessage).not.toHaveBeenCalledWith(
      TEST_CONVERSATION,
      expect.stringContaining('Artifact ready for review'),
    );
  });
});
