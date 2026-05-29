import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseAutocatalystConfig,
  resolveEnvVars,
  validateConfig,
  redactConfig,
  repoNameFromUrl,
  loadConfigFromPath,
  loadConfig,
  resolveAiConfig,
  getImplementationReviewPolicy,
  isWorkspaceAutoPruneEnabled,
} from '../../src/core/config.js';
import type { WorkflowConfig } from '../../src/types/config.js';

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '../fixtures', name), 'utf-8');

// ─── parseAutocatalystConfig ──────────────────────────────────────────────────

describe('parseAutocatalystConfig', () => {
  it('parses a valid autocatalyst.yaml string with all top-level sections', () => {
    const result = parseAutocatalystConfig(fixture('valid-config.yaml'));
    expect(result.polling?.interval_ms).toBe(5000);
    expect(result.workspace?.root).toBe('/tmp/workspaces');
    expect(result.channels).toHaveLength(1);
    expect(result.publishers).toHaveLength(1);
    expect(result.ai).toBeDefined();
  });

  it('returns all four ai sections when present', () => {
    const result = parseAutocatalystConfig(fixture('valid-config.yaml'));
    expect(result.ai?.credentials).toHaveLength(1);
    expect(result.ai?.endpoints).toHaveLength(1);
    expect(result.ai?.profiles).toHaveLength(1);
    expect(result.ai?.routing).toBeDefined();
  });

  it('does not throw when the ai: key is absent', () => {
    const content = 'polling:\n  interval_ms: 5000\n';
    expect(() => parseAutocatalystConfig(content)).not.toThrow();
  });

  it('returns an empty config object for empty input', () => {
    const result = parseAutocatalystConfig('');
    expect(result).toEqual({});
  });

  it('throws on duplicate YAML keys', () => {
    const content = 'key: one\nkey: two\n';
    expect(() => parseAutocatalystConfig(content)).toThrow();
  });
});

// ─── resolveAiConfig ──────────────────────────────────────────────────────────

function makeConfig(ai: unknown): WorkflowConfig {
  return { ai } as unknown as WorkflowConfig;
}

