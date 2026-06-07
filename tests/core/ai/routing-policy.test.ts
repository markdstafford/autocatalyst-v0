import { describe, expect, test } from 'vitest';
import { DefaultAgentRoutingPolicy, agentProfileSummary } from '../../../src/core/ai/routing-policy.js';
import type { AiConfig } from '../../../src/types/config.js';

function makeAiConfig(overrides?: Partial<AiConfig>): AiConfig {
  return {
    credentials: [{ name: 'my-key', type: 'api_key', value: 'sk-test' }],
    endpoints: [{ name: 'ep', protocol: 'anthropic', credential: 'my-key' }],
    profiles: [
      {
        name: 'direct-default',
        endpoint: 'ep',
        model: 'claude-haiku-4-5',
        runner: 'anthropic_direct',
        anthropic: { effort: 'low' },
      },
      {
        name: 'agent-default',
        endpoint: 'ep',
        model: 'claude-sonnet-4-5',
        runner: 'claude_agent_sdk',
        anthropic: { effort: 'medium', thinking: 'adaptive' },
      },
    ],
    routing: {
      'intent.classify': 'direct-default',
      'pr.title_generate': 'direct-default',
      'artifact.create': 'agent-default',
      'artifact.revise': 'agent-default',
      'implementation.run': 'agent-default',
      'question.answer': 'agent-default',
      'issue.triage': 'agent-default',
    },
    ...overrides,
  };
}

