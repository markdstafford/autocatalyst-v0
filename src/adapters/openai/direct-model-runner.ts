import OpenAI from 'openai';
import type pino from 'pino';
import type { LoggerProvider } from '@opentelemetry/api-logs';
import { performance } from 'node:perf_hooks';
import { createLogger } from '../../core/logger.js';
import type { DirectModelRunRequest, DirectModelRunResult, DirectModelRunner } from '../../types/ai.js';
import type { NormalizedTokenUsage } from '../../types/journal.js';

export type OpenAIChatCompletionFn = (params: {
  model: string;
  max_completion_tokens: number;
  messages: Array<{ role: 'user'; content: string }>;
}) => Promise<{
  choices: Array<{ message: { content: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}>;

export interface OpenAIDirectModelRunnerOptions {
  createFn?: OpenAIChatCompletionFn;
  defaultModel?: string;
  logDestination?: pino.DestinationStream;
  loggerProvider?: LoggerProvider;
}

export class OpenAIDirectModelRunner implements DirectModelRunner {
  private readonly createFn: OpenAIChatCompletionFn;
  private readonly defaultModel?: string;
  private readonly logger: pino.Logger;

  constructor(apiKey: string, baseUrl?: string, options?: OpenAIDirectModelRunnerOptions) {
    if (options?.createFn) {
      this.createFn = options.createFn;
    } else {
      const clientOptions: ConstructorParameters<typeof OpenAI>[0] = { apiKey };
      if (baseUrl) {
        // Azure APIM / Grove gateways require 'api-key' instead of 'Authorization: Bearer'.
        // Setting defaultHeaders here ensures any request to a custom base URL uses it.
        clientOptions.baseURL = baseUrl;
        clientOptions.defaultHeaders = { 'api-key': apiKey };
      }
      const client = new OpenAI(clientOptions);
      this.createFn = params =>
        client.chat.completions.create(params) as Promise<{ choices: Array<{ message: { content: string | null } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }>;
    }
    this.defaultModel = options?.defaultModel;
    this.logger = createLogger('openai-direct-model-runner', {
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
        max_completion_tokens: request.max_tokens ?? 1024,
        messages: request.messages,
      });
      const latency_ms = Math.round(performance.now() - startMs);
      this.logger.info(
        {
          event: 'model.run',
          model,
          task: request.route.task,
          input_tokens: raw.usage?.prompt_tokens ?? null,
          output_tokens: raw.usage?.completion_tokens ?? null,
          latency_ms,
        },
        'Model run completed',
      );
      const normalizedUsage: NormalizedTokenUsage | null = raw.usage
        ? {
            input: raw.usage.prompt_tokens ?? 0,
            output: raw.usage.completion_tokens ?? 0,
            cache_read: raw.usage.prompt_tokens_details?.cached_tokens ?? 0,
            cache_write: 0,
          }
        : null;
      return {
        text: raw.choices[0]?.message.content ?? '',
        raw,
        usage: normalizedUsage,
        runner: 'openai_direct',
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