describe('resolveAiConfig', () => {
  // Valid base AI config builder
  function validAiConfig() {
    return {
      credentials: [{ name: 'my-key', type: 'api_key', value: '${MY_KEY}' }],
      endpoints: [{ name: 'ep', protocol: 'anthropic', credential: 'my-key' }],
      profiles: [{ name: 'classify', endpoint: 'ep', model: 'haiku', runner: 'anthropic_direct' }],
      routing: { 'intent.classify': 'classify' },
    };
  }

  it('resolves a valid config without error', () => {
    const config = makeConfig(validAiConfig());
    const result = resolveAiConfig(config, { MY_KEY: 'sk-test' });
    expect(result.credentials[0].resolvedValue).toBe('sk-test');
    expect(result.endpoints[0].name).toBe('ep');
    expect(result.profiles[0].name).toBe('classify');
    expect(result.routing['intent.classify']).toBe('classify');
  });

  it('throws when ai: section is absent', () => {
    expect(() => resolveAiConfig({} as WorkflowConfig, {})).toThrow('ai: section is required');
  });

  it('throws when endpoint references unknown credential', () => {
    const ai = validAiConfig();
    ai.endpoints[0].credential = 'nonexistent';
    expect(() => resolveAiConfig(makeConfig(ai), { MY_KEY: 'sk' })).toThrow(
      "Endpoint 'ep' references unknown credential 'nonexistent'",
    );
  });

  it('throws when profile references unknown endpoint', () => {
    const ai = validAiConfig();
    ai.profiles[0].endpoint = 'nonexistent';
    expect(() => resolveAiConfig(makeConfig(ai), { MY_KEY: 'sk' })).toThrow(
      "Profile 'classify' references unknown endpoint 'nonexistent'",
    );
  });

  it('throws when routing references unknown profile', () => {
    const ai = validAiConfig();
    ai.routing['intent.classify'] = 'nonexistent';
    expect(() => resolveAiConfig(makeConfig(ai), { MY_KEY: 'sk' })).toThrow(
      "Routing 'intent.classify' references unknown profile 'nonexistent'",
    );
  });

  it('throws when claude_agent_sdk is paired with openai protocol', () => {
    const ai = validAiConfig();
    ai.endpoints[0].protocol = 'openai';
    ai.profiles[0].runner = 'claude_agent_sdk';
    expect(() => resolveAiConfig(makeConfig(ai), { MY_KEY: 'sk' })).toThrow(
      "runner 'claude_agent_sdk' is incompatible with protocol 'openai'",
    );
  });

  it('throws for workload_identity missing federation_rule_id', () => {
    const ai = {
      credentials: [{ name: 'wi', type: 'workload_identity', organization_id: 'org', service_account_id: 'sa' }],
      endpoints: [{ name: 'ep', protocol: 'anthropic', credential: 'wi' }],
      profiles: [{ name: 'p', endpoint: 'ep', model: 'haiku', runner: 'anthropic_direct' }],
      routing: {},
    };
    expect(() => resolveAiConfig(makeConfig(ai), {})).toThrow(
      "workload_identity requires federation_rule_id, organization_id, service_account_id",
    );
  });

  it('throws for api_key credential when env var is not set', () => {
    const config = makeConfig(validAiConfig());
    expect(() => resolveAiConfig(config, {})).toThrow("env var 'MY_KEY' is not set");
  });

  it('resolves iam credential without a value field', () => {
    const ai = {
      credentials: [{ name: 'my-iam', type: 'iam', aws_profile: 'my-profile' }],
      endpoints: [{ name: 'ep', protocol: 'anthropic', credential: 'my-iam' }],
      profiles: [{ name: 'p', endpoint: 'ep', model: 'haiku', runner: 'anthropic_direct' }],
      routing: {},
    };
    const result = resolveAiConfig(makeConfig(ai), {});
    expect(result.credentials[0].aws_profile).toBe('my-profile');
    expect(result.credentials[0].resolvedValue).toBeUndefined();
  });

  it('resolves bearer_token credential', () => {
    const ai = {
      credentials: [{ name: 'tok', type: 'bearer_token', value: '${MY_TOKEN}' }],
      endpoints: [{ name: 'ep', protocol: 'anthropic', credential: 'tok' }],
      profiles: [{ name: 'p', endpoint: 'ep', model: 'haiku', runner: 'anthropic_direct' }],
      routing: {},
    };
    const result = resolveAiConfig(makeConfig(ai), { MY_TOKEN: 'bearer-abc' });
    expect(result.credentials[0].resolvedValue).toBe('bearer-abc');
  });
});

// ─── resolveEnvVars (unchanged) ───────────────────────────────────────────────

describe('resolveEnvVars', () => {
  it('resolves $VAR at start of string', () => {
    const result = resolveEnvVars({ key: '$HOME' }, { HOME: '/users/test' });
    expect(result.resolved.key).toBe('/users/test');
    expect(result.missing).toEqual([]);
  });

  it('resolves ${VAR} with braces', () => {
    const result = resolveEnvVars({ key: '${MY_VAR}' }, { MY_VAR: 'value' });
    expect(result.resolved.key).toBe('value');
  });

  it('resolves $$ as literal $', () => {
    const result = resolveEnvVars({ key: 'price: $$5' }, {});
    expect(result.resolved.key).toBe('price: $5');
  });

  it('collects all missing variables', () => {
    const result = resolveEnvVars({ a: '$ONE', b: '$TWO' }, {});
    expect(result.missing).toContain('ONE');
    expect(result.missing).toContain('TWO');
  });

  it('resolves nested objects recursively', () => {
    const result = resolveEnvVars(
      { channels: [{ config: { token: '$TOKEN' } }] },
      { TOKEN: 'secret-123' },
    );
    const channels = result.resolved.channels as Array<{ config: Record<string, string> }>;
    expect(channels[0].config.token).toBe('secret-123');
  });
});

