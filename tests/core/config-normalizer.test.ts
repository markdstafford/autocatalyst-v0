import { describe, expect, it } from 'vitest';
import { normalizeWorkflowConfig } from '../../src/core/config-normalizer.js';
import type { WorkflowConfig } from '../../src/types/config.js';

describe('normalizeWorkflowConfig', () => {
  it('does not normalize provider-specific legacy top-level config', () => {
    const config: WorkflowConfig = {
      workspace: { root: '/tmp/workspaces' },
      chat_provider: { token: '$CHAT_TOKEN', channel_name: 'autocatalyst' },
      artifact_provider: { token: '$ARTIFACT_TOKEN' },
    };

    const normalized = normalizeWorkflowConfig(config);

    expect(normalized.channels).toEqual([]);
    expect(normalized.publishers).toEqual([]);
  });

  it('installs default artifact lifecycle policies', () => {
    const normalized = normalizeWorkflowConfig({});

    expect(normalized.artifact_policies.feature_spec.commit_on_approval).toBe(true);
    expect(normalized.artifact_policies.bug_triage.sync_issue_on_approval).toBe(true);
    expect(normalized.artifact_policies.chore_plan.sync_issue_on_approval).toBe(true);
  });

  it('merges configured artifact lifecycle policy overrides with defaults', () => {
    const normalized = normalizeWorkflowConfig({
      artifact_policies: {
        feature_spec: {
          commit_on_approval: false,
          sync_issue_on_approval: true,
        },
      },
    });

    expect(normalized.artifact_policies.feature_spec).toEqual({
      commit_on_approval: false,
      sync_issue_on_approval: true,
      implementation_required: true,
    });
    expect(normalized.artifact_policies.bug_triage).toEqual({
      commit_on_approval: false,
      sync_issue_on_approval: true,
      implementation_required: true,
    });
  });

  it('normalizes workspace root into the runtime config contract', () => {
    const normalized = normalizeWorkflowConfig({
      workspace: { root: '/tmp/workspaces' },
    });

    expect(normalized.workspace_root).toBe('/tmp/workspaces');
  });

  it('workspace_auto_prune defaults to true when not set', () => {
    const normalized = normalizeWorkflowConfig({});
    expect(normalized.workspace_auto_prune).toBe(true);
  });

  it('workspace_auto_prune preserves false', () => {
    const normalized = normalizeWorkflowConfig({ workspace: { auto_prune: false } });
    expect(normalized.workspace_auto_prune).toBe(false);
  });

  it('preserves channel and publisher config in provider-owned config blocks', () => {
    const normalized = normalizeWorkflowConfig({
      channels: [
        {
          provider: 'chat',
          name: 'product',
          workspace_root: '/tmp/product',
          config: {
            bot_token: '$CHAT_BOT_TOKEN',
            app_token: '$CHAT_APP_TOKEN',
            reactions: { ack: 'eyes', complete: 'white_check_mark' },
          },
        },
        { provider: 'comments', name: 'org/repo' },
      ],
      publishers: [
        {
          provider: 'documents',
          artifacts: ['artifact'],
          config: {
            review_database_id: 'review-db',
            testing_guides_database_id: 'guide-db',
          },
        },
        { provider: 'issue-tracker', artifacts: ['artifact'] },
      ],
    });

    expect(normalized.channels[0]).toEqual({
      provider: 'chat',
      name: 'product',
      workspace_root: '/tmp/product',
      config: {
        bot_token: '$CHAT_BOT_TOKEN',
        app_token: '$CHAT_APP_TOKEN',
        reactions: { ack: 'eyes', complete: 'white_check_mark' },
      },
    });
    expect(normalized.publishers[0]).toEqual({
      provider: 'documents',
      artifacts: ['artifact'],
      config: {
        review_database_id: 'review-db',
        testing_guides_database_id: 'guide-db',
      },
    });
  });
});
