import type pino from 'pino';
import type { ArtifactAuthoringAgent, GateReviewExchange } from '../../types/ai.js';
import type { ArtifactPublication, ArtifactPublisher } from '../../types/publisher.js';
import type { Request } from '../../types/events.js';
import type { ArtifactKind } from '../../types/artifact.js';
import { artifactKindForIntent } from '../../types/artifact.js';
import type { Run, RunStage, RequestIntent } from '../../types/runs.js';
import type { ChannelRepoMap } from '../../types/config.js';
import type { WorkspaceManager } from '../workspace-manager.js';
import { channelKey, type ConversationRef } from '../../types/channel.js';
import type { BranchGuard } from '../git-branch-guard.js';
import type { SpecReviewCoordinator } from '../ai/spec-review-coordinator.js';
import { makeRunAgentRequestRecorder } from '../run-ai-context.js';
import type { RunJournal } from '../journal/run-journal.js';
import type { AgentSessionCaptureFn } from '../../types/ai.js';
import type { AuthoringApiConvergenceCoordinator } from '../ai/authoring-api-convergence-coordinator.js';
import { insertConvergedApiSection } from '../ai/authoring-api-artifact.js';

type ArtifactCreationIntent = Extract<RequestIntent, 'idea' | 'bug' | 'chore'>;

export interface ArtifactCreationDeps {
  workspaceManager: Pick<WorkspaceManager, 'create' | 'destroy'>;
  artifactAuthoringAgent: Pick<ArtifactAuthoringAgent, 'create' | 'createTechSpecDraft' | 'decomposeTasks'>;
  artifactPublisher: Pick<ArtifactPublisher, 'createArtifact' | 'updateStatus'>;
  channelRepoMap: ChannelRepoMap;
  postMessage: (conversation: ConversationRef, text: string) => Promise<void>;
  transition: (run: Run, stage: RunStage) => void;
  failRun: (run: Run, conversation: ConversationRef, error: unknown) => Promise<void>;
  persist: () => void;
  logger: Pick<pino.Logger, 'warn' | 'error' | 'info'>;
  branchGuard?: BranchGuard;
  specReviewCoordinator?: Pick<SpecReviewCoordinator, 'runSpecReview'>;
  journal?: Pick<RunJournal, 'captureSession' | 'captureFeedback'>;
  specAuthoringPolicy?: { api_convergence: { enabled: boolean; max_rounds: number; allow_same_model: boolean } };
  authoringApiConvergenceCoordinator?: Pick<AuthoringApiConvergenceCoordinator, 'run'>;
  readFile?: (path: string, encoding: 'utf-8') => Promise<string>;
  writeFile?: (path: string, content: string, encoding: 'utf-8') => Promise<void>;
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

    // Fail clearly when api_convergence is enabled but required dependencies are absent
    if (intent === 'idea' && this.deps.specAuthoringPolicy?.api_convergence.enabled === true) {
      const missingDeps: string[] = [];
      if (!this.deps.authoringApiConvergenceCoordinator) missingDeps.push('authoringApiConvergenceCoordinator');
      if (typeof this.deps.artifactAuthoringAgent.createTechSpecDraft !== 'function') missingDeps.push('createTechSpecDraft');
      if (typeof this.deps.artifactAuthoringAgent.decomposeTasks !== 'function') missingDeps.push('decomposeTasks');
      if (missingDeps.length > 0) {
        await this.deps.workspaceManager.destroy(workspace_path);
        await this.deps.failRun(run, request.conversation, new Error(
          `spec_authoring.api_convergence is enabled but required dependencies are missing: ${missingDeps.join(', ')}`,
        ));
        return;
      }
    }

    const useApiConvergence = intent === 'idea'
      && this.deps.specAuthoringPolicy?.api_convergence.enabled === true;

    let local_path: string;
    const captureSession: AgentSessionCaptureFn | undefined = this.deps.journal
      ? (data) => { void this.deps.journal!.captureSession({ ...data, run, round: data.round ?? 1 }).catch(() => {}); }
      : undefined;

