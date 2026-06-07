import { parse as parseYaml } from 'yaml';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import type { WorkflowConfig, LoadedConfig, AiConfig, CredentialConfig, EndpointConfig, ProfileConfig, RoutingConfig, SpecReviewPolicy } from '../types/config.js';
import { generateDefaultConfig } from '../config/defaults.js';

// ─── Resolved AI config types ─────────────────────────────────────────────────

export interface ResolvedCredential {
  name: string;
  type: CredentialConfig['type'];
  /** Resolved value for api_key and bearer_token credentials */
  resolvedValue?: string;
  aws_profile?: string;
  federation_rule_id?: string;
  organization_id?: string;
  service_account_id?: string;
}

export interface ResolvedAiConfig {
  credentials: ResolvedCredential[];
  endpoints: EndpointConfig[];
  profiles: ProfileConfig[];
  routing: RoutingConfig;
}

// ─── Env var resolution ───────────────────────────────────────────────────────

interface ResolveResult {
  resolved: Record<string, unknown>;
  missing: string[];
}

export function resolveEnvVars(
  obj: Record<string, unknown>,
  env: Record<string, string | undefined>,
): ResolveResult {
  const missing: string[] = [];

  function resolveValue(value: unknown): unknown {
    if (typeof value === 'string') {
      const placeholder = '\x00DOLLAR\x00';
      let result = value.replace(/\$\$/g, placeholder);
      result = result.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
        (_match, braced: string | undefined, bare: string | undefined) => {
          const varName = braced ?? bare!;
          const envValue = env[varName];
          if (envValue === undefined || envValue === '') {
            if (!missing.includes(varName)) missing.push(varName);
            return _match;
          }
          return envValue;
        },
      );
      result = result.replace(new RegExp(placeholder, 'g'), '$');
      return result;
    }
    if (Array.isArray(value)) return value.map(resolveValue);
    if (value !== null && typeof value === 'object') return resolveObject(value as Record<string, unknown>);
    return value;
  }

  function resolveObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) result[key] = resolveValue(val);
    return result;
  }

  return { resolved: resolveObject(obj), missing };
}

// ─── Config validation ────────────────────────────────────────────────────────

