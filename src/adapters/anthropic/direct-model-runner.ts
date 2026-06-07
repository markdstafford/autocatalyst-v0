import Anthropic from '@anthropic-ai/sdk';
import type pino from 'pino';
import type { LoggerProvider } from '@opentelemetry/api-logs';
import { performance } from 'node:perf_hooks';
import { createLogger } from '../../core/logger.js';
import type { DirectModelRunRequest, DirectModelRunResult, DirectModelRunner } from '../../types/ai.js';
import type { NormalizedTokenUsage } from '../../types/journal.js';

export type AnthropicCreateFn = (params: {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'user'; content: string }>;
}) => Promise<{
  content: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}>;

export interface AnthropicDirectModelRunnerOptions {
  createFn?: AnthropicCreateFn;
  defaultModel?: string;
  logDestination?: pino.DestinationStream;
  loggerProvider?: LoggerProvider;
}

export class AnthropicDirectModelRunner implements DirectModelRunner {
  private readonly createFn: AnthropicCreateFn;
  private readonly defaultModel?: string;
  private readonly logger: pino.Logger;

  constructor(apiKey: string, options?: AnthropicDirectModelRunnerOptions) {
    if (options?.createFn) {
      this.createFn = options.createFn;
    } else {
      const client = new Anthropic({ apiKey });
      this.createFn = params => client.messages.create(params) as Promise<{ content: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }>;
    }
    this.defaultModel = options?.defaultModel;
    this.logger = createLogger('anthropic-direct-model-runner', {
      destination: options?.logDestination,
      loggerProvider: options?.loggerProvider,
    });
  }

  async run(request: DirectModelRunRequest): Promise<DirectModelRunResult> {
    const model = request.model ?? request.profile?.model ?? this.defaultModel;
    if (!model) {
      throw new Error(`Direct model route ${request.route.task} requires a model`);
    }

    const startMs = performance.now();
    try {
      const raw = await this.createFn({
        model,
        max_tokens: request.max_tokens ?? 1024,
        messages: request.messages,
      });
      const latency_ms = Math.round(performance.now() - startMs);
      this.logger.info(
        {
          event: 'model.run',
          model,
          task: request.route.task,
          input_tokens: raw.usage?.input_tokens ?? null,
          output_tokens: raw.usage?.output_tokens ?? null,
          latency_ms,
        },
        'Model run completed',
      );
      const normalizedUsage: NormalizedTokenUsage | null = raw.usage
        ? {
            input: raw.usage.input_tokens ?? 0,
            output: raw.usage.output_tokens ?? 0,
            cache_read: raw.usage.cache_read_input_tokens ?? 0,
            cache_write: raw.usage.cache_creation_input_tokens ?? 0,
          }
        : null;
      return {
        text: raw.content.find(block => block.type === 'text')?.text ?? '',
        raw,
        usage: normalizedUsage,
        runner: 'anthropic_direct',
      };
    } catch (err) {
      this.logger.error(
        {
          event: 'model.run_failed',
          model,
          task: request.route.task,
          error: String(err),
        },
        'Model run failed',
      );
      throw err;
    }
  }
}
