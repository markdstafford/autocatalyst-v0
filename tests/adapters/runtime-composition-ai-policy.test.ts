import { describe, expect, test } from 'vitest';
import { buildAgentRoutingPolicy } from '../../src/adapters/runtime-composition.js';
import type { AiConfig } from '../../src/types/config.js';
import type { ResolvedAiConfig } from '../../src/core/config.js';

function buildTestAiConfig(): ResolvedAiConfig {
  const config: AiConfig = {
    credentials: [{ name: 'key', type: 'api_key', value: 'sk-test' }],
    endpoints: [{ name: 'ep', protocol: 'anthropic', credential: 'key' }],
    profiles: [
      {
        name: 'classify-haiku',
        endpoint: 'ep',
        model: 'claude-haiku-4-5-20251001',
        runner: 'anthropic_direct',
        anthropic: { effort: 'low' },
      },
      {
        name: 'artifact-authoring',
        endpoint: 'ep',
        model: 'claude-sonnet-4-6',
        runner: 'claude_agent_sdk',
        anthropic: { effort: 'high', thinking: 'adaptive' },
      },
      {
        name: 'implementation',
        endpoint: 'ep',
        model: 'claude-sonnet-4-6',
        runner: 'claude_agent_sdk',
        anthropic: { effort: 'medium', thinking: 'adaptive' },
      },
      {
        name: 'repo-question',
        endpoint: 'ep',
        model: 'claude-sonnet-4-6',
        runner: 'claude_agent_sdk',
        anthropic: { effort: 'low', thinking: 'adaptive' },
      },
      {
        name: 'issue-triage',
        endpoint: 'ep',
        model: 'claude-sonnet-4-6',
        runner: 'claude_agent_sdk',
        anthropic: { effort: 'high', thinking: 'adaptive' },
      },
    ],
    routing: {
      'intent.classify': 'classify-haiku',
      'pr.title_generate': 'classify-haiku',
      'artifact.create': 'artifact-authoring',
      'artifact.revise': 'artifact-authoring',
      'implementation.run': 'implementation',
      'question.answer': 'repo-question',
      'issue.triage': 'issue-triage',
    },
  };
  // Cast credentials to ResolvedCredential[] shape for ResolvedAiConfig
  return config as unknown as ResolvedAiConfig;
}

describe('runtime AI routing policy', () => {
  test('question answering uses low effort agent profile', () => {
    const policy = buildAgentRoutingPolicy(buildTestAiConfig());
    expect(policy.resolve({ task: 'question.answer' })).toMatchObject({
      id: 'repo-question',
      provider: 'claude_agent_sdk',
      effort: 'low',
      thinking: 'adaptive',
    });
  });

  test('artifact creation requires mm planning skill without configured plugins', () => {
    const policy = buildAgentRoutingPolicy(buildTestAiConfig());
    expect(policy.resolve({ task: 'artifact.create', intent: 'idea' })).toMatchObject({
      id: 'artifact-authoring',
      provider: 'claude_agent_sdk',
      required_skills: ['mm:planning'],
      plugins: undefined,
    });
  });

  test('implementation requires superpowers skills without configured plugins', () => {
    const policy = buildAgentRoutingPolicy(buildTestAiConfig());
    expect(policy.resolve({ task: 'implementation.run' })).toMatchObject({
      id: 'implementation',
      provider: 'claude_agent_sdk',
      required_skills: ['superpowers:subagent-driven-development'],
      plugins: undefined,
    });
  });

  test('issue triage requires mm issue triage skill without configured plugins', () => {
    const policy = buildAgentRoutingPolicy(buildTestAiConfig());
    expect(policy.resolve({ task: 'issue.triage' })).toMatchObject({
      id: 'issue-triage',
      provider: 'claude_agent_sdk',
      required_skills: ['mm:issue-triage'],
      plugins: undefined,
    });
  });
});