export function validateConfig(config: WorkflowConfig): void {
  if (config.polling?.interval_ms !== undefined) {
    if (typeof config.polling.interval_ms !== 'number' || config.polling.interval_ms <= 0) {
      throw new Error('polling.interval_ms must be a positive number');
    }
  }

  if (config.workspace?.root !== undefined) {
    if (typeof config.workspace.root !== 'string' || config.workspace.root.trim() === '') {
      throw new Error('workspace.root must be a non-empty string');
    }
  }

  if (config.workspace?.auto_prune !== undefined && typeof config.workspace.auto_prune !== 'boolean') {
    throw new Error('workspace.auto_prune must be a boolean');
  }

  if (config.channels !== undefined) {
    if (!Array.isArray(config.channels)) throw new Error('channels must be an array');
    for (const [index, channel] of config.channels.entries()) {
      if (typeof channel.provider !== 'string' || channel.provider.trim() === '') {
        throw new Error(`channels[${index}].provider must be a non-empty string`);
      }
      if (typeof channel.name !== 'string' || channel.name.trim() === '') {
        throw new Error(`channels[${index}].name must be a non-empty string`);
      }
      if (channel.workspace_root !== undefined && (typeof channel.workspace_root !== 'string' || channel.workspace_root.trim() === '')) {
        throw new Error(`channels[${index}].workspace_root must be a non-empty string`);
      }
      if (channel.config !== undefined && (typeof channel.config !== 'object' || channel.config === null || Array.isArray(channel.config))) {
        throw new Error(`channels[${index}].config must be an object`);
      }
    }
  }

  if (config.publishers !== undefined) {
    if (!Array.isArray(config.publishers)) throw new Error('publishers must be an array');
    for (const [index, publisher] of config.publishers.entries()) {
      if (typeof publisher.provider !== 'string' || publisher.provider.trim() === '') {
        throw new Error(`publishers[${index}].provider must be a non-empty string`);
      }
      if (publisher.artifacts !== undefined && !Array.isArray(publisher.artifacts)) {
        throw new Error(`publishers[${index}].artifacts must be an array`);
      }
      if (publisher.config !== undefined && (typeof publisher.config !== 'object' || publisher.config === null || Array.isArray(publisher.config))) {
        throw new Error(`publishers[${index}].config must be an object`);
      }
    }
  }

  const rawAi = (config as Record<string, unknown>)['ai'];
  if (rawAi !== undefined && rawAi !== null && typeof rawAi === 'object' && !Array.isArray(rawAi)) {
    const endpoints = (rawAi as Record<string, unknown>)['endpoints'];
    if (endpoints !== undefined) {
      if (!Array.isArray(endpoints)) throw new Error('ai.endpoints must be an array');
      for (const [endpointIndex, rawEndpoint] of endpoints.entries()) {
        if (typeof rawEndpoint !== 'object' || rawEndpoint === null || Array.isArray(rawEndpoint)) continue;
        const filter = (rawEndpoint as Record<string, unknown>)['anthropic_beta_header_filter'];
        if (filter === undefined) continue;
        if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
          throw new Error(`ai.endpoints[${endpointIndex}].anthropic_beta_header_filter must be an object`);
        }
        const strip = (filter as Record<string, unknown>)['strip'];
        if (!Array.isArray(strip)) {
          throw new Error(`ai.endpoints[${endpointIndex}].anthropic_beta_header_filter.strip must be an array`);
        }
        for (const [stripIndex, value] of strip.entries()) {
          if (typeof value !== 'string' || value.trim() === '') {
            throw new Error(`ai.endpoints[${endpointIndex}].anthropic_beta_header_filter.strip[${stripIndex}] must be a non-empty string`);
          }
        }
      }
    }
  }

  const rawSandbox = (config as Record<string, unknown>)['sandbox'];
  if (rawSandbox !== undefined && rawSandbox !== null) {
    if (typeof rawSandbox !== 'object' || Array.isArray(rawSandbox)) {
      throw new Error('sandbox must be an object');
    }
    const sandbox = rawSandbox as Record<string, unknown>;
    if (sandbox['env_tokens'] !== undefined) {
      if (!Array.isArray(sandbox['env_tokens'])) {
        throw new Error('sandbox.env_tokens must be an array');
      }
      for (const [i, token] of (sandbox['env_tokens'] as unknown[]).entries()) {
        if (typeof token !== 'string' || (token as string).trim() === '') {
          throw new Error(`sandbox.env_tokens[${i}] must be a non-empty string`);
        }
      }
    }
  }

  const rawReview = (config as Record<string, unknown>)['implementation_review'];
  if (rawReview !== undefined && rawReview !== null) {
    if (typeof rawReview !== 'object' || Array.isArray(rawReview)) {
      throw new Error('implementation_review must be an object');
    }
    const rr = rawReview as Record<string, unknown>;
    if (rr['on_review_failure'] !== undefined && rr['on_review_failure'] !== 'warn' && rr['on_review_failure'] !== 'block') {
      throw new Error(`implementation_review.on_review_failure must be "warn" or "block", got "${String(rr['on_review_failure'])}"`);
    }
    if (rr['max_initial_rounds'] !== undefined) {
      if (typeof rr['max_initial_rounds'] !== 'number' || !Number.isInteger(rr['max_initial_rounds']) || (rr['max_initial_rounds'] as number) < 1) {
        throw new Error('implementation_review.max_initial_rounds must be a positive integer');
      }
    }
    if (rr['max_final_rounds'] !== undefined) {
      if (typeof rr['max_final_rounds'] !== 'number' || !Number.isInteger(rr['max_final_rounds']) || (rr['max_final_rounds'] as number) < 1) {
        throw new Error('implementation_review.max_final_rounds must be a positive integer');
      }
    }
    if (rr['convergence'] !== undefined) {
      if (typeof rr['convergence'] !== 'object' || rr['convergence'] === null || Array.isArray(rr['convergence'])) {
        throw new Error('implementation_review.convergence must be an object');
      }
      const convergence = rr['convergence'] as Record<string, unknown>;
      if (convergence['enabled'] !== undefined && typeof convergence['enabled'] !== 'boolean') {
        throw new Error('implementation_review.convergence.enabled must be a boolean');
      }
      if (convergence['allow_same_model'] !== undefined && typeof convergence['allow_same_model'] !== 'boolean') {
        throw new Error('implementation_review.convergence.allow_same_model must be a boolean');
      }
      const validDepths = ['build_only', 'layout', 'public_api', 'full'];
      const validFeedbackDepths = [...validDepths, 'inherit'];
      if (convergence['depth'] !== undefined && !validDepths.includes(String(convergence['depth']))) {
        throw new Error('implementation_review.convergence.depth must be one of build_only, layout, public_api, full');
      }
      if (convergence['feedback_depth'] !== undefined && !validFeedbackDepths.includes(String(convergence['feedback_depth']))) {
        throw new Error('implementation_review.convergence.feedback_depth must be one of build_only, layout, public_api, full, inherit');
      }
      if (convergence['max_model_sessions_per_run'] !== undefined) {
        const value = convergence['max_model_sessions_per_run'];
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
          throw new Error('implementation_review.convergence.max_model_sessions_per_run must be a positive integer');
        }
      }
    }
  }

  const rawJournal = (config as Record<string, unknown>)['journal'];
  if (rawJournal !== undefined && rawJournal !== null) {
    if (typeof rawJournal !== 'object' || Array.isArray(rawJournal)) {
      throw new Error('journal must be an object');
    }
    const journal = rawJournal as Record<string, unknown>;
    if (journal['enabled'] !== undefined && typeof journal['enabled'] !== 'boolean') {
      throw new Error('journal.enabled must be a boolean');
    }
  }

  const rawSpecReview = (config as Record<string, unknown>)['spec_review'];
  if (rawSpecReview !== undefined && rawSpecReview !== null) {
    if (typeof rawSpecReview !== 'object' || Array.isArray(rawSpecReview)) {
      throw new Error('spec_review must be an object');
    }
    const sr = rawSpecReview as Record<string, unknown>;
    if (sr['on_review_failure'] !== undefined && sr['on_review_failure'] !== 'warn' && sr['on_review_failure'] !== 'block') {
      throw new Error(`spec_review.on_review_failure must be "warn" or "block", got "${String(sr['on_review_failure'])}"`);
    }
    if (sr['max_rounds'] !== undefined) {
      if (typeof sr['max_rounds'] !== 'number' || !Number.isInteger(sr['max_rounds']) || (sr['max_rounds'] as number) < 1) {
        throw new Error('spec_review.max_rounds must be a positive integer');
      }
    }
    if (sr['template_conformance'] !== undefined && typeof sr['template_conformance'] !== 'boolean') {
      throw new Error('spec_review.template_conformance must be a boolean');
    }
  }
}