describe('DefaultAgentRoutingPolicy', () => {
  test('resolves intent.classify to the direct profile', () => {
    const policy = new DefaultAgentRoutingPolicy(makeAiConfig());
    expect(policy.resolve({ task: 'intent.classify' })).toMatchObject({
      id: 'direct-default',
      provider: 'anthropic',
      effort: 'low',
    });
  });

  test('resolves pr.title_generate to the direct profile', () => {
    const policy = new DefaultAgentRoutingPolicy(makeAiConfig());
    expect(policy.resolve({ task: 'pr.title_generate' })).toMatchObject({
      id: 'direct-default',
      provider: 'anthropic',
    });
  });

  test('resolves implementation.run to the agent profile', () => {
    const policy = new DefaultAgentRoutingPolicy(makeAiConfig());
    expect(policy.resolve({ task: 'implementation.run' })).toMatchObject({
      id: 'agent-default',
      provider: 'claude_agent_sdk',
      effort: 'medium',
      thinking: 'adaptive',
    });
  });

  test('resolves artifact.create to the agent profile', () => {
    const policy = new DefaultAgentRoutingPolicy(makeAiConfig());
    expect(policy.resolve({ task: 'artifact.create' })).toMatchObject({
      id: 'agent-default',
      provider: 'claude_agent_sdk',
    });
  });

  test('throws for a task not in routing', () => {
    const config = makeAiConfig();
    // Remove one routing entry to simulate missing task
    delete config.routing['question.answer'];
    const policy = new DefaultAgentRoutingPolicy(config);
    expect(() => policy.resolve({ task: 'question.answer' })).toThrow("No routing entry for task 'question.answer'");
  });

  test('returned AgentProfile has correct model from ProfileConfig', () => {
    const policy = new DefaultAgentRoutingPolicy(makeAiConfig());
    const profile = policy.resolve({ task: 'intent.classify' });
    expect(profile.model).toBe('claude-haiku-4-5');
  });

  test('returned AgentProfile includes plugins when ProfileConfig has plugins', () => {
    const pluginPath = { type: 'local' as const, path: '/plugins/mm' };
    const config = makeAiConfig();
    config.profiles[1].plugins = [pluginPath];
    const policy = new DefaultAgentRoutingPolicy(config);
    expect(policy.resolve({ task: 'artifact.create' })).toMatchObject({
      plugins: [pluginPath],
    });
  });

  test('returned AgentProfile includes route-derived required skills', () => {
    const policy = new DefaultAgentRoutingPolicy(makeAiConfig());

    expect(policy.resolve({ task: 'artifact.create', intent: 'idea' })).toMatchObject({
      required_skills: ['mm:planning'],
    });
    expect(policy.resolve({ task: 'artifact.create', intent: 'bug' })).toMatchObject({
      required_skills: ['mm:issue-triage'],
    });
    expect(policy.resolve({ task: 'implementation.run' })).toMatchObject({
      required_skills: ['superpowers:subagent-driven-development'],
    });
    expect(policy.resolve({ task: 'question.answer' })).toMatchObject({
      required_skills: [],
    });
  });

  test('passes credential and endpoint base_url through to AgentProfile', () => {
    const config = makeAiConfig({
      credentials: [{ name: 'my-key', type: 'api_key', value: 'sk-test' }],
      endpoints: [{ name: 'ep', protocol: 'anthropic', credential: 'my-key', base_url: 'https://custom.endpoint/v1' }],
    });
    // Simulate resolved credentials (as runtime-composition would provide)
    (config.credentials as unknown as Array<{ name: string; type: string; resolvedValue: string }>)[0].resolvedValue = 'sk-resolved';
    const policy = new DefaultAgentRoutingPolicy(config);
    const profile = policy.resolve({ task: 'intent.classify' });
    expect(profile.api_key).toBe('sk-resolved');
    expect(profile.base_url).toBe('https://custom.endpoint/v1');
  });

  test('passes endpoint beta header filter config through to AgentProfile', () => {
    const config = makeAiConfig({
      endpoints: [
        {
          name: 'ep',
          protocol: 'anthropic',
          credential: 'my-key',
          base_url: 'https://custom.endpoint',
          anthropic_beta_header_filter: {
            strip: ['advisor-tool-2026-03-01', 'context-management-2025-06-27'],
          },
        },
      ],
    });
    const policy = new DefaultAgentRoutingPolicy(config);
    const profile = policy.resolve({ task: 'implementation.run' });

    expect(profile.anthropic_beta_header_filter).toEqual({
      strip: ['advisor-tool-2026-03-01', 'context-management-2025-06-27'],
    });
  });

  test('omits beta header filter config when endpoint strip list is empty', () => {
    const config = makeAiConfig({
      endpoints: [
        {
          name: 'ep',
          protocol: 'anthropic',
          credential: 'my-key',
          anthropic_beta_header_filter: { strip: [] },
        },
      ],
    });
    const policy = new DefaultAgentRoutingPolicy(config);
    const profile = policy.resolve({ task: 'implementation.run' });

    expect(profile.anthropic_beta_header_filter).toBeUndefined();
  });

  test('api_key is undefined when credential has no resolvedValue', () => {
    const policy = new DefaultAgentRoutingPolicy(makeAiConfig());
    const profile = policy.resolve({ task: 'intent.classify' });
    expect(profile.api_key).toBeUndefined();
  });

  test('base_url is undefined when endpoint has no base_url', () => {
    const config = makeAiConfig({
      endpoints: [{ name: 'ep', protocol: 'anthropic', credential: 'my-key' }],
    });
    const policy = new DefaultAgentRoutingPolicy(config);
    const profile = policy.resolve({ task: 'intent.classify' });
    expect(profile.base_url).toBeUndefined();
  });

  test('resolveOptional returns null when route task is not in routing config', () => {
    const config = makeAiConfig();
    delete config.routing['question.answer'];
    const policy = new DefaultAgentRoutingPolicy(config);
    expect(policy.resolveOptional({ task: 'question.answer' })).toBeNull();
  });

  test('resolveOptional returns profile when route is configured', () => {
    const policy = new DefaultAgentRoutingPolicy(makeAiConfig());
    const profile = policy.resolveOptional({ task: 'implementation.run' });
    expect(profile).toMatchObject({ id: 'agent-default', provider: 'claude_agent_sdk' });
  });

  test('resolveOptional returns null for implementation.review.initial when not configured', () => {
    const policy = new DefaultAgentRoutingPolicy(makeAiConfig());
    expect(policy.resolveOptional({ task: 'implementation.review.initial' })).toBeNull();
  });

  test('resolveOptional resolves implementation.review.initial when configured', () => {
    const config = makeAiConfig();
    config.routing['implementation.review.initial'] = 'agent-default';
    const policy = new DefaultAgentRoutingPolicy(config);
    expect(policy.resolveOptional({ task: 'implementation.review.initial' })).toMatchObject({
      id: 'agent-default',
      provider: 'claude_agent_sdk',
    });
  });

  test('resolveOptional resolves implementation.review.final when configured', () => {
    const config = makeAiConfig();
    config.routing['implementation.review.final'] = 'direct-default';
    const policy = new DefaultAgentRoutingPolicy(config);
    expect(policy.resolveOptional({ task: 'implementation.review.final' })).toMatchObject({
      id: 'direct-default',
      provider: 'anthropic',
    });
  });

  test('role-keyed routing takes precedence over task-level routing', () => {
    const config = makeAiConfig();
    config.profiles.push({
      name: 'critic-agent',
      endpoint: 'ep',
      model: 'gpt-5.5',
      runner: 'openai_agent_sdk',
    });
    config.routing['implementation.review.initial'] = 'agent-default';
    config.routing['implementation.review.initial:critic'] = 'critic-agent';
    const policy = new DefaultAgentRoutingPolicy(config);

    expect(policy.resolve({ task: 'implementation.review.initial', role: 'critic' })).toMatchObject({
      id: 'critic-agent',
      provider: 'openai_agent_sdk',
    });
  });

  test('role-keyed routing falls back to task-level routing', () => {
    const config = makeAiConfig();
    config.routing['implementation.review.initial'] = 'agent-default';
    const policy = new DefaultAgentRoutingPolicy(config);

    expect(policy.resolve({ task: 'implementation.review.initial', role: 'critic' })).toMatchObject({
      id: 'agent-default',
      provider: 'claude_agent_sdk',
    });
  });

  test('resolve throws only after role-specific and task-level routing are both missing', () => {
    const policy = new DefaultAgentRoutingPolicy(makeAiConfig());

    expect(() => policy.resolve({ task: 'implementation.review.initial', role: 'critic' })).toThrow(
      "No routing entry for task 'implementation.review.initial' or role key 'implementation.review.initial:critic'",
    );
  });

  test('resolveOptional returns null only after role-specific and task-level routing are both missing', () => {
    const policy = new DefaultAgentRoutingPolicy(makeAiConfig());

    expect(policy.resolveOptional({ task: 'implementation.review.initial', role: 'critic' })).toBeNull();
  });
});

describe('agentProfileSummary', () => {
  test('maps AgentProfile to AgentProfileSummary', () => {
    const profile = { id: 'my-profile', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-6' };
    expect(agentProfileSummary(profile)).toEqual({
      profile: 'my-profile',
      provider: 'claude_agent_sdk',
      model: 'claude-sonnet-4-6',
    });
  });

  test('omits model when undefined', () => {
    const profile = { id: 'my-profile', provider: 'anthropic' };
    const summary = agentProfileSummary(profile);
    expect(summary.model).toBeUndefined();
  });
});
