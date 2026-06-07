import { describe, expect, it, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
    specReviewCoordinator: undefined as undefined | { runSpecReview: ReturnType<typeof vi.fn> },
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

  describe('spec review integration', () => {
    it('runs spec review after branch guard and before createArtifact for idea intent', async () => {
      const callOrder: string[] = [];
      const branchGuardCheck = vi.fn().mockImplementation(async () => { callOrder.push('branchGuard'); });
      const runSpecReview = vi.fn().mockImplementation(async () => {
        callOrder.push('specReview');
        return { status: 'complete', artifact_path: '/ws/request-001/context-human/specs/feature-test.md' };
      });
      const createArtifact = vi.fn().mockImplementation(async () => {
        callOrder.push('publish');
        return { id: 'CANVAS001', url: 'https://artifact.example.test/CANVAS001' };
      });
      const { handler, deps } = makeHandler({
        branchGuard: { check: branchGuardCheck },
        specReviewCoordinator: { runSpecReview },
        artifactPublisher: {
          createArtifact,
          updateStatus: vi.fn().mockResolvedValue(undefined),
        },
      });
      const run = makeRun({ intent: 'idea' });
      await handler.handle(run, makeRequest(), 'idea');

      expect(callOrder).toEqual(['branchGuard', 'specReview', 'branchGuard', 'publish']);
      expect(runSpecReview).toHaveBeenCalledWith(expect.objectContaining({
        artifact_kind: 'feature_spec',
        artifact_path: '/ws/request-001/context-human/specs/feature-test.md',
        working_directory: '/ws/request-001',
      }));
      expect(deps.failRun).not.toHaveBeenCalled();
    });

    it('does not call specReviewCoordinator for bug or chore intents', async () => {
      const runSpecReview = vi.fn();
      const { handler: bugHandler } = makeHandler({
        specReviewCoordinator: { runSpecReview },
        artifactAuthoringAgent: {
          create: vi.fn().mockResolvedValue({ artifact_path: '/ws/request-001/context-human/specs/bug.md' }),
        },
      });
      await bugHandler.handle(makeRun({ intent: 'bug' }), makeRequest(), 'bug');
      expect(runSpecReview).not.toHaveBeenCalled();

      const { handler: choreHandler } = makeHandler({
        specReviewCoordinator: { runSpecReview },
        artifactAuthoringAgent: {
          create: vi.fn().mockResolvedValue({ artifact_path: '/ws/request-001/context-human/specs/chore.md' }),
        },
      });
      await choreHandler.handle(makeRun({ intent: 'chore' }), makeRequest(), 'chore');
      expect(runSpecReview).not.toHaveBeenCalled();
    });

    it('does not publish when spec review returns needs_input', async () => {
      const runSpecReview = vi.fn().mockResolvedValue({
        status: 'needs_input',
        artifact_path: '/ws/request-001/context-human/specs/feature-test.md',
        question: 'Need more details',
      });
      const { handler, deps } = makeHandler({
        specReviewCoordinator: { runSpecReview },
      });
      const run = makeRun({ intent: 'idea' });
      await handler.handle(run, makeRequest(), 'idea');

      expect(deps.artifactPublisher.createArtifact).not.toHaveBeenCalled();
      expect(deps.failRun).toHaveBeenCalled();
      expect(deps.workspaceManager.destroy).toHaveBeenCalledWith('/ws/request-001');
    });

    it('does not publish when spec review returns failed', async () => {
      const runSpecReview = vi.fn().mockResolvedValue({
        status: 'failed',
        artifact_path: '/ws/request-001/context-human/specs/feature-test.md',
        error: 'review crashed',
      });
      const { handler, deps } = makeHandler({
        specReviewCoordinator: { runSpecReview },
      });
      const run = makeRun({ intent: 'idea' });
      await handler.handle(run, makeRequest(), 'idea');

      expect(deps.artifactPublisher.createArtifact).not.toHaveBeenCalled();
      expect(deps.failRun).toHaveBeenCalled();
    });

    it('skips spec review when specReviewCoordinator is undefined', async () => {
      const { handler, deps } = makeHandler({ specReviewCoordinator: undefined });
      const run = makeRun({ intent: 'idea' });
      await handler.handle(run, makeRequest(), 'idea');

      expect(deps.artifactPublisher.createArtifact).toHaveBeenCalled();
      expect(deps.failRun).not.toHaveBeenCalled();
    });
  });

  describe('authoring API convergence — integration (real file I/O)', () => {
    let tmpDir: string;

    afterEach(async () => {
      if (tmpDir) {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('full enabled speccing lifecycle writes Converged API section before Task list and transitions to reviewing_spec', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ach-integration-'));
      const specFile = path.join(tmpDir, 'feature-spec.md');
      const specContent = [
        '# Feature Spec',
        '',
        '## What',
        'Build a setup wizard.',
        '',
        '## Tech spec',
        'Use TypeScript.',
        '',
        '## Task list',
        '',
      ].join('\n');
      await fs.writeFile(specFile, specContent, 'utf-8');

      const convergedMarkdown = '## Converged API\n\n### Notes\n\nTest.';

      const createTechSpecDraft = vi.fn().mockResolvedValue({ artifact_path: specFile });
      const coordinatorRun = vi.fn().mockResolvedValue({
        artifact: { files: [], public_api: [], types: [], notes: 'Test.' },
        markdown: convergedMarkdown,
        converged: true,
      });
      const decomposeTasks = vi.fn().mockResolvedValue({ artifact_path: specFile });

      const { handler, deps } = makeHandler({
        workspaceManager: {
          create: vi.fn().mockResolvedValue({ workspace_path: tmpDir, branch: 'spec/request-001' }),
          destroy: vi.fn().mockResolvedValue(undefined),
        },
        artifactAuthoringAgent: {
          create: vi.fn(),
          createTechSpecDraft,
          decomposeTasks,
        },
        specAuthoringPolicy: { api_convergence: { enabled: true, max_rounds: 2, allow_same_model: false } },
        authoringApiConvergenceCoordinator: { run: coordinatorRun },
        // Use real fs — omit readFile/writeFile so the handler defaults to node:fs/promises
      });

      const run = makeRun({ intent: 'idea' });
      await handler.handle(run, makeRequest(), 'idea');

      // Verify steps were called
      expect(createTechSpecDraft).toHaveBeenCalledOnce();
      expect(coordinatorRun).toHaveBeenCalledWith(expect.objectContaining({
        artifact_path: specFile,
        working_directory: tmpDir,
      }));
      expect(decomposeTasks).toHaveBeenCalledOnce();
      expect(deps.failRun).not.toHaveBeenCalled();

      // Read the final spec file from disk
      const finalSpec = await fs.readFile(specFile, 'utf-8');

      // Assert section ordering
      expect(finalSpec.indexOf('## Tech spec')).toBeLessThan(finalSpec.indexOf('## Converged API'));
      expect(finalSpec.indexOf('## Converged API')).toBeLessThan(finalSpec.indexOf('## Task list'));

      // Assert the run transitioned to reviewing_spec
      expect(run.stage).toBe('reviewing_spec');
    });
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

  describe('authoring API convergence', () => {
    it('disabled policy calls create() once for idea and does not call coordinator', async () => {
      const create = vi.fn().mockResolvedValue({ artifact_path: '/ws/request-001/context-human/specs/feature-test.md' });
      const coordinatorRun = vi.fn();
      const { handler, deps } = makeHandler({
        artifactAuthoringAgent: { create },
        specAuthoringPolicy: { api_convergence: { enabled: false, max_rounds: 3, allow_same_model: false } },
        authoringApiConvergenceCoordinator: { run: coordinatorRun },
      });
      const run = makeRun({ intent: 'idea' });
      await handler.handle(run, makeRequest(), 'idea');

      expect(create).toHaveBeenCalledOnce();
      expect(coordinatorRun).not.toHaveBeenCalled();
      expect(deps.failRun).not.toHaveBeenCalled();
    });

    it('enabled policy for idea calls createTechSpecDraft, branchGuard, coordinator, decomposeTasks, then existing flow', async () => {
      const callOrder: string[] = [];

      const createTechSpecDraft = vi.fn().mockImplementation(async () => {
        callOrder.push('techDraft');
        return { artifact_path: '/ws/request-001/context-human/specs/feature-test.md' };
      });
      const branchGuardCheck = vi.fn().mockImplementation(async () => { callOrder.push('branchGuard'); });
      const coordinatorRun = vi.fn().mockImplementation(async () => {
        callOrder.push('apiConvergence');
        return { artifact: { files: [], public_api: [], types: [], notes: '' }, markdown: '## Converged API\n\n### Notes\n\n', converged: true };
      });
      const decomposeTasks = vi.fn().mockImplementation(async () => {
        callOrder.push('decomposeTasks');
        return { artifact_path: '/ws/request-001/context-human/specs/feature-test.md' };
      });
      const createArtifact = vi.fn().mockImplementation(async () => {
        callOrder.push('publish');
        return { id: 'CANVAS001', url: 'https://artifact.example.test/CANVAS001' };
      });
      const specContent = '# Spec\n\n## Task list\n\n- [ ] Task 1\n';
      const readFile = vi.fn().mockResolvedValue(specContent);
      const writeFile = vi.fn().mockResolvedValue(undefined);

      const { handler, deps } = makeHandler({
        artifactAuthoringAgent: {
          create: vi.fn(),
          createTechSpecDraft,
          decomposeTasks,
        },
        branchGuard: { check: branchGuardCheck },
        specAuthoringPolicy: { api_convergence: { enabled: true, max_rounds: 2, allow_same_model: false } },
        authoringApiConvergenceCoordinator: { run: coordinatorRun },
        readFile,
        writeFile,
        artifactPublisher: {
          createArtifact,
          updateStatus: vi.fn().mockResolvedValue(undefined),
        },
      });

      const run = makeRun({ intent: 'idea' });
      await handler.handle(run, makeRequest(), 'idea');

      // Tech spec draft, then branch guard #1, then API convergence, then decompose tasks,
      // then branch guard #2 (existing), then publish
      expect(callOrder).toEqual(['techDraft', 'branchGuard', 'apiConvergence', 'decomposeTasks', 'branchGuard', 'publish']);
      expect(deps.artifactAuthoringAgent.create).not.toHaveBeenCalled();
      expect(coordinatorRun).toHaveBeenCalledWith(expect.objectContaining({
        artifact_path: '/ws/request-001/context-human/specs/feature-test.md',
        working_directory: '/ws/request-001',
      }));
      expect(writeFile).toHaveBeenCalledWith('/ws/request-001/context-human/specs/feature-test.md', expect.stringContaining('## Converged API'), 'utf-8');
      expect(deps.failRun).not.toHaveBeenCalled();
      expect(run.stage).toBe('reviewing_spec');
    });

    it('enabled policy does not affect bug triage — uses create() instead', async () => {
      const create = vi.fn().mockResolvedValue({ artifact_path: '/ws/request-001/context-human/specs/bug-login.md' });
      const coordinatorRun = vi.fn();
      const createTechSpecDraft = vi.fn();
      const decomposeTasks = vi.fn();

      const { handler, deps } = makeHandler({
        artifactAuthoringAgent: { create, createTechSpecDraft, decomposeTasks },
        specAuthoringPolicy: { api_convergence: { enabled: true, max_rounds: 2, allow_same_model: false } },
        authoringApiConvergenceCoordinator: { run: coordinatorRun },
      });

      const run = makeRun({ intent: 'bug' });
      await handler.handle(run, makeRequest(), 'bug');

      expect(create).toHaveBeenCalledOnce();
      expect(createTechSpecDraft).not.toHaveBeenCalled();
      expect(coordinatorRun).not.toHaveBeenCalled();
      expect(decomposeTasks).not.toHaveBeenCalled();
      expect(deps.failRun).not.toHaveBeenCalled();
    });

    it('enabled policy fails clearly when coordinator is missing', async () => {
      const create = vi.fn();
      const createTechSpecDraft = vi.fn();
      const decomposeTasks = vi.fn();

      const { handler, deps } = makeHandler({
        artifactAuthoringAgent: { create, createTechSpecDraft, decomposeTasks },
        specAuthoringPolicy: { api_convergence: { enabled: true, max_rounds: 2, allow_same_model: false } },
        // authoringApiConvergenceCoordinator intentionally omitted
      });

      const run = makeRun({ intent: 'idea' });
      await handler.handle(run, makeRequest(), 'idea');

      expect(deps.failRun).toHaveBeenCalledWith(
        run,
        TEST_CONVERSATION,
        expect.objectContaining({ message: expect.stringContaining('authoringApiConvergenceCoordinator') }),
      );
      expect(create).not.toHaveBeenCalled();
      expect(createTechSpecDraft).not.toHaveBeenCalled();
      expect(deps.workspaceManager.destroy).toHaveBeenCalledWith('/ws/request-001');
    });

    it('enabled policy fails clearly when createTechSpecDraft is missing', async () => {
      const create = vi.fn();
      const { handler, deps } = makeHandler({
        artifactAuthoringAgent: { create },
        specAuthoringPolicy: { api_convergence: { enabled: true, max_rounds: 2, allow_same_model: false } },
        authoringApiConvergenceCoordinator: { run: vi.fn() },
      });

      const run = makeRun({ intent: 'idea' });
      await handler.handle(run, makeRequest(), 'idea');

      expect(deps.failRun).toHaveBeenCalledWith(
        run,
        TEST_CONVERSATION,
        expect.objectContaining({ message: expect.stringContaining('createTechSpecDraft') }),
      );
      expect(create).not.toHaveBeenCalled();
    });

    it('enabled path destroys workspace and fails run when tech spec draft throws', async () => {
      const draftError = new Error('tech spec draft failed');
      const { handler, deps } = makeHandler({
        artifactAuthoringAgent: {
          create: vi.fn(),
          createTechSpecDraft: vi.fn().mockRejectedValue(draftError),
          decomposeTasks: vi.fn(),
        },
        specAuthoringPolicy: { api_convergence: { enabled: true, max_rounds: 2, allow_same_model: false } },
        authoringApiConvergenceCoordinator: { run: vi.fn() },
      });

      const run = makeRun({ intent: 'idea' });
      await handler.handle(run, makeRequest(), 'idea');

      expect(deps.workspaceManager.destroy).toHaveBeenCalledWith('/ws/request-001');
      expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, draftError);
      expect(deps.artifactPublisher.createArtifact).not.toHaveBeenCalled();
    });

    it('enabled path destroys workspace and fails run when coordinator throws', async () => {
      const coordinatorError = new Error('coordinator failed');
      const { handler, deps } = makeHandler({
        artifactAuthoringAgent: {
          create: vi.fn(),
          createTechSpecDraft: vi.fn().mockResolvedValue({ artifact_path: '/ws/request-001/context-human/specs/feature-test.md' }),
          decomposeTasks: vi.fn(),
        },
        specAuthoringPolicy: { api_convergence: { enabled: true, max_rounds: 2, allow_same_model: false } },
        authoringApiConvergenceCoordinator: { run: vi.fn().mockRejectedValue(coordinatorError) },
        readFile: vi.fn().mockResolvedValue('# Spec\n\n## Task list\n\n'),
        writeFile: vi.fn().mockResolvedValue(undefined),
      });

      const run = makeRun({ intent: 'idea' });
      await handler.handle(run, makeRequest(), 'idea');

      expect(deps.workspaceManager.destroy).toHaveBeenCalledWith('/ws/request-001');
      expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, coordinatorError);
      expect(deps.artifactPublisher.createArtifact).not.toHaveBeenCalled();
    });
  });
});