// ─── validateConfig (unchanged) ──────────────────────────────────────────────

describe('validateConfig', () => {
  it('passes for empty config', () => {
    expect(() => validateConfig({} as WorkflowConfig)).not.toThrow();
  });

  it('throws when channel provider is missing', () => {
    expect(() => validateConfig({ channels: [{ provider: '', name: 'product' }] } as WorkflowConfig))
      .toThrow(/channels\[0\]\.provider/);
  });

  it('throws for negative interval_ms', () => {
    expect(() => validateConfig({ polling: { interval_ms: -1 } } as WorkflowConfig))
      .toThrow(/interval_ms/);
  });

  it('passes for endpoint beta header filter strip config', () => {
    expect(() => validateConfig({
      ai: {
        credentials: [],
        profiles: [],
        routing: {},
        endpoints: [{
          name: 'grove-anthropic',
          protocol: 'anthropic',
          credential: 'grove',
          anthropic_beta_header_filter: {
            strip: ['advisor-tool-2026-03-01'],
          },
        }],
      },
    } as unknown as WorkflowConfig)).not.toThrow();
  });

  it('throws when endpoint beta header filter strip config is not an array', () => {
    expect(() => validateConfig({
      ai: {
        credentials: [],
        profiles: [],
        routing: {},
        endpoints: [{
          name: 'grove-anthropic',
          protocol: 'anthropic',
          credential: 'grove',
          anthropic_beta_header_filter: {
            strip: 'advisor-tool-2026-03-01',
          },
        }],
      },
    } as unknown as WorkflowConfig)).toThrow('ai.endpoints[0].anthropic_beta_header_filter.strip must be an array');
  });

  it('throws when endpoint beta header filter strip config contains an empty value', () => {
    expect(() => validateConfig({
      ai: {
        credentials: [],
        profiles: [],
        routing: {},
        endpoints: [{
          name: 'grove-anthropic',
          protocol: 'anthropic',
          credential: 'grove',
          anthropic_beta_header_filter: {
            strip: ['advisor-tool-2026-03-01', ''],
          },
        }],
      },
    } as unknown as WorkflowConfig)).toThrow('ai.endpoints[0].anthropic_beta_header_filter.strip[1] must be a non-empty string');
  });
});

// ─── redactConfig (unchanged) ────────────────────────────────────────────────

describe('redactConfig', () => {
  it('replaces resolved env var values with [from env]', () => {
    const config = { channels: [{ config: { token: 'secret-123' } }] };
    const redacted = redactConfig(config, { CHAT_TOKEN: 'secret-123' });
    const channels = redacted.channels as Array<{ config: Record<string, string> }>;
    expect(channels[0].config.token).toBe('[from env]');
  });
});

// ─── repoNameFromUrl (unchanged) ─────────────────────────────────────────────

describe('repoNameFromUrl', () => {
  it('HTTPS URL with .git', () => {
    expect(repoNameFromUrl('https://example.test/acme-org/autocatalyst.git')).toBe('acme-org/autocatalyst');
  });

  it('SSH URL with .git', () => {
    expect(repoNameFromUrl('git@example.test:acme-org/autocatalyst.git')).toBe('acme-org/autocatalyst');
  });
});

// ─── loadConfigFromPath ───────────────────────────────────────────────────────

