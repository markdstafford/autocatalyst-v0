import type pino from 'pino';
import type { ArtifactAuthoringAgent } from '../../types/ai.js';
import type { ArtifactPublication, ArtifactPublisher } from '../../types/publisher.js';
import type { Request } from '../../types/events.js';
import type { ArtifactKind } from '../../types/artifact.js';
import { artifactKindForIntent } from '../../types/artifact.js';
import type { Run, RunStage, RequestIntent } from '../../types/runs.js';
import type { ChannelRepoMap } from '../../types/config.js';
import type { WorkspaceManager } from '../workspace-manager.js';
import { channelKey, type ConversationRef } from '../../types/channel.js';
import type { BranchGuard } from '../git-branch-guard.js';
import { makeRunAgentRequestRecorder } from '../run-ai-context.js';

type ArtifactCreationIntent = Extract<RequestIntent, 'idea' | 'bug' | 'chore'>;

export interface ArtifactCreationDeps {
  workspaceManager: Pick<WorkspaceManager, 'create' | 'destroy'>;
  artifactAuthoringAgent: Pick<ArtifactAuthoringAgent, 'create'>;
  artifactPublisher: Pick<ArtifactPublisher, 'createArtifact' | 'updateStatus'>;
  channelRepoMap: ChannelRepoMap;
  postMessage: (conversation: ConversationRef, text: string) => Promise<void>;
  transition: (run: Run, stage: RunStage) => void;
  failRun: (run: Run, conversation: ConversationRef, error: unknown) => Promise<void>;
  persist: () => void;
  logger: Pick<pino.Logger, 'warn' | 'error' | 'info'>;
  branchGuard?: BranchGuard;
}

export class ArtifactCreationHandler {
  constructor(private readonly deps: ArtifactCreationDeps) {}

  async handle(run: Run, request: Request, intent: ArtifactCreationIntent): Promise<void> {
    this.deps.transition(run, 'speccing');

    if (intent === 'bug' || intent === 'chore') {
      this.deps.logger.info(
        { event: 'triage.started', run_id: run.id, request_id: run.request_id, intent },
        'Triage started',
      );
    }

    let workspace_path: string;
    let branch: string;
    try {
      const repoEntry = this.deps.channelRepoMap.get(channelKey(request.channel))!;
      ({ workspace_path, branch } = await this.deps.workspaceManager.create(request.id, repoEntry.repo_url, repoEntry.workspace_root));
      run.workspace_path = workspace_path;
      run.branch = branch;
    } catch (err) {
      await this.deps.failRun(run, request.conversation, err);
      return;
    }

    const progressPhase = intent === 'idea' ? 'spec_generation' : 'triage_generation';
    const onProgress = (message: string): Promise<void> =>
      this.deps.postMessage(request.conversation, message).catch(err => {
        this.deps.logger.warn(
          { event: 'progress_failed', phase: progressPhase, run_id: run.id, error: String(err) },
          'Failed to post progress update',
        );
      });

    const onAgentRequest = makeRunAgentRequestRecorder(run, this.deps.persist, this.deps.logger);

    let local_path: string;
    try {
      const result = intent === 'idea'
        ? await this.deps.artifactAuthoringAgent.create(request, workspace_path, onProgress, undefined, { run_id: run.id, request_id: run.request_id, onAgentRequest })
        : await this.deps.artifactAuthoringAgent.create(request, workspace_path, onProgress, intent, { run_id: run.id, request_id: run.request_id, onAgentRequest });
      local_path = result.artifact_path;
      this.setArtifactDraft(run, artifactKindForIntent(intent)!, local_path);
      if (intent !== 'idea' && result.existing_issue !== undefined) {
        run.issue = result.existing_issue;
        this.deps.persist();
      }
    } catch (err) {
      await this.deps.workspaceManager.destroy(workspace_path);
      await this.deps.failRun(run, request.conversation, err);
      return;
    }

    // Guard: fail if the agent drifted to another branch
    if (this.deps.branchGuard) {
      try {
        await this.deps.branchGuard.check(workspace_path, branch);
      } catch (err) {
        await this.deps.workspaceManager.destroy(workspace_path);
        await this.deps.failRun(run, request.conversation, err);
        return;
      }
    }

    let publication: ArtifactPublication;
    try {
      publication = await this.deps.artifactPublisher.createArtifact(request.conversation, run.artifact!);
      this.setArtifactPublished(run, publication);
      await this.postArtifactPublication(request.conversation, publication);
    } catch (err) {
      await this.deps.workspaceManager.destroy(workspace_path);
      await this.deps.failRun(run, request.conversation, err);
      return;
    }

    this.deps.transition(run, 'reviewing_spec');

    if (intent === 'bug' || intent === 'chore') {
      this.deps.logger.info(
        { event: 'triage.complete', run_id: run.id, request_id: run.request_id, intent, publication_ref: publication.id },
        'Triage complete',
      );
    }

    await this.deps.artifactPublisher.updateStatus?.(publication.id, 'waiting_on_feedback').catch(err =>
      this.deps.logger.error(
        { event: 'run.status_update_failed', run_id: run.id, status: 'waiting_on_feedback', error: String(err) },
        intent === 'idea' ? 'Failed to update spec status' : 'Failed to update triage document status',
      ),
    );
  }

  private setArtifactDraft(run: Run, kind: ArtifactKind, local_path: string): void {
    run.artifact = {
      kind,
      local_path,
      status: 'drafting',
      ...(run.artifact?.linked_issue ? { linked_issue: run.artifact.linked_issue } : {}),
    };
    this.deps.persist();
  }

  private setArtifactPublished(run: Run, publication: ArtifactPublication): void {
    if (!run.artifact) return;
    run.artifact = {
      ...run.artifact,
      published_ref: {
        provider: publication.provider ?? 'artifact_publisher',
        id: publication.id,
        ...(publication.url ? { url: publication.url } : {}),
      },
      status: 'waiting_on_feedback',
    };
    this.deps.persist();
  }

  private async postArtifactPublication(conversation: ConversationRef, publication: ArtifactPublication): Promise<void> {
    if (!publication.url) return;
    const linkText = publication.label
      ? `${publication.label} — ${publication.url}`
      : publication.url;
    try {
      await this.deps.postMessage(conversation, `Artifact ready for review: ${linkText}`);
    } catch (err) {
      this.deps.logger.warn(
        { event: 'artifact.publication_notify_failed', publication_ref: publication.id, error: String(err) },
        'Failed to post artifact publication link',
      );
    }
  }

}
