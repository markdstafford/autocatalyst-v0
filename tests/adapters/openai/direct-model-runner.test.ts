// tests/adapters/openai/direct-model-runner.test.ts
import { PassThrough } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { OpenAIDirectModelRunner } from '../../../src/adapters/openai/direct-model-runner.js';

function makeResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

/** Collect pino log lines written to a PassThrough stream into parsed objects. */
function makeLogCapture(): { dest: import('pino').DestinationStream; getLogs: () => Record<string, unknown>[] } {
  const stream = new PassThrough();
  const logs: Record<string, unknown>[] = [];
  stream.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        try { logs.push(JSON.parse(trimmed)); } catch { /* skip non-JSON */ }
      }
    }
  });
  return { dest: stream as unknown as import('pino').DestinationStream, getLogs: () => logs };
}

describe('OpenAIDirectModelRunner', () => {
  test('run() sends messages verbatim to createFn and returns text from choices[0].message.content', async () => {
    const createFn = vi.fn().mockResolvedValue(makeResponse('question'));
    const runner = new OpenAIDirectModelRunner('test-key', undefined, { createFn });

    const result = await runner.run({
      route: { task: 'intent.classify', stage: 'new_thread' },
      profile: { id: 'gpt', provider: 'openai', model: 'gpt-4o-mini', effort: 'low' },
      max_tokens: 20,
      messages: [{ role: 'user', content: 'classify this' }],
    });

    expect(result).toEqual({ text: 'question', raw: makeResponse('question'), usage: null, runner: 'openai_direct' });
    expect(createFn).toHaveBeenCalledWith({
      model: 'gpt-4o-mini',
      max_completion_tokens: 20,
      messages: [{ role: 'user', content: 'classify this' }],
    });
  });

  test('run() uses profile.model when request.model is absent', async () => {
    const createFn = vi.fn().mockResolvedValue(makeResponse('ok'));
    const runner = new OpenAIDirectModelRunner('key', undefined, { createFn });

    await runner.run({
      route: { task: 'pr.title_generate' },
      profile: { id: 'gpt', provider: 'openai', model: 'gpt-4o', effort: 'low' },
      messages: [{ role: 'user', content: 'title' }],
    });

    expect(createFn).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4o' }));
  });

  test('run() uses defaultModel when neither request.model nor profile.model is set', async () => {
    const createFn = vi.fn().mockResolvedValue(makeResponse('ok'));
    const runner = new OpenAIDirectModelRunner('key', undefined, { createFn, defaultModel: 'gpt-4o-mini' });

    await runner.run({
      route: { task: 'intent.classify' },
      messages: [{ role: 'user', content: 'classify' }],
    });

    expect(createFn).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4o-mini' }));
  });

  test('run() throws a descriptive error when no model can be resolved', async () => {
    const createFn = vi.fn();
    const runner = new OpenAIDirectModelRunner('key', undefined, { createFn });

    await expect(
      runner.run({
        route: { task: 'intent.classify' },
        messages: [{ role: 'user', content: 'classify' }],
      }),
    ).rejects.toThrow('Direct model route intent.classify requires a model');

    expect(createFn).not.toHaveBeenCalled();
  });

  test('run() defaults max_tokens to 1024 when not specified', async () => {
    const createFn = vi.fn().mockResolvedValue(makeResponse('ok'));
    const runner = new OpenAIDirectModelRunner('key', undefined, { createFn, defaultModel: 'gpt-4o-mini' });

    await runner.run({
      route: { task: 'intent.classify' },
      messages: [{ role: 'user', content: 'classify' }],
    });

    expect(createFn).toHaveBeenCalledWith(expect.objectContaining({ max_completion_tokens: 1024 }));
  });

  test('runner with baseUrl uses the provided createFn and returns correct result', async () => {
    // Note: this test uses the createFn injection path. The defaultHeaders: { 'api-key': apiKey }
    // behavior (for Azure APIM / Grove gateway compatibility) is applied in the real-client
    // branch (when no createFn is provided) and is verified by integration/manual testing only.
    const createFn = vi.fn().mockResolvedValue(makeResponse('grove-response'));
    const runner = new OpenAIDirectModelRunner('grove-key', 'https://grove.internal/openai', { createFn });

    const result = await runner.run({
      route: { task: 'intent.classify' },
      messages: [{ role: 'user', content: 'classify' }],
      model: 'gpt-4o-mini',
    });

    expect(result.text).toBe('grove-response');
    expect(createFn).toHaveBeenCalledWith({
      model: 'gpt-4o-mini',
      max_completion_tokens: 1024,
      messages: [{ role: 'user', content: 'classify' }],
    });
  });

  test('returns normalized usage when provider returns usage data', async () => {
    const createFn = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'answer' } }],
      usage: { prompt_tokens: 8, completion_tokens: 3 },
    });
    const runner = new OpenAIDirectModelRunner('test-key', undefined, { createFn });

    const result = await runner.run({
      route: { task: 'intent.classify', stage: 'new_thread' },
      profile: { id: 'gpt', provider: 'openai', model: 'gpt-4o-mini', effort: 'low' },
      messages: [{ role: 'user', content: 'classify this' }],
    });

    expect(result.usage).toEqual({ input: 8, output: 3, cache_read: 0, cache_write: 0 });
    expect(result.runner).toBe('openai_direct');
  });

  test('returns usage: null when provider returns no usage', async () => {
    const createFn = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'answer' } }],
    });
    const runner = new OpenAIDirectModelRunner('test-key', undefined, { createFn });

    const result = await runner.run({
      route: { task: 'intent.classify', stage: 'new_thread' },
      profile: { id: 'gpt', provider: 'openai', model: 'gpt-4o-mini', effort: 'low' },
      messages: [{ role: 'user', content: 'classify this' }],
    });

    expect(result.usage).toBeNull();
    expect(result.runner).toBe('openai_direct');
  });

  test('maps cached_tokens from prompt_tokens_details to cache_read', async () => {
    const createFn = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'answer' } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 60 },
      },
    });
    const runner = new OpenAIDirectModelRunner('test-key', undefined, { createFn });

    const result = await runner.run({
      route: { task: 'intent.classify', stage: 'new_thread' },
      profile: { id: 'gpt', provider: 'openai', model: 'gpt-4o-mini', effort: 'low' },
      messages: [{ role: 'user', content: 'classify this' }],
    });

    expect(result.usage).toEqual({ input: 100, output: 50, cache_read: 60, cache_write: 0 });
  });

  test('emits model.run log event with all fields on success', async () => {
    const createFn = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'answer' } }],
      usage: { prompt_tokens: 8, completion_tokens: 3 },
    });
    const { dest, getLogs } = makeLogCapture();

    const runner = new OpenAIDirectModelRunner('test-key', undefined, { createFn, logDestination: dest });
    await runner.run({
      route: { task: 'intent.classify', stage: 'new_thread' },
      profile: { id: 'gpt', provider: 'openai', model: 'gpt-4o-mini', effort: 'low' },
      messages: [{ role: 'user', content: 'classify this' }],
    });
    await new Promise(resolve => setImmediate(resolve));

    const runLog = getLogs().find(l => l['event'] === 'model.run');
    expect(runLog).toBeDefined();
    expect(runLog!['model']).toBe('gpt-4o-mini');
    expect(runLog!['task']).toBe('intent.classify');
    expect(runLog!['input_tokens']).toBe(8);
    expect(runLog!['output_tokens']).toBe(3);
    expect(typeof runLog!['latency_ms']).toBe('number');
    expect(runLog!['latency_ms'] as number).toBeGreaterThanOrEqual(0);
  });

  test('emits model.run_failed log event on error and re-throws the original error', async () => {
    const originalError = new Error('API timeout');
    const createFn = vi.fn().mockRejectedValue(originalError);
    const { dest, getLogs } = makeLogCapture();

    const runner = new OpenAIDirectModelRunner('test-key', undefined, { createFn, logDestination: dest });
    await expect(runner.run({
      route: { task: 'intent.classify', stage: 'new_thread' },
      profile: { id: 'gpt', provider: 'openai', model: 'gpt-4o-mini', effort: 'low' },
      messages: [{ role: 'user', content: 'classify this' }],
    })).rejects.toThrow('API timeout');
    await new Promise(resolve => setImmediate(resolve));

    const failLog = getLogs().find(l => l['event'] === 'model.run_failed');
    expect(failLog).toBeDefined();
    expect(failLog!['model']).toBe('gpt-4o-mini');
    expect(failLog!['task']).toBe('intent.classify');
    expect(typeof failLog!['error']).toBe('string');
    expect(failLog!['error'] as string).toContain('API timeout');
  });

  test('logs null for input_tokens and output_tokens when usage is absent', async () => {
    const createFn = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'answer' } }],
    });
    const { dest, getLogs } = makeLogCapture();

    const runner = new OpenAIDirectModelRunner('test-key', undefined, { createFn, logDestination: dest });
    await runner.run({
      route: { task: 'intent.classify', stage: 'new_thread' },
      profile: { id: 'gpt', provider: 'openai', model: 'gpt-4o-mini', effort: 'low' },
      messages: [{ role: 'user', content: 'classify this' }],
    });
    await new Promise(resolve => setImmediate(resolve));

    const runLog = getLogs().find(l => l['event'] === 'model.run');
    expect(runLog).toBeDefined();
    expect(runLog!['input_tokens']).toBeNull();
    expect(runLog!['output_tokens']).toBeNull();
  });
});
