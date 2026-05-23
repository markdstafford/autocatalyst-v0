import { describe, expect, test } from 'vitest';
import { requiredSkillsForRoute } from '../../../src/core/ai/route-skills.js';

describe('requiredSkillsForRoute', () => {
  test('maps artifact creation routes by intent', () => {
    expect(requiredSkillsForRoute({ task: 'artifact.create', intent: 'idea' })).toEqual(['mm:planning']);
    expect(requiredSkillsForRoute({ task: 'artifact.create', intent: 'bug' })).toEqual(['mm:issue-triage']);
    expect(requiredSkillsForRoute({ task: 'artifact.create', intent: 'chore' })).toEqual(['mm:issue-triage']);
  });

  test('maps implementation and issue triage routes to their required skills', () => {
    expect(requiredSkillsForRoute({ task: 'issue.triage' })).toEqual(['mm:issue-triage']);
    expect(requiredSkillsForRoute({ task: 'implementation.plan' })).toEqual(['superpowers:writing-plans']);
    expect(requiredSkillsForRoute({ task: 'implementation.run' })).toEqual(['superpowers:subagent-driven-development']);
  });

  test('leaves direct and non-skill routes empty', () => {
    expect(requiredSkillsForRoute({ task: 'intent.classify' })).toEqual([]);
    expect(requiredSkillsForRoute({ task: 'pr.title_generate' })).toEqual([]);
    expect(requiredSkillsForRoute({ task: 'question.answer' })).toEqual([]);
    expect(requiredSkillsForRoute({ task: 'artifact.revise', intent: 'feedback' })).toEqual([]);
  });
});