export function isWorkspaceAutoPruneEnabled(config: WorkflowConfig): boolean {
  return config.workspace?.auto_prune ?? true;
}

export function redactConfig(
  config: Record<string, unknown>,
  resolvedValues: Record<string, string>,
): Record<string, unknown> {
  const secretValues = new Set(Object.values(resolvedValues).filter(v => v.length > 0));

  function redactValue(value: unknown): unknown {
    if (typeof value === 'string' && secretValues.has(value)) return '[from env]';
    if (Array.isArray(value)) return value.map(redactValue);
    if (value !== null && typeof value === 'object') return redactObject(value as Record<string, unknown>);
    return value;
  }

  function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) result[key] = redactValue(val);
    return result;
  }

  return redactObject(config);
}

// ─── Config parsing ───────────────────────────────────────────────────────────

/**
 * Parses the content of an autocatalyst.yaml file into a WorkflowConfig.
 * Performs plain YAML parsing — no frontmatter or markdown body.
 * Does not throw when the `ai:` key is absent; that is resolveAiConfig's responsibility.
 */
export function parseAutocatalystConfig(content: string): WorkflowConfig {
  if (!content || !content.trim()) return {} as WorkflowConfig;
  const parsed = parseYaml(content, { uniqueKeys: true, strict: true }) as WorkflowConfig | null;
  return parsed ?? ({} as WorkflowConfig);
}

// ─── AI config resolution ─────────────────────────────────────────────────────

/**
 * Resolves and validates the `ai:` section of an autocatalyst.yaml config.
 *
 * Validation checks (all run at startup before any agent work):
 * - Endpoint references unknown credential → throws
 * - Profile references unknown endpoint → throws
 * - Routing value references unknown profile → throws
 * - runner:claude_agent_sdk + protocol:openai → throws
 * - workload_identity missing required fields → throws
 * - api_key/bearer_token value resolves to empty after env substitution → throws
 *
 * Returns ResolvedAiConfig with credential values substituted from env.
 */
