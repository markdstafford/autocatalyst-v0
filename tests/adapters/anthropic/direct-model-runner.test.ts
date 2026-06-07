import { PassThrough } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { AnthropicDirectModelRunner } from '../../../src/adapters/anthropic/direct-model-runner.js';

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

describe('AnthropicDirectModelRunner', () => {
  test('sends direct model requests without any filesystem settings dependency', async () => {
    const createFn = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'question' }],
    });
    const runner = new AnthropicDirectModelRunner('test-key', { createFn });

    await expect(runner.run({
      route: { task: 'intent.classify', stage: 'new_thread' },
      profile: { id: 'intent', provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
      max_tokens: 20,
      messages: [{ role: 'user', content: 'classify this' }],
    })).resolves.toEqual({ text: 'question', raw: { content: [{ type: 'text', text: 'question' }] }, usage: null, runner: 'anthropic_direct' });

    expect(createFn).toHaveBeenCalledWith({
      model: 'claude-haiku-4-5',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'classify this' }],
    });
  });

  test('emits model.run log event with all fields on success', async () => {
    const createFn = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'answer' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const { dest, getLogs } = makeLogCapture();

    const runner = new AnthropicDirectModelRunner('test-key', { createFn, logDestination: dest });
    await runner.run({
      route: { task: 'intent.classify', stage: 'new_thread' },
      profile: { id: 'intent', provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
      messages: [{ role: 'user', content: 'classify this' }],
    });
    // Allow any buffered writes to flush
    await new Promise(resolve => setImmediate(resolve));

    const runLog = getLogs().find(l => l['event'] === 'model.run');
    expect(runLog).toBeDefined();
    expect(runLog!['model']).toBe('claude-haiku-4-5');
    expect(runLog!['task']).toBe('intent.classify');
    expect(runLog!['input_tokens']).toBe(10);
    expect(runLog!['output_tokens']).toBe(5);
    expect(typeof runLog!['latency_ms']).toBe('number');
    expect(runLog!['latency_ms'] as number).toBeGreaterThanOrEqual(0);
  });

  test('emits model.run_failed log event on error and re-throws the original error', async () => {
    const originalError = new Error('API timeout');
    const createFn = vi.fn().mockRejectedValue(originalError);
    const { dest, getLogs } = makeLogCapture();

    const runner = new AnthropicDirectModelRunner('test-key', { createFn, logDestination: dest });
    await expect(runner.run({
      route: { task: 'intent.classify', stage: 'new_thread' },
      profile: { id: 'intent', provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
      messages: [{ role: 'user', content: 'classify this' }],
    })).rejects.toThrow('API timeout');
    await new Promise(resolve => setImmediate(resolve));

    const failLog = getLogs().find(l => l['event'] === 'model.run_failed');
    expect(failLog).toBeDefined();
    expect(failLog!['model']).toBe('claude-haiku-4-5');
    expect(failLog!['task']).toBe('intent.classify');
    expect(typeof failLog!['error']).toBe('string');
    expect(failLog!['error'] as string).toContain('API timeout');
  });

  test('returns normalized usage when provider returns usage data', async () => {
    const createFn = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'answer' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const runner = new AnthropicDirectModelRunner('test-key', { createFn });

    const result = await runner.run({
      route: { task: 'intent.classify', stage: 'new_thread' },
      profile: { id: 'intent', provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
      messages: [{ role: 'user', content: 'classify this' }],
    });

    expect(result.usage).toEqual({ input: 10, output: 5, cache_read: 0, cache_write: 0 });
    expect(result.runner).toBe('anthropic_direct');
  });

  test('returns usage: null when provider returns no usage', async () => {
    const createFn = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'answer' }],
    });
    const runner = new AnthropicDirectModelRunner('test-key', { createFn });

    const result = await runner.run({
      route: { task: 'intent.classify', stage: 'new_thread' },
      profile: { id: 'intent', provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
      messages: [{ role: 'user', content: 'classify this' }],
    });

    expect(result.usage).toBeNull();
    expect(result.runner).toBe('anthropic_direct');
  });

  test('maps cache fields correctly from Anthropic usage', async () => {
    const createFn = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'answer' }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    });
    const runner = new AnthropicDirectModelRunner('test-key', { createFn });

    const result = await runner.run({
      route: { task: 'intent.classify', stage: 'new_thread' },
      profile: { id: 'intent', provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
      messages: [{ role: 'user', content: 'classify this' }],
    });

    expect(result.usage).toEqual({ input: 100, output: 50, cache_read: 80, cache_write: 20 });
  });

  test('logs null for input_tokens and output_tokens when usage is absent', async () => {
    const createFn = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'answer' }],
    });
    const { dest, getLogs } = makeLogCapture();

    const runner = new AnthropicDirectModelRunner('test-key', { createFn, logDestination: dest });
    await runner.run({
      route: { task: 'intent.classify', stage: 'new_thread' },
      profile: { id: 'intent', provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
      messages: [{ role: 'user', content: 'classify this' }],
    });
    await new Promise(resolve => setImmediate(resolve));

    const runLog = getLogs().find(l => l['event'] === 'model.run');
    expect(runLog).toBeDefined();
    expect(runLog!['input_tokens']).toBeNull();
    expect(runLog!['output_tokens']).toBeNull();
  });
});