describe('loadConfigFromPath', () => {
  it('returns parsed LoadedConfig for a valid repo path with autocatalyst.yaml', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lcp-test-'));
    try {
      writeFileSync(join(tempDir, 'autocatalyst.yaml'), fixture('valid-config.yaml'), 'utf-8');
      const result = loadConfigFromPath(tempDir, { TEST_API_KEY: 'sk-test' });
      expect(result.config.polling?.interval_ms).toBe(5000);
      expect(result.filePath).toBe(join(tempDir, 'autocatalyst.yaml'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('throws with path in message when autocatalyst.yaml is missing', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lcp-test-'));
    rmSync(tempDir, { recursive: true, force: true });
    expect(() => loadConfigFromPath(tempDir, {})).toThrow(tempDir);
  });

  it('does NOT attempt to read WORKFLOW.md', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lcp-test-'));
    try {
      writeFileSync(join(tempDir, 'WORKFLOW.md'), '---\n---\n', 'utf-8');
      // Only WORKFLOW.md present — should still throw (autocatalyst.yaml not found)
      expect(() => loadConfigFromPath(tempDir, {})).toThrow('autocatalyst.yaml not found');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── validateConfig: sandbox ─────────────────────────────────────────────────

describe('validateConfig: sandbox', () => {
  it('passes when sandbox is absent', () => {
    expect(() => validateConfig({} as WorkflowConfig)).not.toThrow();
  });

  it('passes for a valid sandbox block with env_tokens array', () => {
    expect(() =>
      validateConfig({ sandbox: { env_tokens: ['AC_GH_TOKEN', 'AC_GITHUB_TOKEN'] } } as unknown as WorkflowConfig),
    ).not.toThrow();
  });

  it('passes when sandbox.env_tokens is an empty array', () => {
    expect(() =>
      validateConfig({ sandbox: { env_tokens: [] } } as unknown as WorkflowConfig),
    ).not.toThrow();
  });

  it('throws when sandbox is not an object', () => {
    expect(() =>
      validateConfig({ sandbox: 'bad' } as unknown as WorkflowConfig),
    ).toThrow('sandbox must be an object');
  });

  it('throws when sandbox is an array', () => {
    expect(() =>
      validateConfig({ sandbox: ['AC_GH_TOKEN'] } as unknown as WorkflowConfig),
    ).toThrow('sandbox must be an object');
  });

  it('throws when sandbox.env_tokens is not an array', () => {
    expect(() =>
      validateConfig({ sandbox: { env_tokens: 'AC_GH_TOKEN' } } as unknown as WorkflowConfig),
    ).toThrow('sandbox.env_tokens must be an array');
  });

  it('throws when sandbox.env_tokens contains a non-string entry', () => {
    expect(() =>
      validateConfig({ sandbox: { env_tokens: ['AC_GH_TOKEN', 42] } } as unknown as WorkflowConfig),
    ).toThrow('sandbox.env_tokens[1] must be a non-empty string');
  });

  it('throws when sandbox.env_tokens contains an empty string', () => {
    expect(() =>
      validateConfig({ sandbox: { env_tokens: ['AC_GH_TOKEN', ''] } } as unknown as WorkflowConfig),
    ).toThrow('sandbox.env_tokens[1] must be a non-empty string');
  });

  it('throws when sandbox.env_tokens contains a whitespace-only string', () => {
    expect(() =>
      validateConfig({ sandbox: { env_tokens: ['   '] } } as unknown as WorkflowConfig),
    ).toThrow('sandbox.env_tokens[0] must be a non-empty string');
  });
});

// ─── validateConfig: implementation_review ───────────────────────────────────

describe('validateConfig: implementation_review', () => {
  it('passes when implementation_review is absent', () => {
    expect(() => validateConfig({} as WorkflowConfig)).not.toThrow();
  });

  it('passes for a valid implementation_review block', () => {
    expect(() =>
      validateConfig({ implementation_review: { on_review_failure: 'block', max_initial_rounds: 2, max_final_rounds: 3 } } as unknown as WorkflowConfig),
    ).not.toThrow();
  });

  it('throws when implementation_review is not an object', () => {
    expect(() =>
      validateConfig({ implementation_review: 'bad' } as unknown as WorkflowConfig),
    ).toThrow('implementation_review must be an object');
  });

  it('throws when on_review_failure is an invalid value', () => {
    expect(() =>
      validateConfig({ implementation_review: { on_review_failure: 'ignore' } } as unknown as WorkflowConfig),
    ).toThrow('on_review_failure must be "warn" or "block"');
  });

  it('throws when max_initial_rounds is zero', () => {
    expect(() =>
      validateConfig({ implementation_review: { max_initial_rounds: 0 } } as unknown as WorkflowConfig),
    ).toThrow('max_initial_rounds must be a positive integer');
  });

  it('throws when max_initial_rounds is a float', () => {
    expect(() =>
      validateConfig({ implementation_review: { max_initial_rounds: 1.5 } } as unknown as WorkflowConfig),
    ).toThrow('max_initial_rounds must be a positive integer');
  });

  it('throws when max_final_rounds is negative', () => {
    expect(() =>
      validateConfig({ implementation_review: { max_final_rounds: -1 } } as unknown as WorkflowConfig),
    ).toThrow('max_final_rounds must be a positive integer');
  });
});

// ─── validateConfig: workspace.auto_prune ────────────────────────────────────

describe('validateConfig: workspace.auto_prune', () => {
  it('accepts workspace.auto_prune: true', () => {
    expect(() => validateConfig({ workspace: { auto_prune: true } } as WorkflowConfig)).not.toThrow();
  });

  it('accepts workspace.auto_prune: false', () => {
    expect(() => validateConfig({ workspace: { auto_prune: false } } as WorkflowConfig)).not.toThrow();
  });

  it('rejects non-boolean workspace.auto_prune', () => {
    expect(() => validateConfig({ workspace: { auto_prune: 'yes' as any } } as WorkflowConfig)).toThrow('workspace.auto_prune must be a boolean');
  });
});

// ─── getImplementationReviewPolicy ───────────────────────────────────────────

describe('getImplementationReviewPolicy', () => {
  it('returns defaults when implementation_review is absent', () => {
    const policy = getImplementationReviewPolicy({} as WorkflowConfig);
    expect(policy).toEqual({
      max_initial_rounds: 1,
      max_final_rounds: 1,
      on_review_failure: 'warn',
      retest_on_behavior_change: true,
    });
  });

  it('uses provided on_review_failure: block', () => {
    const policy = getImplementationReviewPolicy({ implementation_review: { on_review_failure: 'block' } } as unknown as WorkflowConfig);
    expect(policy.on_review_failure).toBe('block');
  });

  it('uses provided max_initial_rounds', () => {
    const policy = getImplementationReviewPolicy({ implementation_review: { max_initial_rounds: 3 } } as unknown as WorkflowConfig);
    expect(policy.max_initial_rounds).toBe(3);
  });

  it('uses provided max_final_rounds', () => {
    const policy = getImplementationReviewPolicy({ implementation_review: { max_final_rounds: 2 } } as unknown as WorkflowConfig);
    expect(policy.max_final_rounds).toBe(2);
  });

  it('returns retest_on_behavior_change: false when explicitly set to false', () => {
    const policy = getImplementationReviewPolicy({ implementation_review: { retest_on_behavior_change: false } } as unknown as WorkflowConfig);
    expect(policy.retest_on_behavior_change).toBe(false);
  });

  it('defaults on_review_failure to warn when not set', () => {
    const policy = getImplementationReviewPolicy({ implementation_review: { max_initial_rounds: 2 } } as unknown as WorkflowConfig);
    expect(policy.on_review_failure).toBe('warn');
  });
});

// ─── isWorkspaceAutoPruneEnabled ─────────────────────────────────────────────

describe('isWorkspaceAutoPruneEnabled', () => {
  it('defaults to true when field is absent', () => {
    expect(isWorkspaceAutoPruneEnabled({} as WorkflowConfig)).toBe(true);
  });

  it('returns true when set to true', () => {
    expect(isWorkspaceAutoPruneEnabled({ workspace: { auto_prune: true } } as WorkflowConfig)).toBe(true);
  });

  it('returns false when set to false', () => {
    expect(isWorkspaceAutoPruneEnabled({ workspace: { auto_prune: false } } as WorkflowConfig)).toBe(false);
  });
});
