import { describe, expect, test } from 'vitest';
import { IntentRegistryImpl } from '../../../src/core/intent-registry.js';
import { IntentClassificationUnavailableError, ModelIntentClassifier } from '../../../src/core/ai/model-intent-classifier.js';
import type { DirectModelRunner, DirectModelRunRequest } from '../../../src/types/ai.js';
import { registerBuiltInIntents } from '../../../src/core/extensions/built-ins.js';

describe('ModelIntentClassifier', () => {
  test('classifies through a DirectModelRunner and uses registered intent context', async () => {
    const requests: DirectModelRunRequest[] = [];
    const runner: DirectModelRunner = {
      async run(request) {
        requests.push(request);
        return { text: 'question' };
      },
    };
    const registry = new IntentRegistryImpl();
    registry.register({
      name: 'question',
      description: 'A question about the repository or workflow',
      valid_contexts: ['new_thread'],
    });
    registry.register({
      name: 'idea',
      description: 'A request for new product work',
      valid_contexts: ['new_thread'],
      fallback_contexts: ['new_thread'],
    });

    const classifier = new ModelIntentClassifier(runner, { intentRegistry: registry });

    await expect(classifier.classify('How many open issues are there?', 'new_thread')).resolves.toBe('question');
    expect(requests).toHaveLength(1);
    expect(requests[0].route).toEqual({
      task: 'intent.classify',
      stage: 'new_thread',
    });
    expect(requests[0].messages[0].content).toContain('channel message');
    expect(requests[0].messages[0].content).not.toContain('Slack message');
  });

  test('emits the direct-call token usage and resolved profile via onResult', async () => {
    const usage = { input: 200, output: 5, cache_read: 0, cache_write: 0 };
    const resolvedProfile = { id: 'intent', provider: 'anthropic_direct', model: 'claude-haiku-4-5' };
    const runner: DirectModelRunner = {
      async run() {
        return { text: 'question', usage };
      },
    };
    const registry = new IntentRegistryImpl();
    registry.register({ name: 'question', description: 'A question', valid_contexts: ['new_thread'] });
    registry.register({ name: 'idea', description: 'An idea', valid_contexts: ['new_thread'], fallback_contexts: ['new_thread'] });

    const routingPolicy = {
      resolve: () => resolvedProfile as never,
      resolveOptional: () => resolvedProfile as never,
    };
    const classifier = new ModelIntentClassifier(runner, { intentRegistry: registry, routingPolicy });

    const seen: Array<{ usage?: unknown; profile?: unknown }> = [];
    const intent = await classifier.classify('How many open issues?', 'new_thread', (r) => { seen.push(r); });

    expect(intent).toBe('question');
    expect(seen).toHaveLength(1);
    expect(seen[0].usage).toEqual(usage);
    expect(seen[0].profile).toEqual(resolvedProfile);
  });

  test('emits null usage via onResult when the runner provides none', async () => {
    const runner: DirectModelRunner = {
      async run() {
        return { text: 'idea' };
      },
    };
    const registry = new IntentRegistryImpl();
    registry.register({ name: 'idea', description: 'An idea', valid_contexts: ['new_thread'], fallback_contexts: ['new_thread'] });

    const classifier = new ModelIntentClassifier(runner, { intentRegistry: registry });

    const seen: Array<{ usage?: unknown }> = [];
    await classifier.classify('Build a thing', 'new_thread', (r) => { seen.push(r); });

    expect(seen).toHaveLength(1);
    expect(seen[0].usage).toBeNull();
  });

  test('throws a classification unavailable error when direct model calls fail', async () => {
    const runner: DirectModelRunner = {
      async run() {
        throw new Error('credentials expired');
      },
    };
    const registry = new IntentRegistryImpl();
    registry.register({
      name: 'idea',
      description: 'A request for new product work',
      valid_contexts: ['new_thread'],
      fallback_contexts: ['new_thread'],
    });

    const classifier = new ModelIntentClassifier(runner, { intentRegistry: registry });

    await expect(classifier.classify('How many open issues are there?', 'new_thread'))
      .rejects.toBeInstanceOf(IntentClassificationUnavailableError);
  });
});

describe('ModelIntentClassifier — existing_issue context', () => {
  test('valid intents for existing_issue exclude file_issues and work_on_issue', () => {
    const registry = new IntentRegistryImpl();
    registerBuiltInIntents(registry);

    const validIntents = registry.validIntentsForContext('existing_issue');
    expect(validIntents).toContain('idea');
    expect(validIntents).toContain('bug');
    expect(validIntents).toContain('chore');
    expect(validIntents).toContain('question');
    expect(validIntents).toContain('ignore');
    expect(validIntents).not.toContain('file_issues');
    expect(validIntents).not.toContain('work_on_issue');
  });

  test('classifier prompt for existing_issue context lists valid intents without file_issues', async () => {
    const requests: DirectModelRunRequest[] = [];
    const runner: DirectModelRunner = {
      async run(request) {
        requests.push(request);
        return { text: 'bug' };
      },
    };
    const registry = new IntentRegistryImpl();
    registerBuiltInIntents(registry);

    const classifier = new ModelIntentClassifier(runner, { intentRegistry: registry });

    await classifier.classify('User request: work on issue 42\n\nReferenced issue:\n...', 'existing_issue');

    expect(requests).toHaveLength(1);
    const prompt = requests[0].messages[0].content as string;
    expect(prompt).toContain('existing_issue');
    expect(prompt).toContain('bug');
    expect(prompt).toContain('idea');
    expect(prompt).not.toContain('file_issues');
    expect(prompt).not.toContain('work_on_issue');
  });
});