    if (useApiConvergence) {
      // Enabled path: tech spec → branch guard → API convergence → insert API section → task decomposition
      try {
        await onProgress('Spec authoring started — drafting through tech spec');
        const techResult = await this.deps.artifactAuthoringAgent.createTechSpecDraft!(request, workspace_path, onProgress, { run_id: run.id, request_id: run.request_id, onAgentRequest, captureSession });
        local_path = techResult.artifact_path;
        this.setArtifactDraft(run, artifactKindForIntent(intent)!, local_path);
      } catch (err) {
        await this.deps.workspaceManager.destroy(workspace_path);
        await this.deps.failRun(run, request.conversation, err);
        return;
      }

      // Branch guard after tech spec
      if (this.deps.branchGuard) {
        try {
          await this.deps.branchGuard.check(workspace_path, branch);
        } catch (err) {
          await this.deps.workspaceManager.destroy(workspace_path);
          await this.deps.failRun(run, request.conversation, err);
          return;
        }
      }

      try {
        await onProgress('Tech spec draft complete — starting API convergence');

        // Build captureFeedback for API exchanges
        const captureFeedbackForApi = this.deps.journal
          ? (exchange: GateReviewExchange, captureRun: Run) => {
              const criticProfile = exchange.critic_profile;
              for (const finding of exchange.findings) {
                const disposition: 'open' | 'addressed' = (exchange.converged || finding.severity === 'info') ? 'addressed' : 'open';
                void this.deps.journal!.captureFeedback!({
                  id: `${exchange.id}:${finding.id}`,
                  run: captureRun,
                  target: 'artifact',
                  gate: exchange.gate,
                  author_principal: `review:${criticProfile.provider}:${criticProfile.profile}`,
                  text: finding.finding + (finding.suggested_action ? ' | ' + finding.suggested_action : ''),
                  severity: finding.severity,
                  category: finding.category,
                  disposition,
                }).catch(() => {});
              }
            }
          : undefined;

        // Run API convergence
        const apiResult = await this.deps.authoringApiConvergenceCoordinator!.run({
          run,
          artifact_path: local_path,
          working_directory: workspace_path,
          onProgress,
          onAgentRequest,
          captureSession,
          captureFeedback: captureFeedbackForApi,
        });

        // Insert converged API section into spec
        const readFileFn = this.deps.readFile ?? ((p: string, e: 'utf-8') => import('node:fs/promises').then(m => m.readFile(p, e)));
        const writeFileFn = this.deps.writeFile ?? ((p: string, c: string, e: 'utf-8') => import('node:fs/promises').then(m => m.writeFile(p, c, e)));
        const currentSpec = await readFileFn(local_path, 'utf-8');
        await writeFileFn(local_path, insertConvergedApiSection(currentSpec, apiResult.markdown), 'utf-8');

        await onProgress('Converged API folded into spec — decomposing tasks');

        // Task decomposition
        await this.deps.artifactAuthoringAgent.decomposeTasks!(local_path, workspace_path, onProgress, { run_id: run.id, request_id: run.request_id, onAgentRequest, captureSession });

        await onProgress('Task decomposition complete — publishing spec for review');
      } catch (err) {
        await this.deps.workspaceManager.destroy(workspace_path);
        await this.deps.failRun(run, request.conversation, err);
        return;
      }
    } else {
      // Disabled path: existing create() flow
      try {
        const result = intent === 'idea'
          ? await this.deps.artifactAuthoringAgent.create(request, workspace_path, onProgress, undefined, { run_id: run.id, request_id: run.request_id, onAgentRequest, captureSession })
          : await this.deps.artifactAuthoringAgent.create(request, workspace_path, onProgress, intent, { run_id: run.id, request_id: run.request_id, onAgentRequest, captureSession });
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

    // Spec review (idea intent only, after branch guard, before publish)
    if (intent === 'idea' && this.deps.specReviewCoordinator && run.artifact) {
      const captureSessionForReview: AgentSessionCaptureFn | undefined = this.deps.journal
        ? (data) => { void this.deps.journal!.captureSession({ ...data, run, round: 1 }).catch(() => {}); }
        : undefined;
      const reviewResult = await this.deps.specReviewCoordinator.runSpecReview({
        run,
        artifact_path: local_path,
        working_directory: workspace_path,
        artifact_kind: run.artifact.kind,
        onProgress: (message: string) => this.deps.postMessage(request.conversation, message).catch(err => {
          this.deps.logger.warn(
            { event: 'progress_failed', phase: 'spec_review', run_id: run.id, error: String(err) },
            'Failed to post spec review progress update',
          );
        }),
        onAgentRequest,
        captureSession: captureSessionForReview,
      });

      if (reviewResult.status !== 'complete') {
        await this.deps.workspaceManager.destroy(workspace_path);
        await this.deps.failRun(run, request.conversation, new Error(reviewResult.question ?? reviewResult.error ?? 'Spec review did not complete'));
        return;
      }

      // Second branch guard after review-driven author edits
      if (this.deps.branchGuard) {
        try {
          await this.deps.branchGuard.check(workspace_path, branch);
        } catch (err) {
          await this.deps.workspaceManager.destroy(workspace_path);
          await this.deps.failRun(run, request.conversation, err);
          return;
        }
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
