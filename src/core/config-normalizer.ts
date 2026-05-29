import type { WorkflowConfig } from '../types/config.js';
import {
  defaultArtifactLifecyclePolicies,
  type ArtifactLifecyclePolicy,
  type ArtifactKind,
} from '../types/artifact.js';

export interface NormalizedChannelConfig {
  provider: string;
  name: string;
  workspace_root?: string;
  config: Record<string, unknown>;
}

export interface NormalizedPublisherConfig {
  provider: string;
  artifacts: Array<'artifact' | 'implementation_feedback' | string>;
  config: Record<string, unknown>;
}

export interface NormalizedWorkflowConfig {
  workspace_root?: string;
  workspace_auto_prune: boolean;
  channels: NormalizedChannelConfig[];
  publishers: NormalizedPublisherConfig[];
  artifact_policies: Record<ArtifactKind, ArtifactLifecyclePolicy>;
}

export function normalizeWorkflowConfig(config: WorkflowConfig): NormalizedWorkflowConfig {
  const channels = normalizeChannels(config);
  const publishers = normalizePublishers(config);

  return {
    workspace_root: config.workspace?.root,
    workspace_auto_prune: config.workspace?.auto_prune ?? true,
    channels,
    publishers,
    artifact_policies: normalizeArtifactPolicies(config.artifact_policies),
  };
}

function normalizeArtifactPolicies(
  overrides: WorkflowConfig['artifact_policies'],
): Record<ArtifactKind, ArtifactLifecyclePolicy> {
  const defaults = defaultArtifactLifecyclePolicies();
  if (!overrides) return defaults;

  return {
    feature_spec: { ...defaults.feature_spec, ...overrides.feature_spec },
    bug_triage: { ...defaults.bug_triage, ...overrides.bug_triage },
    chore_plan: { ...defaults.chore_plan, ...overrides.chore_plan },
  };
}

function normalizeChannels(config: WorkflowConfig): NormalizedChannelConfig[] {
  const rawChannels = (config as { channels?: unknown }).channels;
  if (Array.isArray(rawChannels)) {
    return rawChannels
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map(entry => ({
        provider: String(entry['provider'] ?? ''),
        name: String(entry['name'] ?? ''),
        workspace_root: stringField(entry, 'workspace_root'),
        config: recordField(entry, 'config'),
      }));
  }

  return [];
}

function normalizePublishers(config: WorkflowConfig): NormalizedPublisherConfig[] {
  const rawPublishers = (config as { publishers?: unknown }).publishers;
  if (Array.isArray(rawPublishers)) {
    return rawPublishers
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map(entry => ({
        provider: String(entry['provider'] ?? ''),
        artifacts: Array.isArray(entry['artifacts']) ? entry['artifacts'].map(String) : [],
        config: recordField(entry, 'config'),
      }));
  }

  return [];
}

function stringField(entry: Record<string, unknown>, key: string): string | undefined {
  return typeof entry[key] === 'string' ? entry[key] : undefined;
}

function recordField(entry: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = entry[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