export function resolveAiConfig(
  config: WorkflowConfig,
  env: Record<string, string | undefined>,
): ResolvedAiConfig {
  const ai = config.ai;
  if (!ai) {
    throw new Error('ai: section is required in autocatalyst.yaml');
  }

  const credentials: CredentialConfig[] = ai.credentials ?? [];
  const endpoints: EndpointConfig[] = ai.endpoints ?? [];
  const profiles: ProfileConfig[] = ai.profiles ?? [];
  const routing: RoutingConfig = ai.routing ?? {};

  const credentialNames = new Set(credentials.map(c => c.name));
  const endpointNames = new Set(endpoints.map(e => e.name));
  const profileNames = new Set(profiles.map(p => p.name));

  // Validate endpoint → credential cross-references
  for (const endpoint of endpoints) {
    if (!credentialNames.has(endpoint.credential)) {
      throw new Error(`Endpoint '${endpoint.name}' references unknown credential '${endpoint.credential}'`);
    }
  }

  // Validate profile → endpoint cross-references
  for (const profile of profiles) {
    if (!endpointNames.has(profile.endpoint)) {
      throw new Error(`Profile '${profile.name}' references unknown endpoint '${profile.endpoint}'`);
    }
  }

  // Validate routing → profile cross-references
  for (const [task, profileName] of Object.entries(routing)) {
    if (!profileNames.has(profileName)) {
      throw new Error(`Routing '${task}' references unknown profile '${profileName}'`);
    }
  }

  // Validate runner/protocol compatibility
  for (const profile of profiles) {
    const endpoint = endpoints.find(e => e.name === profile.endpoint)!;
    if (profile.runner === 'claude_agent_sdk' && endpoint.protocol === 'openai') {
      throw new Error(
        `Profile '${profile.name}': runner 'claude_agent_sdk' is incompatible with protocol 'openai'`,
      );
    }
  }

  // Validate that all claude_agent_sdk profiles share one beta filter config.
  // The runner uses a single shared proxy — divergent configs would silently misroute.
  const claudeSdkFilters = profiles
    .filter(p => p.runner === 'claude_agent_sdk')
    .map(p => {
      const ep = endpoints.find(e => e.name === p.endpoint)!;
      const strip = ep.anthropic_beta_header_filter?.strip ?? [];
      return { profile: p.name, key: `${ep.base_url ?? ''}::${[...strip].sort().join(',')}` };
    });
  const distinctFilterKeys = new Set(claudeSdkFilters.map(f => f.key));
  if (distinctFilterKeys.size > 1) {
    throw new Error(
      `All claude_agent_sdk profiles must share the same endpoint beta filter config. Found divergent configs across: ${claudeSdkFilters.map(f => f.profile).join(', ')}`,
    );
  }

  // Resolve and validate credentials
  const resolvedCredentials: ResolvedCredential[] = credentials.map(cred => {
    if (cred.type === 'workload_identity') {
      if (!cred.federation_rule_id || !cred.organization_id || !cred.service_account_id) {
        throw new Error(
          `Credential '${cred.name}': workload_identity requires federation_rule_id, organization_id, service_account_id`,
        );
      }
      return {
        name: cred.name,
        type: cred.type,
        federation_rule_id: cred.federation_rule_id,
        organization_id: cred.organization_id,
        service_account_id: cred.service_account_id,
      };
    }

    if (cred.type === 'api_key' || cred.type === 'bearer_token') {
      if (!cred.value) {
        throw new Error(`Credential '${cred.name}': env var '' is not set`);
      }
      const { resolved, missing } = resolveEnvVars({ value: cred.value }, env);
      if (missing.length > 0) {
        throw new Error(`Credential '${cred.name}': env var '${missing[0]}' is not set`);
      }
      const resolvedValue = (resolved as { value: string }).value;
      if (!resolvedValue || resolvedValue.trim() === '') {
        throw new Error(`Credential '${cred.name}': env var '${cred.value}' is not set`);
      }
      return { name: cred.name, type: cred.type, resolvedValue };
    }

    // iam
    return { name: cred.name, type: cred.type, aws_profile: cred.aws_profile?.trim() || undefined };
  });

  return { credentials: resolvedCredentials, endpoints, profiles, routing };
}

// ─── Config loading ───────────────────────────────────────────────────────────

