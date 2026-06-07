import type pino from 'pino';
import { createLogger } from '../logger.js';
import { createBuiltInIntentRegistry } from '../extensions/built-ins.js';
import type { IntentRegistry } from '../intent-registry.js';
import type {
  AgentRoutingPolicy,
  ClassificationContext,
  DirectModelRunner,
  Intent,
  IntentClassifier,
  IntentClassifyResultListener,
} from '../../types/ai.js';

export interface ModelIntentClassifierOptions {
  intentRegistry?: IntentRegistry;
  routingPolicy?: AgentRoutingPolicy;
  logDestination?: pino.DestinationStream;
  model?: string;
  max_tokens?: number;
}

export class IntentClassificationUnavailableError extends Error {
  constructor(
    readonly context: ClassificationContext,
    readonly cause: unknown,
  ) {
    super(`Intent classification unavailable for context ${context}`);
    this.name = 'IntentClassificationUnavailableError';
  }
}

export class ModelIntentClassifier implements IntentClassifier {
  private readonly logger: pino.Logger;
  private readonly intentRegistry: IntentRegistry;

  constructor(
    private readonly runner: DirectModelRunner,
    private readonly options: ModelIntentClassifierOptions = {},
  ) {
    this.logger = createLogger('intent-classifier', { destination: options.logDestination });
    this.intentRegistry = options.intentRegistry ?? createBuiltInIntentRegistry();
  }

  async classify(
    message: string,
    context: ClassificationContext,
    onResult?: IntentClassifyResultListener,
  ): Promise<Intent> {
    const fallback = this.intentRegistry.fallbackForContext(context) ?? 'feedback';
    if (!message.trim()) return fallback;

    const knownIntents = this.intentRegistry.list().map(definition => definition.name);
    const validIntents = this.intentRegistry.validIntentsForContext(context);
    const promptIntents = validIntents.length > 0 ? validIntents : knownIntents;
    const route = { task: 'intent.classify' as const, stage: context };
    const profile = this.options.routingPolicy?.resolve(route) ?? null;
    const prompt = buildPrompt(message, context, promptIntents, this.intentRegistry);

    let attempt = 0;
    let lastError: unknown;
    let sawModelResponse = false;
    while (attempt < 2) {
      try {
        const response = await this.runner.run({
          route,
          profile: profile ?? undefined,
          model: this.options.model,
          max_tokens: this.options.max_tokens ?? 20,
          messages: [{ role: 'user', content: prompt }],
        });
        sawModelResponse = true;
        onResult?.({ usage: response.usage ?? null, profile });
        const intent = parseIntentFromResponse(response.text, knownIntents);
        if (intent && promptIntents.includes(intent)) {
          this.logger.info(
            { event: 'intent.classified', context, classified_intent: intent, message_length: message.length },
            'Intent classified',
          );
          return intent;
        }
        if (intent && !promptIntents.includes(intent)) {
          this.logger.warn(
            { event: 'intent.invalid_for_context', returned_intent: intent, context, valid_intents: promptIntents },
            'Model returned intent not valid for context',
          );
        }
      } catch (err) {
        lastError = err;
        this.logger.warn(
          { event: 'intent.classification_failed', context, error: String(err) },
          'Intent classification API call failed',
        );
      }
      attempt += 1;
    }

    if (!sawModelResponse && lastError !== undefined) {
      throw new IntentClassificationUnavailableError(context, lastError);
    }

    this.logger.warn(
      { event: 'intent.classified_fallback', context, classified_intent: fallback, message_length: message.length },
      'Falling back to conservative default intent',
    );
    return fallback;
  }
}

function buildPrompt(
  message: string,
  context: ClassificationContext,
  promptIntents: Intent[],
  intentRegistry: IntentRegistry,
): string {
  return [
    `Classify the following channel message into one of these intents, given the current context.`,
    ``,
    `Current context: ${context}`,
    ``,
    `Valid intents for this context:`,
    ...promptIntents.map(i => `- ${i}: ${intentRegistry.get(i)?.description ?? 'no description available'}`),
    ``,
    `Message:`,
    message,
    ``,
    `Respond with only the intent name, nothing else.`,
  ].join('\n');
}

export function parseIntentFromResponse(text: string, knownIntents: Intent[]): Intent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('"') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        return knownIntents.includes(parsed as Intent) ? (parsed as Intent) : null;
      }
    } catch {
      // fall through
    }
  }

  const firstToken = trimmed.split(/[\s-]/)[0].trim();
  return knownIntents.includes(firstToken as Intent) ? (firstToken as Intent) : null;
}
