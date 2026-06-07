import { describe, expect, it, vi } from 'vitest';
import { RunJournal } from '../../../src/core/journal/run-journal.js';
import type { JournalStream, JournalWriter } from '../../../src/types/journal.js';
import type { Run } from '../../../src/types/runs.js';

function makeMockWriter(): { writer: JournalWriter; calls: Array<{ stream: JournalStream; record: unknown }> } {
  const calls: Array<{ stream: JournalStream; record: unknown }> = [];
  const writer: JournalWriter = {
    async append(stream, record) {
      calls.push({ stream, record });
    },
  };
  return { writer, calls };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-001',
    request_id: 'req-001',
    intent: 'idea',
    stage: 'intake',
    workspace_path: '/workspaces/test',
    branch: 'spec/run-001',
    impl_feedback_ref: undefined,
    issue: undefined,
    attempt: 0,
    pr_url: undefined,
    last_impl_result: undefined,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    conversation: {
      provider: 'slack',
      channel_id: 'C123',
      conversation_id: 'T456',
    },
    origin: {
      provider: 'slack',
      channel_id: 'C123',
      conversation_id: 'T456',
      message_id: 'msg-789',
    },
    ...overrides,
  };
}

describe('RunJournal facade', () => {
  it('captureRunEvent writes a run-events record', async () => {
    const { writer, calls } = makeMockWriter();
    const journal = new RunJournal(writer);
    const run = makeRun();

    await journal.captureRunEvent(run, 'created');

    expect(calls).toHaveLength(1);
    const { stream, record } = calls[0];
    expect(stream).toBe('run-events');
    const rec = record as Record<string, unknown>;
    expect(rec.event_type).toBe('created');
    expect(rec.run_id).toBe('run-001');
    expect(rec.request_id).toBe('req-001');
    expect(rec.from_stage).toBeNull();
    expect(rec.to_stage).toBe('intake');
    expect(rec.conversation_id).toBe('slack:C123:T456');
    expect(rec.topic_id).toBe('run-001');
    expect(rec.intent).toBe('idea');
    expect(rec.workspace_path).toBe('/workspaces/test');
    expect(rec.branch).toBe('spec/run-001');
    expect(rec.attempt).toBe(0);
  });

  it('captureRunEvent transition sets from/to stage from params', async () => {
    const { writer, calls } = makeMockWriter();
    const journal = new RunJournal(writer);
    const run = makeRun({ stage: 'intake' });

    await journal.captureRunEvent(run, 'transition', 'intake', 'speccing');

    const rec = calls[0].record as Record<string, unknown>;
    expect(rec.event_type).toBe('transition');
    expect(rec.from_stage).toBe('intake');
    expect(rec.to_stage).toBe('speccing');
  });

  it('captureRunEvent pruned sets to_stage null', async () => {
    const { writer, calls } = makeMockWriter();
    const journal = new RunJournal(writer);
    const run = makeRun({ stage: 'speccing' });

    await journal.captureRunEvent(run, 'pruned');

    const rec = calls[0].record as Record<string, unknown>;
    expect(rec.event_type).toBe('pruned');
    expect(rec.from_stage).toBe('speccing');
    expect(rec.to_stage).toBeNull();
  });

  it('captureRunEvent demoted sets to_stage to failed', async () => {
    const { writer, calls } = makeMockWriter();
    const journal = new RunJournal(writer);
    const run = makeRun({ stage: 'implementing' });

    await journal.captureRunEvent(run, 'demoted');

    const rec = calls[0].record as Record<string, unknown>;
    expect(rec.event_type).toBe('demoted');
    expect(rec.from_stage).toBe('implementing');
    expect(rec.to_stage).toBe('failed');
  });

  it('captureInboundMessage writes a messages record with redacted content', async () => {
    const { writer, calls } = makeMockWriter();
    const journal = new RunJournal(writer);
    const run = makeRun();

    const message = { content: 'Hello, my api_key=sk-1234567890abcdef', received_at: '2024-01-01T00:00:00.000Z' };
    await journal.captureInboundMessage(run, message, 'idea', 'classified');

    expect(calls).toHaveLength(1);
    const { stream, record } = calls[0];
    expect(stream).toBe('messages');
    const rec = record as Record<string, unknown>;
    expect(rec.direction).toBe('in');
    expect(rec.ts).toBe('2024-01-01T00:00:00.000Z');
    expect(rec.content).not.toContain('sk-1234567890abcdef');
    expect(rec.content).toContain('[REDACTED]');
    expect(rec.intent).toBe('idea');
    expect(rec.classification_status).toBe('classified');
    expect(rec.author_principal).toBe('slack:msg-789');
    expect(rec.origin_message_id).toBe('slack:C123:T456:msg-789');
    expect(rec.conversation_id).toBe('slack:C123:T456');
    expect(rec.run_id).toBe('run-001');
    expect(rec.request_id).toBe('req-001');
  });

  it('captureInboundMessage uses current time when received_at is absent', async () => {
    const { writer, calls } = makeMockWriter();
    const journal = new RunJournal(writer);
    const run = makeRun();

    const before = Date.now();
    await journal.captureInboundMessage(run, { content: 'hello' }, null, 'not_applicable');
    const after = Date.now();

    const rec = calls[0].record as Record<string, unknown>;
    const ts = new Date(rec.ts as string).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('captureOutboundMessage writes a messages record', async () => {
    const { writer, calls } = makeMockWriter();
    const journal = new RunJournal(writer);
    const run = makeRun();

    await journal.captureOutboundMessage(run, 'Here is your result', 'origin-msg-id');

    expect(calls).toHaveLength(1);
    const { stream, record } = calls[0];
    expect(stream).toBe('messages');
    const rec = record as Record<string, unknown>;
    expect(rec.direction).toBe('out');
    expect(rec.author_principal).toBe('autocatalyst');
    expect(rec.content).toBe('Here is your result');
    expect(rec.intent).toBeNull();
    expect(rec.classification_status).toBe('not_applicable');
    expect(rec.origin_message_id).toBe('origin-msg-id');
    expect(rec.run_id).toBe('run-001');
  });

  it('captureOutboundMessage redacts secrets in text', async () => {
    const { writer, calls } = makeMockWriter();
    const journal = new RunJournal(writer);
    const run = makeRun();

    await journal.captureOutboundMessage(run, 'Result with sk-supersecretkey123');

    const rec = calls[0].record as Record<string, unknown>;
    expect(rec.content).not.toContain('sk-supersecretkey123');
    expect(rec.content).toContain('[REDACTED]');
  });

  it('captureSession increments session_seq per run', async () => {
    const { writer, calls } = makeMockWriter();
    const journal = new RunJournal(writer);
    const run = makeRun();

    const baseParams = {
      run,
      ts_start: '2024-01-01T00:00:00.000Z',
      ts_end: '2024-01-01T00:01:00.000Z',
      step: 'artifact.create' as const,
      round: 1,
      model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
      inference: { effort: 'medium' as const, thinking: null },
      outcome: 'ok' as const,
      runner: 'anthropic_agent' as const,
    };

    await journal.captureSession(baseParams);
    await journal.captureSession({ ...baseParams, round: 2 });
    await journal.captureSession({ ...baseParams, round: 3 });

    expect(calls).toHaveLength(3);
    expect((calls[0].record as Record<string, unknown>).session_seq).toBe(1);
    expect((calls[1].record as Record<string, unknown>).session_seq).toBe(2);
    expect((calls[2].record as Record<string, unknown>).session_seq).toBe(3);
  });

  it('captureSession uses independent counters per run', async () => {
    const { writer, calls } = makeMockWriter();
    const journal = new RunJournal(writer);
    const run1 = makeRun({ id: 'run-aaa', request_id: 'req-aaa' });
    const run2 = makeRun({ id: 'run-bbb', request_id: 'req-bbb' });

    const baseParams = {
      ts_start: '2024-01-01T00:00:00.000Z',
      ts_end: '2024-01-01T00:01:00.000Z',
      step: 'artifact.create' as const,
      round: 1,
      model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
      inference: { effort: 'medium' as const, thinking: null },
      outcome: 'ok' as const,
      runner: 'anthropic_agent' as const,
    };

    await journal.captureSession({ ...baseParams, run: run1 });
    await journal.captureSession({ ...baseParams, run: run2 });
    await journal.captureSession({ ...baseParams, run: run1 });

    const seqs = calls.map((c) => (c.record as Record<string, unknown>).session_seq);
    const runIds = calls.map((c) => (c.record as Record<string, unknown>).run_id);

    expect(runIds).toEqual(['run-aaa', 'run-bbb', 'run-aaa']);
    expect(seqs).toEqual([1, 1, 2]);
  });

  it('captureFeedback writes a feedback record with redacted text', async () => {
    const { writer, calls } = makeMockWriter();
    const journal = new RunJournal(writer);
    const run = makeRun();

    await journal.captureFeedback({
      id: 'fb-001',
      run,
      target: 'artifact',
      author_principal: 'slack:U123',
      text: 'Please fix password=hunter2 in the code',
      severity: 'warning',
      category: 'human_feedback',
    });

    expect(calls).toHaveLength(1);
    const { stream, record } = calls[0];
    expect(stream).toBe('feedback');
    const rec = record as Record<string, unknown>;
    expect(rec.id).toBe('fb-001');
    expect(rec.target).toBe('artifact');
    expect(rec.author_principal).toBe('slack:U123');
    expect(rec.text).not.toContain('hunter2');
    expect(rec.text).toContain('[REDACTED]');
    expect(rec.severity).toBe('warning');
    expect(rec.category).toBe('human_feedback');
    expect(rec.disposition).toBe('open');
    expect(rec.gate).toBeNull();
    expect(rec.anchor).toBeNull();
    expect(rec.thread).toEqual([]);
    expect(rec.run_id).toBe('run-001');
    expect(rec.conversation_id).toBe('slack:C123:T456');
  });

  it('captureFeedback redacts secrets in thread items', async () => {
    const { writer, calls } = makeMockWriter();
    const journal = new RunJournal(writer);
    const run = makeRun();

    await journal.captureFeedback({
      id: 'fb-002',
      run,
      target: 'implementation',
      author_principal: 'slack:U123',
      text: 'normal feedback',
      severity: 'info',
      category: 'human_feedback',
      thread: [
        { author_principal: 'slack:U456', ts: '2024-01-01T00:00:00.000Z', text: 'Reply with api_key=verysecret123' },
      ],
    });

    const rec = calls[0].record as Record<string, unknown>;
    const thread = rec.thread as Array<Record<string, unknown>>;
    expect(thread[0].text).not.toContain('verysecret123');
    expect(thread[0].text).toContain('[REDACTED]');
  });

  it('errors from writer.append are caught and do not throw', async () => {
    const failingWriter: JournalWriter = {
      async append() {
        throw new Error('disk full');
      },
    };
    const journal = new RunJournal(failingWriter);
    const run = makeRun();

    // None of these should throw
    await expect(journal.captureRunEvent(run, 'created')).resolves.toBeUndefined();
    await expect(journal.captureInboundMessage(run, { content: 'hello' }, null, 'not_applicable')).resolves.toBeUndefined();
    await expect(journal.captureOutboundMessage(run, 'hi')).resolves.toBeUndefined();
    await expect(
      journal.captureSession({
        run,
        ts_start: new Date().toISOString(),
        ts_end: new Date().toISOString(),
        step: 'artifact.create',
        round: 1,
        model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
        inference: { effort: null, thinking: null },
        outcome: 'ok',
        runner: 'anthropic_agent',
      }),
    ).resolves.toBeUndefined();
    await expect(
      journal.captureFeedback({
        id: 'fb-err',
        run,
        target: 'artifact',
        author_principal: 'slack:U1',
        text: 'hi',
        severity: 'info',
        category: 'human_feedback',
      }),
    ).resolves.toBeUndefined();
  });

  it('captureSession writes correct stream and fields', async () => {
    const { writer, calls } = makeMockWriter();
    const journal = new RunJournal(writer);
    const run = makeRun();

    await journal.captureSession({
      run,
      ts_start: '2024-01-01T00:00:00.000Z',
      ts_end: '2024-01-01T00:01:00.000Z',
      phase: 'speccing',
      step: 'artifact.create',
      round: 2,
      model: { provider: 'anthropic', name: 'claude-opus-4-5' },
      inference: { effort: 'high', thinking: 'disabled' },
      tokens: { input: 100, output: 50, cache_read: 10, cache_write: 5 },
      assistant_turns: 3,
      tool_calls: 4,
      tool_results: 4,
      outcome: 'ok',
      runner: 'anthropic_agent',
    });

    const { stream, record } = calls[0];
    expect(stream).toBe('sessions');
    const rec = record as Record<string, unknown>;
    expect(rec.session_seq).toBe(1);
    expect(rec.ts_start).toBe('2024-01-01T00:00:00.000Z');
    expect(rec.ts_end).toBe('2024-01-01T00:01:00.000Z');
    expect(rec.phase).toBe('speccing');
    expect(rec.step).toBe('artifact.create');
    expect(rec.round).toBe(2);
    expect(rec.role).toBeNull();
    expect(rec.gate).toBeNull();
    expect(rec.model).toEqual({ provider: 'anthropic', name: 'claude-opus-4-5' });
    expect(rec.inference).toEqual({ effort: 'high', thinking: 'disabled' });
    expect(rec.tokens).toEqual({ input: 100, output: 50, cache_read: 10, cache_write: 5 });
    expect(rec.assistant_turns).toBe(3);
    expect(rec.tool_calls).toBe(4);
    expect(rec.tool_results).toBe(4);
    expect(rec.outcome).toBe('ok');
    expect(rec.runner).toBe('anthropic_agent');
    expect(rec.conversation_id).toBe('slack:C123:T456');
    expect(rec.run_id).toBe('run-001');
    expect(rec.request_id).toBe('req-001');
  });
});
