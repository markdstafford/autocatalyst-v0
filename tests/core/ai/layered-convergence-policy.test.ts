import { describe, expect, it } from 'vitest';
import { resolveImplementationConvergencePolicy } from '../../../src/core/ai/layered-convergence-policy.js';
import type { WorkflowConfig } from '../../../src/types/config.js';

function makeConfig(overrides: Partial<WorkflowConfig['implementation_review']> = {}): WorkflowConfig {
  return {
    implementation_review: {
      convergence: {
        enabled: true,
        depth: 'build_only',
        ...overrides.convergence,
      },
      ...overrides,
    },
  } as WorkflowConfig;
}

describe('resolveImplementationConvergencePolicy', () => {
  it('returns build_only depth unchanged with no warning when depth is build_only', () => {
    const warnings: unknown[] = [];
    const config = makeConfig({ convergence: { enabled: true, depth: 'build_only' } });
    const policy = resolveImplementationConvergencePolicy(config, warning => warnings.push(warning));
    expect(policy.depth).toBe('build_only');
    expect(warnings).toHaveLength(0);
  });

  it('maps full depth to build_only and emits a depth_ignored warning', () => {
    const warnings: unknown[] = [];
    const config = makeConfig({ convergence: { enabled: true, depth: 'full' } });
    const policy = resolveImplementationConvergencePolicy(config, warning => warnings.push(warning));
    expect(policy.depth).toBe('build_only');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      event: 'implementation_review.convergence.depth_ignored',
      configured_depth: 'full',
      effective_behavior: 'build_only',
    });
  });

  it('maps layout depth to build_only and emits a depth_ignored warning', () => {
    const warnings: unknown[] = [];
    const config = makeConfig({ convergence: { enabled: true, depth: 'layout' } });
    const policy = resolveImplementationConvergencePolicy(config, warning => warnings.push(warning));
    expect(policy.depth).toBe('build_only');
    expect(warnings[0]).toMatchObject({
      event: 'implementation_review.convergence.depth_ignored',
      configured_depth: 'layout',
      effective_behavior: 'build_only',
    });
  });

  it('maps public_api depth to build_only and emits a depth_ignored warning', () => {
    const warnings: unknown[] = [];
    const config = makeConfig({ convergence: { enabled: true, depth: 'public_api' } });
    const policy = resolveImplementationConvergencePolicy(config, warning => warnings.push(warning));
    expect(policy.depth).toBe('build_only');
    expect(warnings[0]).toMatchObject({
      event: 'implementation_review.convergence.depth_ignored',
      configured_depth: 'public_api',
      effective_behavior: 'build_only',
    });
  });

  it('works without a warn callback (no throw)', () => {
    const config = makeConfig({ convergence: { enabled: true, depth: 'full' } });
    const policy = resolveImplementationConvergencePolicy(config);
    expect(policy.depth).toBe('build_only');
  });

  it('preserves other policy fields (enabled, allow_same_model, max_model_sessions_per_run)', () => {
    const warnings: unknown[] = [];
    const config = makeConfig({ convergence: { enabled: true, allow_same_model: true, depth: 'full', max_model_sessions_per_run: 10 } });
    const policy = resolveImplementationConvergencePolicy(config, warning => warnings.push(warning));
    expect(policy.enabled).toBe(true);
    expect(policy.allow_same_model).toBe(true);
    expect(policy.max_model_sessions_per_run).toBe(10);
  });
});
