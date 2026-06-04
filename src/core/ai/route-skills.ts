import type { AgentRoute, AgentSkillRef } from '../../types/ai.js';

export function requiredSkillsForRoute(route: AgentRoute): AgentSkillRef[] {
  switch (route.task) {
    case 'artifact.create':
      if (route.intent === 'idea') return ['mm:planning'];
      if (route.intent === 'bug' || route.intent === 'chore') return ['mm:issue-triage'];
      return [];
    case 'issue.triage':
      return ['mm:issue-triage'];
    case 'implementation.plan':
      return ['superpowers:writing-plans'];
    case 'implementation.run':
      return ['superpowers:subagent-driven-development'];
    case 'spec.review':
      return ['mm:planning'];
    case 'artifact.revise':
    case 'intent.classify':
    case 'pr.title_generate':
    case 'question.answer':
    case 'implementation.review.initial':
    case 'implementation.review.final':
      return [];
  }
}
