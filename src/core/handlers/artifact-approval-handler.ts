import type pino from 'pino';
import type { IssueManager } from '../../types/issue-tracker.js';
import type { SpecCommitter } from '../spec-committer.js';
import type { ThreadMessage } from '../../types/events.js';
import type { ArtifactContentSource, ArtifactPublisher } from '../../types/publisher.js';
import type { ArtifactLifecyclePolicy, ArtifactKind } from '../../types/artifact.js';
import { getArtifactLifecyclePolicy } from '../../types/artifact.js';
import type { Run, RunStage } from '../../types/runs.js';
import type { ChannelRepoMap } from '../../types/config.js';
import type { ConversationRef } from '../../types/channel.js';
import type { ArtifactRefs } from '../run-refs.js';
import { markArtifactStatus, requireArtifactRefs, runChannelKey } from '../run-refs.js';
import type { BranchGuard } from '../git-branch-guard.js';

export interface ArtifactApprovalDeps {
  artifactPublisher: Pick<ArtifactPublisher, 'updateStatus' | 'setIssueLink'>;
  artifactContentSource?: Pick<ArtifactContentSource, 'getContent'>;
  artifactPolicies?: Record<ArtifactKind, ArtifactLifecyclePolicy>;
  specCommitter?: Pick<SpecCommitter, 'commit'>;
  issueManager?: Pick<IssueManager, 'writeIssue' | 'create'>;
  channelRepoMap: ChannelRepoMap;
  postMessage: (conversation: ConversationRef, text: string) => Promise<void>;
  transition: (run: Run, stage: RunStage) => void;
  failRun: (run: Run, conversation: ConversationRef, error: unknown) => Promise<void>;
  persist: () => void;
  logger: Pick<pino.Logger, 'info' | 'error'>;
  branchGuard?: BranchGuard;
}

export type ArtifactApprovalResult =
  | { status: 'approved'; implementation_required: boolean }
  | { status: 'failed' };

export class ArtifactApprovalHandler {
  constructor(private readonly deps: ArtifactApprovalDeps) {}

  async handle(run: Run, feedback: ThreadMessage): Promise<ArtifactApprovalResult> {
    const refs = requireArtifactRefs(run);
    if (!refs) {
      await this.deps.failRun(run, feedback.conversation, new Error('Run missing artifact local path or publisher ref for approval'));
      return { status: 'failed' };
    }

    const policy = this.lifecyclePolicy(refs.artifact.kind);

    await this.acknowledgeApproval(feedback, policy);

    if (policy.sync_issue_on_approval) {
      const approved = await this.syncIssueOnApproval(run, feedback, refs);
      if (!approved) return { status: 'failed' };
    }

    if (policy.commit_on_approval) {
      const approved = await this.commitArtifactOnApproval(run, feedback, refs);
      if (!approved) return { status: 'failed' };
    }

    if (policy.implementation_required) {
      run.attempt += 1;
      this.deps.persist();
      this.deps.transition(run, 'planning');
    } else {
      this.deps.transition(run, 'done');
    }

    return { status: 'approved', implementation_required: policy.implementation_required };
  }

  private lifecyclePolicy(kind: ArtifactKind): ArtifactLifecyclePolicy {
    return { ...(this.deps.artifactPolicies?.[kind] ?? getArtifactLifecyclePolicy(kind)) };
  }

  private async acknowledgeApproval(feedback: ThreadMessage, policy: ArtifactLifecyclePolicy): Promise<void> {
    try {
      const next = policy.implementation_required ? ' and starting planning' : '';
      const ackMsg = policy.sync_issue_on_approval
        ? `Approved \u2014 writing triage to issue${next}.`
        : `Approved \u2014 committing spec${next}.`;
      await this.deps.postMessage(feedback.conversation, ackMsg);
    } catch (err) {
      this.deps.logger.error({ event: 'run.notify_failed', error: String(err) }, 'Failed to post approval acknowledgement');
    }
  }

