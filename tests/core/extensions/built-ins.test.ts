import { describe, expect, it } from 'vitest';
import { IntentRegistryImpl } from '../../../src/core/intent-registry.js';
import { createBuiltInExtensionRegistry } from '../../../src/adapters/built-in-extensions.js';
import { registerBuiltInIntents, BUILT_IN_CLASSIFICATION_CONTEXTS } from '../../../src/core/extensions/built-ins.js';

describe('registerBuiltInIntents', () => {
  it('registers current production intents with their valid contexts', () => {
    const registry = new IntentRegistryImpl();
    registerBuiltInIntents(registry);

    expect(registry.validIntentsForContext('new_thread')).toEqual([
      'idea',
      'bug',
      'chore',
      'file_issues',
      'work_on_issue',
      'question',
      'ignore',
    ]);
    expect(registry.validIntentsForContext('reviewing_spec')).toEqual([
      'feedback',
      'approval',
      'question',
      'ignore',
    ]);
    expect(registry.validIntentsForContext('planning')).toEqual([
      'ignore',
    ]);
    expect(registry.validIntentsForContext('awaiting_planning_input')).toEqual([
      'feedback',
      'question',
      'ignore',
    ]);
  });

  it('registers existing_issue context with idea, bug, chore, question, ignore — not file_issues or work_on_issue', () => {
    const registry = new IntentRegistryImpl();
    registerBuiltInIntents(registry);

    const existingIssueIntents = registry.validIntentsForContext('existing_issue');
    expect(existingIssueIntents).toContain('idea');
    expect(existingIssueIntents).toContain('bug');
    expect(existingIssueIntents).toContain('chore');
    expect(existingIssueIntents).toContain('question');
    expect(existingIssueIntents).toContain('ignore');
    expect(existingIssueIntents).not.toContain('file_issues');
    expect(existingIssueIntents).not.toContain('work_on_issue');
  });

  it('fallback for existing_issue is idea, not file_issues', () => {
    const registry = new IntentRegistryImpl();
    registerBuiltInIntents(registry);

    expect(registry.fallbackForContext('existing_issue')).toBe('idea');
  });

  it('work_on_issue description distinguishes action from inquiry and states precedence over bug/chore/idea', () => {
    const registry = new IntentRegistryImpl();
    registerBuiltInIntents(registry);

    const def = registry.get('work_on_issue');
    expect(def).toBeDefined();
    expect(def!.description).toContain('work_on_issue takes precedence over bug, chore, and idea');
    expect(def!.description.toLowerCase()).toContain('question');
  });

  it('file_issues description excludes existing issue references', () => {
    const registry = new IntentRegistryImpl();
    registerBuiltInIntents(registry);

    const def = registry.get('file_issues');
    expect(def).toBeDefined();
    expect(def!.description).toMatch(/existing issue|issue \d+|#\d+/i);
  });

  it('existing_issue is in BUILT_IN_CLASSIFICATION_CONTEXTS', () => {
    expect(BUILT_IN_CLASSIFICATION_CONTEXTS).toContain('existing_issue');
  });
});

describe('createBuiltInExtensionRegistry', () => {
  it('declares the static built-in extension providers used by runtime composition', () => {
    const registry = createBuiltInExtensionRegistry();

    expect(registry.providersFor('channel')).toEqual(['slack']);
    expect(registry.providersFor('publisher')).toEqual(['notion', 'slack_canvas']);
    expect(registry.has('issue_tracker', 'github')).toBe(true);
    expect(registry.has('agent_runtime', 'claude_agent_sdk')).toBe(true);
    expect(registry.has('intent_classifier', 'anthropic')).toBe(true);
    expect(registry.has('intent_set', 'default')).toBe(true);
    expect(registry.has('command_set', 'default')).toBe(true);
  });
});
