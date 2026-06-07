/**
 * Type-level tests for AiConfig, CredentialConfig, ProfileConfig, RoutingConfig.
 * Verified at compile time via `tsc --noEmit` — no runtime assertions needed.
 */
import { describe, it, expect } from 'vitest';
import type { WorkflowConfig, AiConfig, CredentialConfig, EndpointConfig, ProfileConfig, RoutingConfig, JournalConfig } from '../../src/types/config.js';

// T1: WorkflowConfig with anthropic api_key credential satisfies the type
const _t1: WorkflowConfig = {
  ai: {
    credentials: [{ name: 'my-key', type: 'api_key', value: '${MY_KEY}' }],
    endpoints: [{ name: 'ep', protocol: 'anthropic', credential: 'my-key' }],
    profiles: [{ name: 'p', endpoint: 'ep', model: 'haiku', runner: 'anthropic_direct' }],
    routing: { 'intent.classify': 'p' },
  },
} satisfies WorkflowConfig;
void _t1;

// T2: WorkflowConfig with bedrock iam credential satisfies the type
const _t2: WorkflowConfig = {
  ai: {
    credentials: [{ name: 'bedrock-iam', type: 'iam', aws_profile: 'my-profile' }],
    endpoints: [{ name: 'ep', protocol: 'anthropic', credential: 'bedrock-iam' }],
    profiles: [{ name: 'p', endpoint: 'ep', model: 'haiku', runner: 'anthropic_direct' }],
    routing: {},
  },
} satisfies WorkflowConfig;
void _t2;

// T3: 'api_key' satisfies CredentialType
const _t3: CredentialConfig = { name: 'x', type: 'api_key', value: '${MY_KEY}' };
void _t3;

// T4: WorkflowConfig without ai: does NOT satisfy the type
// @ts-expect-error — ai is required
const _t4: WorkflowConfig = {} satisfies WorkflowConfig;
void _t4;

// T5: AiConfig with all four fields satisfies the type
const _t5: AiConfig = {
  credentials: [],
  endpoints: [],
  profiles: [],
  routing: {},
};
void _t5;

// T6: WorkflowConfig with journal config satisfies the type
const _t6: WorkflowConfig = {
  ai: {
    credentials: [],
    endpoints: [],
    profiles: [],
    routing: {},
  },
  journal: { enabled: false },
} satisfies WorkflowConfig;
void _t6;

// T7: JournalConfig with no fields satisfies the type
const _t7: JournalConfig = {};
void _t7;

// Suppress unused import warnings
void (null as unknown as EndpointConfig);
void (null as unknown as ProfileConfig);
void (null as unknown as RoutingConfig);

describe('AiConfig and related compile-time types', () => {
  it('type assertions are verified at compile time via tsc --noEmit', () => {
    // All assertions are compile-time only (see module-level constants above).
  });

  it('accepts spec review route and policy fields', () => {
    const config: WorkflowConfig = {
      ai: {
        credentials: [],
        endpoints: [],
        profiles: [],
        routing: { 'spec.review': 'review-agent' },
      },
      spec_review: {
        max_rounds: 1,
        on_review_failure: 'warn',
        template_conformance: true,
      },
    };

    expect(config.ai.routing['spec.review']).toBe('review-agent');
    expect(config.spec_review?.template_conformance).toBe(true);
  });
});