  private async syncIssueOnApproval(run: Run, feedback: ThreadMessage, refs: ArtifactRefs): Promise<boolean> {
    // Guard: fail if the workspace branch has drifted from run.branch
    if (this.deps.branchGuard) {
      try {
        await this.deps.branchGuard.check(run.workspace_path, run.branch);
      } catch (err) {
        await this.deps.failRun(run, feedback.conversation, err);
        return false;
      }
    }

    if (!this.deps.issueManager) {
      await this.deps.failRun(run, feedback.conversation, new Error('Issue manager is required for artifact issue sync'));
      return false;
    }

    let triageContent: string;
    try {
      if (!this.deps.artifactContentSource) {
        throw new Error('Artifact content source is required for issue sync');
      }
      triageContent = await this.deps.artifactContentSource.getContent(refs.publication_ref);
    } catch (err) {
      await this.deps.failRun(run, feedback.conversation, err);
      return false;
    }

    const issueBody = stripFrontmatter(triageContent);
    let issue_number: number;
    try {
      if (run.issue) {
        await this.deps.issueManager.writeIssue(run.workspace_path, run.issue, issueBody);
        issue_number = run.issue;
      } else {
        const title = extractH1(issueBody) ?? `${run.intent} triage`;
        issue_number = (await this.deps.issueManager.create(run.workspace_path, title, issueBody)).number;
        run.issue = issue_number;
        this.deps.persist();
      }
    } catch (err) {
      await this.deps.failRun(run, feedback.conversation, err);
      return false;
    }

    this.markArtifactApproved(run, issue_number);
    this.deps.logger.info(
      { event: 'triage.approved', run_id: run.id, request_id: run.request_id, intent: run.intent, issue_number },
      'Triage approved',
    );

    const repoEntry = this.deps.channelRepoMap.get(runChannelKey(run))!;
    const issue_url = `${repoEntry.repo_url}/issues/${issue_number}`;
    await Promise.allSettled([
      this.deps.artifactPublisher.setIssueLink?.(refs.publication_ref, issue_url),
      this.deps.artifactPublisher.updateStatus?.(refs.publication_ref, 'approved'),
    ]).then(results => {
      for (const r of results) {
        if (r.status === 'rejected') {
          this.deps.logger.error(
            { event: 'run.status_update_failed', run_id: run.id, error: String(r.reason) },
            'Failed to update triage document properties',
          );
        }
      }
    });
    return true;
  }

  private async commitArtifactOnApproval(run: Run, feedback: ThreadMessage, refs: ArtifactRefs): Promise<boolean> {
    if (!this.deps.specCommitter) {
      await this.deps.failRun(run, feedback.conversation, new Error('Spec committer is required for artifact commit'));
      return false;
    }

    // Guard: fail if the workspace branch has drifted from run.branch
    if (this.deps.branchGuard) {
      try {
        await this.deps.branchGuard.check(run.workspace_path, run.branch);
      } catch (err) {
        await this.deps.failRun(run, feedback.conversation, err);
        return false;
      }
    }

    try {
      await this.deps.specCommitter.commit(run.workspace_path, refs.publication_ref, refs.local_path);
    } catch (err) {
      await this.deps.failRun(run, feedback.conversation, err);
      return false;
    }

    await this.deps.artifactPublisher.updateStatus?.(refs.publication_ref, 'approved').catch(err =>
      this.deps.logger.error(
        { event: 'run.status_update_failed', run_id: run.id, status: 'approved', error: String(err) },
        'Failed to update spec status',
      ),
    );
    this.markArtifactApproved(run);
    return true;
  }

  private markArtifactApproved(run: Run, issue_number?: number): void {
    markArtifactStatus(run, 'approved', issue_number);
    this.deps.persist();
  }
}

function extractH1(content: string): string | undefined {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : undefined;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '');
}
