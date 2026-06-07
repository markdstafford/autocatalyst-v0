import type { RunStage } from './runs.js';
import type { NormalizedTokenUsage } from './journal.js';
import type { AgentProfile } from './ai.js';

export type Intent =
  | 'idea'
  | 'bug'
  | 'chore'
  | 'file_issues'
  | 'work_on_issue'
  | 'question'
  | 'feedback'
  | 'approval'
  | 'ignore'
  | string;

export type ClassificationContext = 'new_thread' | 'existing_issue' | RunStage | string;

/**
 * Optional out-of-band signal emitted by a classifier when it performs a real
 * direct-model call, so callers (e.g. the orchestrator) can journal the token
 * usage and resolved profile for that call. Bare-string-returning classifiers
 * and mocks may omit it entirely; `classify` still resolves to the Intent.
 */
export interface IntentClassifyResult {
  usage?: NormalizedTokenUsage | null;
  profile?: AgentProfile | null;
}

export type IntentClassifyResultListener = (result: IntentClassifyResult) => void;

export interface IntentClassifier {
  classify(
    message: string,
    context: ClassificationContext,
    onResult?: IntentClassifyResultListener,
  ): Promise<Intent>;
}

export interface IntentDefinition {
  name: Intent;
  description: string;
  valid_contexts: ClassificationContext[];
  fallback_contexts?: ClassificationContext[];
}
