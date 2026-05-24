import type { ClassificationContext } from '../../types/intent.js';
import { IntentRegistryImpl, type IntentRegistry } from '../intent-registry.js';

export type BuiltInExtensionKind =
  | 'channel'
  | 'publisher'
  | 'issue_tracker'
  | 'agent_runtime'
  | 'intent_classifier'
  | 'intent_set'
  | 'command_set';

export interface BuiltInExtension {
  kind: BuiltInExtensionKind;
  provider: string;
  capabilities: string[];
}

export class BuiltInExtensionRegistry {
  private readonly extensions = new Map<string, BuiltInExtension>();

  register(extension: BuiltInExtension): void {
    const key = extensionKey(extension.kind, extension.provider);
    if (this.extensions.has(key)) {
      throw new Error(`Built-in extension already registered: ${key}`);
    }
    this.extensions.set(key, { ...extension, capabilities: [...extension.capabilities] });
  }

  has(kind: BuiltInExtensionKind, provider: string): boolean {
    return this.extensions.has(extensionKey(kind, provider));
  }

  get(kind: BuiltInExtensionKind, provider: string): BuiltInExtension | undefined {
    const extension = this.extensions.get(extensionKey(kind, provider));
    return extension ? { ...extension, capabilities: [...extension.capabilities] } : undefined;
  }

  providersFor(kind: BuiltInExtensionKind): string[] {
    return [...this.extensions.values()]
      .filter(extension => extension.kind === kind)
      .map(extension => extension.provider);
  }

  entries(): BuiltInExtension[] {
    return [...this.extensions.values()].map(extension => ({
      ...extension,
      capabilities: [...extension.capabilities],
    }));
  }
}

function extensionKey(kind: BuiltInExtensionKind, provider: string): string {
  return `${kind}:${provider}`;
}

export const BUILT_IN_CLASSIFICATION_CONTEXTS: ClassificationContext[] = [
  'new_thread',
  'existing_issue',
  'intake',
  'reviewing_spec',
  'reviewing_implementation',
  'awaiting_planning_input',
  'awaiting_impl_input',
  'planning',
  'speccing',
  'implementing',
  'pr_open',
  'done',
  'failed',
];

export function createBuiltInIntentRegistry(): IntentRegistry {
  const registry = new IntentRegistryImpl();
  registerBuiltInIntents(registry);
  return registry;
}

export function registerBuiltInIntents(registry: IntentRegistry): void {
  registry.register({
    name: 'idea',
    description: 'the human wants to build a new feature or improvement',
    valid_contexts: ['new_thread', 'intake', 'existing_issue'],
    fallback_contexts: ['new_thread', 'intake', 'existing_issue'],
  });
  registry.register({
    name: 'bug',
    description: 'the human is reporting a bug or something broken',
    valid_contexts: ['new_thread', 'intake', 'existing_issue'],
  });
  registry.register({
    name: 'chore',
    description: 'the human is requesting maintenance work',
    valid_contexts: ['new_thread', 'intake', 'existing_issue'],
  });
  registry.register({
    name: 'file_issues',
    description:
      'the human is explicitly requesting that new issues be created or filed. ' +
      'Only use this intent when the request is to create or log new tracker issues from scratch. ' +
      'Do not use this intent when the user references an existing issue number (e.g., "issue 42" or "#42") ' +
      'with the intent to work on it — those requests should use work_on_issue instead.',
    valid_contexts: ['new_thread', 'intake'],
  });
  registry.register({
    name: 'work_on_issue',
    description:
      'The user wants the system to work on, fix, implement, or pick up an existing tracked issue. ' +
      'The message references a specific issue number and the intent is to act on it, not merely discuss or ask about it. ' +
      'Use this intent whenever the user references an existing issue number with the intent to take action — ' +
      'even if the message sounds like a bug report, feature request, or chore description. ' +
      'For example, "fix the race condition in issue #42" should return work_on_issue, not bug. ' +
      'work_on_issue takes precedence over bug, chore, and idea when an existing issue number is referenced with action intent. ' +
      'Do not use this intent for questions about what an issue contains or requests to summarise an issue.',
    valid_contexts: ['new_thread'],
  });
  registry.register({
    name: 'feedback',
    description: 'the human is providing feedback or revision requests',
    valid_contexts: ['reviewing_spec', 'awaiting_planning_input', 'reviewing_implementation', 'awaiting_impl_input', 'speccing', 'implementing'],
    fallback_contexts: ['reviewing_spec', 'awaiting_planning_input', 'reviewing_implementation', 'awaiting_impl_input', 'speccing', 'implementing'],
  });
  registry.register({
    name: 'approval',
    description: 'the human is approving the current work',
    valid_contexts: ['reviewing_spec', 'reviewing_implementation', 'pr_open'],
  });
  registry.register({
    name: 'question',
    description: 'the human is asking a question',
    valid_contexts: ['new_thread', 'intake', 'existing_issue', 'reviewing_spec', 'awaiting_planning_input', 'reviewing_implementation', 'awaiting_impl_input', 'pr_open'],
  });
  registry.register({
    name: 'ignore',
    description: 'the message is not actionable',
    valid_contexts: ['new_thread', 'intake', 'existing_issue', 'reviewing_spec', 'awaiting_planning_input', 'reviewing_implementation', 'awaiting_impl_input', 'speccing', 'planning', 'implementing', 'pr_open', 'done', 'failed'],
    fallback_contexts: ['pr_open', 'done', 'failed'],
  });
}