export function loadConfigFromPath(
  repoPath: string,
  env: Record<string, string | undefined>,
): LoadedConfig {
  const filePath = join(resolve(repoPath), 'autocatalyst.yaml');

  if (!existsSync(filePath)) {
    throw new Error('autocatalyst.yaml not found at ' + filePath);
  }

  const content = readFileSync(filePath, 'utf-8');
  const config = parseAutocatalystConfig(content);
  const { resolved } = resolveEnvVars(config as Record<string, unknown>, env);
  validateConfig(resolved as WorkflowConfig);

  return {
    config: resolved as WorkflowConfig,
    filePath,
  };
}

export function loadConfig(
  filePath: string,
  env: Record<string, string | undefined>,
): LoadedConfig {
  const repoPath = basename(filePath) === 'autocatalyst.yaml' ? dirname(filePath) : filePath;
  return loadConfigFromPath(repoPath || '.', env);
}

export function bootstrapConfig(repoPath: string): boolean {
  const normalizedPath = resolve(repoPath);
  const configPath = join(normalizedPath, 'autocatalyst.yaml');

  if (existsSync(configPath)) {
    return false; // already exists
  }

  const repoName = basename(normalizedPath);
  const content = generateDefaultConfig(repoName);
  writeFileSync(configPath, content, 'utf-8');
  return true; // created
}

export function repoNameFromUrl(repo_url: string): string {
  const normalized = repo_url.replace(/\.git$/, '').replace(/^[^@]+@[^:]+:/, '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments.slice(-2).join('/') || 'unknown';
}

export function getImplementationReviewPolicy(config: WorkflowConfig): {
  max_initial_rounds: number;
  max_final_rounds: number;
  on_review_failure: 'warn' | 'block';
  retest_on_behavior_change: boolean;
  convergence: { enabled: boolean; allow_same_model: boolean };
} {
  const raw = (config as Record<string, unknown>)['implementation_review'] as Record<string, unknown> | undefined;
  const rawConvergence = raw?.['convergence'] as Record<string, unknown> | undefined;
  const convergenceEnabled = rawConvergence?.['enabled'] === true;
  const defaultMaxRounds = convergenceEnabled ? 2 : 1;
  return {
    max_initial_rounds: typeof raw?.['max_initial_rounds'] === 'number' ? raw['max_initial_rounds'] as number : defaultMaxRounds,
    max_final_rounds: typeof raw?.['max_final_rounds'] === 'number' ? raw['max_final_rounds'] as number : defaultMaxRounds,
    on_review_failure: (raw?.['on_review_failure'] === 'block' ? 'block' : 'warn'),
    retest_on_behavior_change: raw?.['retest_on_behavior_change'] === false ? false : true,
    convergence: {
      enabled: convergenceEnabled,
      allow_same_model: rawConvergence?.['allow_same_model'] === true,
    },
  };
}

export function getSpecReviewPolicy(config: WorkflowConfig): Required<SpecReviewPolicy> {
  const raw = (config as Record<string, unknown>)['spec_review'] as Record<string, unknown> | undefined;
  return {
    max_rounds: typeof raw?.['max_rounds'] === 'number' ? raw['max_rounds'] as number : 1,
    on_review_failure: raw?.['on_review_failure'] === 'block' ? 'block' : 'warn',
    template_conformance: raw?.['template_conformance'] === false ? false : true,
  };
}

export function getSpecAuthoringPolicy(config: WorkflowConfig): {
  api_convergence: { enabled: boolean; max_rounds: number; allow_same_model: boolean };
} {
  const rawAuthoring = (config as Record<string, unknown>)['spec_authoring'];
  const authoring = rawAuthoring && typeof rawAuthoring === 'object' && !Array.isArray(rawAuthoring)
    ? rawAuthoring as Record<string, unknown>
    : {};
  const rawApi = authoring['api_convergence'];
  const api = rawApi && typeof rawApi === 'object' && !Array.isArray(rawApi)
    ? rawApi as Record<string, unknown>
    : {};
  const rawMaxRounds = api['max_rounds'];
  const max_rounds = typeof rawMaxRounds === 'number' ? rawMaxRounds : 5;
  if (!Number.isInteger(max_rounds) || max_rounds < 1) {
    throw new Error('spec_authoring.api_convergence.max_rounds must be a positive integer');
  }
  return {
    api_convergence: {
      enabled: api['enabled'] === true,
      max_rounds,
      allow_same_model: api['allow_same_model'] === true,
    },
  };
}
