import { describe, expect, it, vi } from 'vitest';
import { ArtifactFeedbackHandler } from '../../../src/core/handlers/artifact-feedback-handler.js';
import type { ArtifactComment as NotionComment, ArtifactCommentResponse as NotionCommentResponse } from '../../../src/types/ai.js';
import type { ThreadMessage } from '../../../src/types/events.js';
import type { Run } from '../../../src/types/runs.js';
import { TEST_CHANNEL, TEST_CONVERSATION, TEST_ORIGIN } from '../../helpers/channel-refs.js';

function makeFeedback(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    request_id: 'request-001',
    channel: TEST_CHANNEL,
    conversation: TEST_CONVERSATION,
    origin: TEST_ORIGIN,
    content: 'wizard should not require all settings',
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

function makeHandler(overrides: Partial<ConstructorParameters<typeof ArtifactFeedbackHandler>[0]> = {}) {
  const deps = {
    artifactAuthoringAgent: {
      revise: vi.fn().mockResolvedValue({ comment_responses: [] }),
    },
    artifactPublisher: {
      updateArtifact: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    artifactContentSource: {
      getContent: vi.fn().mockResolvedValue(''),
    },
    feedbackSource: undefined,
    branchGuard: { check: vi.fn().mockResolvedValue(undefined) },
    specReviewCoordinator: undefined as undefined | { runSpecReview: ReturnType<typeof vi.fn> },
    postMessage: vi.fn().mockResolvedValue(undefined),
    transition: vi.fn((run: Run, stage: Run['stage']) => { run.stage = stage; }),
    failRun: vi.fn().mockResolvedValue(undefined),
    persist: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    readFile: vi.fn().mockResolvedValue('# Feature Spec\n\nSome content.\n'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  return { handler: new ArtifactFeedbackHandler(deps), deps };
}

describe('ArtifactFeedbackHandler', () => {
  it('revises using typed artifact refs when legacy spec fields are absent', async () => {
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
    const feedback = makeFeedback();

    const result = await handler.handle(run, feedback);

    expect(result).toEqual({ status: 'revised' });
    expect(deps.artifactPublisher.updateStatus).toHaveBeenCalledWith('CANVAS-TYPED', 'drafting');
    expect(deps.artifactAuthoringAgent.revise).toHaveBeenCalledWith(
      feedback,
      [],
      '/ws/request-001/context-human/specs/typed-feature.md',
      '/ws/request-001',
      undefined,
      expect.any(Function),
      expect.objectContaining({ run_id: 'run-001', request_id: 'request-001' }),
    );
    expect(deps.artifactPublisher.updateArtifact).toHaveBeenCalledWith(
      'CANVAS-TYPED',
      expect.objectContaining({
        kind: 'feature_spec',
        local_path: '/ws/request-001/context-human/specs/typed-feature.md',
      }),
      undefined,
    );
    expect(deps.failRun).not.toHaveBeenCalled();
  });

  it('revises the artifact with channel feedback, publisher comments, and publisher markdown', async () => {
    const comments: NotionComment[] = [
      { id: 'disc-1', body: 'Phoebe: make it optional' },
      { id: 'disc-2', body: 'Enzo: add migration notes' },
    ];
    const responses: NotionCommentResponse[] = [
      { comment_id: 'disc-1', response: 'Made optional.' },
      { comment_id: 'disc-2', response: 'Added notes.' },
    ];
    const callOrder: string[] = [];
    const { handler, deps } = makeHandler({
      feedbackSource: {
        fetch: vi.fn().mockImplementation(async () => { callOrder.push('fetch'); return comments; }),
        reply: vi.fn().mockImplementation(async () => { callOrder.push('reply'); }),
      },
      artifactPublisher: {
        updateArtifact: vi.fn().mockImplementation(async () => { callOrder.push('updateArtifact'); }),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
      artifactContentSource: {
        getContent: vi.fn().mockImplementation(async () => { callOrder.push('getContent'); return '# Current\n\n<span discussion-urls="discussion://disc-1">text</span>'; }),
      },
      artifactAuthoringAgent: {
        revise: vi.fn().mockImplementation(async () => { callOrder.push('revise'); return { comment_responses: responses, page_content: '# Updated' }; }),
      },
      postMessage: vi.fn().mockImplementation(async () => { callOrder.push('postMessage'); }),
    });
    const run = makeRun();
    const feedback = makeFeedback();

    const result = await handler.handle(run, feedback);

    expect(result).toEqual({ status: 'revised' });
    expect(run.attempt).toBe(1);
    expect(run.stage).toBe('reviewing_spec');
    expect(deps.artifactPublisher.updateStatus).toHaveBeenCalledWith('CANVAS001', 'drafting');
    expect(callOrder).toEqual(['fetch', 'getContent', 'revise', 'updateArtifact', 'reply', 'reply', 'postMessage']);
    expect(deps.artifactAuthoringAgent.revise).toHaveBeenCalledWith(
      feedback,
      comments,
      '/ws/request-001/context-human/specs/feature-test.md',
      '/ws/request-001',
      '# Current\n\n<span discussion-urls="discussion://disc-1">text</span>',
      expect.any(Function),
      expect.objectContaining({ run_id: 'run-001', request_id: 'request-001' }),
    );
    expect(deps.artifactPublisher.updateArtifact).toHaveBeenCalledWith(
      'CANVAS001',
      expect.objectContaining({
        kind: 'feature_spec',
        local_path: '/ws/request-001/context-human/specs/feature-test.md',
      }),
      '# Updated',
    );
    expect(deps.feedbackSource?.reply).toHaveBeenCalledWith('CANVAS001', 'disc-1', 'Made optional.');
    expect(deps.feedbackSource?.reply).toHaveBeenCalledWith('CANVAS001', 'disc-2', 'Added notes.');
    expect(deps.postMessage).toHaveBeenCalledWith(TEST_CONVERSATION, expect.stringContaining('2 comments'));
  });

  it('continues revision when publisher markdown cannot be fetched', async () => {
    const { handler, deps } = makeHandler({
      artifactPublisher: {
        updateArtifact: vi.fn().mockResolvedValue(undefined),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
      artifactContentSource: {
        getContent: vi.fn().mockRejectedValue(new Error('markdown unavailable')),
      },
    });
    const run = makeRun();
    const feedback = makeFeedback();

    const result = await handler.handle(run, feedback);

    expect(result).toEqual({ status: 'revised' });
    expect(deps.artifactAuthoringAgent.revise).toHaveBeenCalledWith(
      feedback,
      [],
      '/ws/request-001/context-human/specs/feature-test.md',
      '/ws/request-001',
      undefined,
      expect.any(Function),
      expect.objectContaining({ run_id: 'run-001', request_id: 'request-001' }),
    );
    expect(deps.failRun).not.toHaveBeenCalled();
    expect(run.stage).toBe('reviewing_spec');
  });

  it('fails the run when publisher comments cannot be fetched', async () => {
    const error = new Error('comments unavailable');
    const { handler, deps } = makeHandler({
      feedbackSource: {
        fetch: vi.fn().mockRejectedValue(error),
        reply: vi.fn().mockResolvedValue(undefined),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, error);
    expect(deps.artifactAuthoringAgent.revise).not.toHaveBeenCalled();
  });

  it('fails the run when publishing the revised artifact fails', async () => {
    const error = new Error('publisher update failed');
    const { handler, deps } = makeHandler({
      artifactPublisher: {
        updateArtifact: vi.fn().mockRejectedValue(error),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, error);
    expect(run.stage).toBe('speccing');
  });

  it('fails the run when the agent changes branches during revision', async () => {
    const branchDriftError = new Error(
      'Agent changed branches from spec/request-001 to feat/something. Autocatalyst owns run branches; this run cannot continue safely.',
    );
    const { handler, deps } = makeHandler({
      branchGuard: {
        check: vi.fn().mockRejectedValue(branchDriftError),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, expect.anything(), branchDriftError);
    expect(deps.artifactPublisher.updateArtifact).not.toHaveBeenCalled();
  });

  it('onAgentRequest callback updates run fields and persists', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun();
    const feedback = makeFeedback();

    await handler.handle(run, feedback);

    const reviseCall = (deps.artifactAuthoringAgent.revise as ReturnType<typeof vi.fn>).mock.calls[0];
    const telemetry = reviseCall[6] as { onAgentRequest?: (metadata: { model: string; requested_at: string; route: { task: string } }) => void };
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
    it('runs spec review after branch guard and before updateArtifact', async () => {
      const callOrder: string[] = [];
      const branchGuardCheck = vi.fn().mockImplementation(async () => { callOrder.push('branchGuard'); });
      const runSpecReview = vi.fn().mockImplementation(async () => {
        callOrder.push('specReview');
        return { status: 'complete', artifact_path: '/ws/request-001/context-human/specs/feature-test.md' };
      });
      const updateArtifact = vi.fn().mockImplementation(async () => { callOrder.push('updateArtifact'); });
      const { handler } = makeHandler({
        branchGuard: { check: branchGuardCheck },
        specReviewCoordinator: { runSpecReview },
        artifactAuthoringAgent: {
          revise: vi.fn().mockImplementation(async () => { callOrder.push('revise'); return { comment_responses: [], page_content: '# Revised' }; }),
        },
        artifactPublisher: {
          updateArtifact,
          updateStatus: vi.fn().mockResolvedValue(undefined),
        },
      });
      const run = makeRun();
      const result = await handler.handle(run, makeFeedback());
      expect(result).toEqual({ status: 'revised' });
      expect(callOrder).toEqual(['revise', 'branchGuard', 'specReview', 'branchGuard', 'updateArtifact']);
      expect(runSpecReview).toHaveBeenCalledWith(expect.objectContaining({
        artifact_kind: 'feature_spec',
        artifact_path: '/ws/request-001/context-human/specs/feature-test.md',
        working_directory: '/ws/request-001',
      }));
    });

    it('uses page_content from review result in updateArtifact when provided', async () => {
      const runSpecReview = vi.fn().mockResolvedValue({
        status: 'complete',
        artifact_path: '/ws/request-001/context-human/specs/feature-test.md',
        page_content: '# Reviewed Content',
      });
      const updateArtifact = vi.fn().mockResolvedValue(undefined);
      const { handler } = makeHandler({
        specReviewCoordinator: { runSpecReview },
        artifactAuthoringAgent: {
          revise: vi.fn().mockResolvedValue({ comment_responses: [], page_content: '# Original Revised' }),
        },
        artifactPublisher: {
          updateArtifact,
          updateStatus: vi.fn().mockResolvedValue(undefined),
        },
      });
      const run = makeRun();
      await handler.handle(run, makeFeedback());

      expect(updateArtifact).toHaveBeenCalledWith(
        'CANVAS001',
        expect.any(Object),
        '# Reviewed Content',
      );
    });

    it('does not call updateArtifact when review returns needs_input', async () => {
      const runSpecReview = vi.fn().mockResolvedValue({
        status: 'needs_input',
        artifact_path: '/ws/request-001/context-human/specs/feature-test.md',
        question: 'clarify scope',
      });
      const { handler, deps } = makeHandler({
        specReviewCoordinator: { runSpecReview },
      });
      const run = makeRun();
      const result = await handler.handle(run, makeFeedback());

      expect(result).toEqual({ status: 'failed' });
      expect(deps.artifactPublisher.updateArtifact).not.toHaveBeenCalled();
      expect(deps.failRun).toHaveBeenCalled();
    });

    it('uses reviewed page_content over revise page_content when review finds issues and author responds', async () => {
      // Scenario: revise() returns page_content (from anchor codec), then spec review finds issues,
      // respondToSpecReview edits the artifact and returns updated page_content. updateArtifact must
      // receive the reviewed page_content, not the stale pre-review page_content from revise().
      const runSpecReview = vi.fn().mockResolvedValue({
        status: 'complete',
        artifact_path: '/ws/request-001/context-human/specs/feature-test.md',
        page_content: '# Reviewed + Anchors Preserved',
      });
      const updateArtifact = vi.fn().mockResolvedValue(undefined);
      const { handler } = makeHandler({
        specReviewCoordinator: { runSpecReview },
        artifactAuthoringAgent: {
          revise: vi.fn().mockResolvedValue({
            comment_responses: [],
            page_content: '# Stale Pre-Review With Anchors',
          }),
        },
        artifactPublisher: {
          updateArtifact,
          updateStatus: vi.fn().mockResolvedValue(undefined),
        },
      });
      const run = makeRun();
      await handler.handle(run, makeFeedback());

      expect(updateArtifact).toHaveBeenCalledWith(
        'CANVAS001',
        expect.any(Object),
        '# Reviewed + Anchors Preserved',
      );
    });

    it('does not call updateArtifact when review returns failed', async () => {
      const runSpecReview = vi.fn().mockResolvedValue({
        status: 'failed',
        artifact_path: '/ws/request-001/context-human/specs/feature-test.md',
        error: 'review error',
      });
      const { handler, deps } = makeHandler({
        specReviewCoordinator: { runSpecReview },
      });
      const run = makeRun();
      const result = await handler.handle(run, makeFeedback());

      expect(result).toEqual({ status: 'failed' });
      expect(deps.artifactPublisher.updateArtifact).not.toHaveBeenCalled();
      expect(deps.failRun).toHaveBeenCalled();
    });
  });

  describe('stale Converged API cleanup', () => {
    it('removes ## Converged API section from local file before revise() for feature_spec', async () => {
      const specWithApi = '# Feature Spec\n\nSome content.\n\n## Converged API\n\nOld API here.\n\n## Other Section\n\nMore.\n';
      const { handler, deps } = makeHandler({
        readFile: vi.fn().mockResolvedValue(specWithApi),
        writeFile: vi.fn().mockResolvedValue(undefined),
      });
      const run = makeRun();
      const feedback = makeFeedback();

      const result = await handler.handle(run, feedback);

      expect(result).toEqual({ status: 'revised' });
      expect(deps.writeFile).toHaveBeenCalledWith(
        '/ws/request-001/context-human/specs/feature-test.md',
        expect.not.stringContaining('## Converged API'),
        'utf-8',
      );
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'artifact.api_convergence.stale_section_removed', run_id: 'run-001' }),
        'Removed stale generated API section before feedback revision',
      );
    });

    it('passes staleConvergedApiRemoved: true in telemetry when section was removed', async () => {
      const specWithApi = '# Feature Spec\n\n## Converged API\n\nOld API.\n';
      const { handler, deps } = makeHandler({
        readFile: vi.fn().mockResolvedValue(specWithApi),
        writeFile: vi.fn().mockResolvedValue(undefined),
      });
      const run = makeRun();
      const feedback = makeFeedback();

      await handler.handle(run, feedback);

      expect(deps.artifactAuthoringAgent.revise).toHaveBeenCalledWith(
        feedback,
        [],
        '/ws/request-001/context-human/specs/feature-test.md',
        '/ws/request-001',
        undefined,
        expect.any(Function),
        expect.objectContaining({ run_id: 'run-001', staleConvergedApiRemoved: true }),
      );
    });

    it('does not warn and calls revise() when no ## Converged API section', async () => {
      const specWithoutApi = '# Feature Spec\n\nSome content.\n';
      const { handler, deps } = makeHandler({
        readFile: vi.fn().mockResolvedValue(specWithoutApi),
        writeFile: vi.fn().mockResolvedValue(undefined),
      });
      const run = makeRun();
      const feedback = makeFeedback();

      await handler.handle(run, feedback);

      expect(deps.writeFile).not.toHaveBeenCalled();
      expect(deps.logger.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'artifact.api_convergence.stale_section_removed' }),
        expect.any(String),
      );
      expect(deps.artifactAuthoringAgent.revise).toHaveBeenCalledWith(
        feedback,
        [],
        '/ws/request-001/context-human/specs/feature-test.md',
        '/ws/request-001',
        undefined,
        expect.any(Function),
        expect.objectContaining({ run_id: 'run-001', staleConvergedApiRemoved: false }),
      );
    });

    it('cleans the published markdown independently when the local file is already clean', async () => {
      // Regression: the published/anchored markdown can carry a stale ## Converged API
      // section even when the local spec file does not. It must still be stripped before
      // revise() drafts from it, and staleConvergedApiRemoved must reflect either source.
      const cleanLocal = '# Feature Spec\n\nSome content.\n';
      const pageWithApi = '# Feature Spec\n\nSome content.\n\n## Converged API\n\nStale published API.\n';
      const { handler, deps } = makeHandler({
        readFile: vi.fn().mockResolvedValue(cleanLocal),
        writeFile: vi.fn().mockResolvedValue(undefined),
        artifactContentSource: { getContent: vi.fn().mockResolvedValue(pageWithApi) },
      });
      const run = makeRun();
      const feedback = makeFeedback();

      await handler.handle(run, feedback);

      // Local file was already clean → not rewritten.
      expect(deps.writeFile).not.toHaveBeenCalled();

      const reviseCall = (deps.artifactAuthoringAgent.revise as ReturnType<typeof vi.fn>).mock.calls[0];
      // Published markdown handed to revise() must have the stale section stripped.
      expect(typeof reviseCall[4]).toBe('string');
      expect(reviseCall[4]).not.toContain('## Converged API');
      // Flag set because the published source changed, even though the local file did not.
      expect(reviseCall[6]).toEqual(expect.objectContaining({ staleConvergedApiRemoved: true }));
      // Warned specifically about the published-markdown cleanup.
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'artifact.api_convergence.stale_section_removed', source: 'published_markdown' }),
        expect.any(String),
      );
    });

    it('does not run cleanup for non-feature_spec artifact kinds', async () => {
      const { handler, deps } = makeHandler({
        readFile: vi.fn().mockResolvedValue('# Bug spec\n'),
        writeFile: vi.fn().mockResolvedValue(undefined),
      });
      const run = makeRun({
        artifact: {
          kind: 'bug_triage',
          local_path: '/ws/request-001/context-human/specs/bug.md',
          published_ref: { provider: 'artifact_publisher', id: 'CANVAS001' },
          status: 'waiting_on_feedback',
        },
      });

      await handler.handle(run, makeFeedback());

      expect(deps.readFile).not.toHaveBeenCalled();
      expect(deps.writeFile).not.toHaveBeenCalled();
      expect(deps.artifactAuthoringAgent.revise).toHaveBeenCalledWith(
        expect.anything(),
        [],
        '/ws/request-001/context-human/specs/bug.md',
        '/ws/request-001',
        undefined,
        expect.any(Function),
        expect.objectContaining({ run_id: 'run-001' }),
      );
    });

    it('logs a warning and continues when readFile throws during cleanup', async () => {
      const { handler, deps } = makeHandler({
        readFile: vi.fn().mockRejectedValue(new Error('file not found')),
        writeFile: vi.fn().mockResolvedValue(undefined),
      });
      const run = makeRun();

      const result = await handler.handle(run, makeFeedback());

      expect(result).toEqual({ status: 'revised' });
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'artifact.api_convergence.stale_section_cleanup_failed', run_id: 'run-001' }),
        'Failed to check/remove stale converged API section',
      );
      expect(deps.artifactAuthoringAgent.revise).toHaveBeenCalledWith(
        expect.anything(),
        [],
        '/ws/request-001/context-human/specs/feature-test.md',
        '/ws/request-001',
        undefined,
        expect.any(Function),
        expect.objectContaining({ run_id: 'run-001' }),
      );
    });

    it('also cleans pageMarkdown when ## Converged API section is removed from file', async () => {
      const specWithApi = '# Feature Spec\n\n## Converged API\n\nOld API.\n';
      const pageWithApi = '# Feature Spec\n\n## Converged API\n\nSame API.\n';
      const { handler, deps } = makeHandler({
        readFile: vi.fn().mockResolvedValue(specWithApi),
        writeFile: vi.fn().mockResolvedValue(undefined),
        artifactContentSource: {
          getContent: vi.fn().mockResolvedValue(pageWithApi),
        },
      });
      const run = makeRun();
      const feedback = makeFeedback();

      await handler.handle(run, feedback);

      const reviseCall = (deps.artifactAuthoringAgent.revise as ReturnType<typeof vi.fn>).mock.calls[0];
      const passedPageMarkdown = reviseCall[4] as string;
      expect(passedPageMarkdown).not.toContain('## Converged API');
    });
  });

  it('does not fail the run when replying to a publisher comment or notifying the channel fails', async () => {
    const responses: NotionCommentResponse[] = [
      { comment_id: 'disc-1', response: 'Updated.' },
    ];
    const { handler, deps } = makeHandler({
      feedbackSource: {
        fetch: vi.fn().mockResolvedValue([{ id: 'disc-1', body: 'feedback' }]),
        reply: vi.fn().mockRejectedValue(new Error('reply failed')),
      },
      artifactAuthoringAgent: {
        revise: vi.fn().mockResolvedValue({ comment_responses: responses }),
      },
      postMessage: vi.fn().mockRejectedValue(new Error('channel unavailable')),
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'revised' });
    expect(deps.failRun).not.toHaveBeenCalled();
    expect(run.stage).toBe('reviewing_spec');
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.reply_failed', comment_id: 'disc-1' }),
      'Failed to reply to publisher comment',
    );
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.notify_failed', run_id: 'run-001' }),
      'Failed to post completion notification',
    );
  });
});
