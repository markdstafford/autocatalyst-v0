import { describe, expect, it } from 'vitest';
import type {
  JournalMessageRecord,
  JournalSessionRecord,
  JournalFeedbackRecord,
  JournalRunEventRecord,
  NormalizedTokenUsage,
} from '../../../src/types/journal.js';
import { JournalWriter, NoopJournalWriter } from '../../../src/types/journal.js';

describe('journal types (compile-focused)', () => {
  it('constructs a valid JournalMessageRecord', () => {
    const tokens: NormalizedTokenUsage = {
      input: 100,
      output: 50,
      cache_read: 0,
      cache_write: 0,
    };

    const record: JournalMessageRecord = {
      seq: 1,
      writer_id: 'test-writer',
      ts: new Date().toISOString(),
      conversation_id: 'slack:C123:T456',
      topic_id: 'run-001',
      run_id: 'run-001',
      request_id: 'req-001',
      direction: 'in',
      author_principal: 'user:alice',
      content: 'Hello world',
      intent: 'idea',
      classification_status: 'classified',
      origin_message_id: null,
    };

    expect(record.conversation_id).toBe('slack:C123:T456');
    expect(record.direction).toBe('in');
    expect(record.classification_status).toBe('classified');
    expect(tokens.input).toBe(100);
  });

  it('constructs a valid JournalSessionRecord', () => {
    const tokens: NormalizedTokenUsage = {
      input: 500,
      output: 200,
      cache_read: 100,
      cache_write: 50,
    };

    const record: JournalSessionRecord = {
      seq: 2,
      writer_id: 'test-writer',
      session_seq: 1,
      ts_start: new Date().toISOString(),
      ts_end: new Date().toISOString(),
      conversation_id: 'slack:C123:T456',
      topic_id: 'run-001',
      run_id: 'run-001',
      request_id: 'req-001',
      phase: 'implementation',
      step: 'implementation.run',
      role: null,
      round: 1,
      gate: null,
      model: { provider: 'anthropic', name: 'claude-opus-4-5' },
      inference: { effort: 'high', thinking: 'disabled' },
      tokens,
      assistant_turns: 3,
      tool_calls: 5,
      tool_results: 5,
      outcome: 'ok',
      runner: 'anthropic_agent',
    };

    expect(record.session_seq).toBe(1);
    expect(record.model.provider).toBe('anthropic');
    expect(record.tokens?.input).toBe(500);
    expect(record.assistant_turns).toBe(3);
    expect(record.tool_calls).toBe(5);
    expect(record.tool_results).toBe(5);
  });

  it('constructs a valid JournalFeedbackRecord', () => {
    const record: JournalFeedbackRecord = {
      seq: 3,
      writer_id: 'test-writer',
      id: 'fb-001',
      ts_created: new Date().toISOString(),
      conversation_id: 'slack:C123:T456',
      topic_id: 'run-001',
      run_id: 'run-001',
      request_id: 'req-001',
      target: 'implementation',
      gate: null,
      author_principal: 'user:alice',
      text: 'Fix the bug on line 42',
      anchor: null,
      severity: 'warning',
      category: 'correctness',
      disposition: 'open',
      thread: [],
    };

    expect(record.target).toBe('implementation');
    expect(record.severity).toBe('warning');
    expect(record.category).toBe('correctness');
    expect(record.disposition).toBe('open');
  });

  it('constructs a valid JournalRunEventRecord', () => {
    const record: JournalRunEventRecord = {
      seq: 4,
      writer_id: 'test-writer',
      event_type: 'transition',
      ts: new Date().toISOString(),
      run_id: 'run-001',
      request_id: 'req-001',
      conversation_id: 'slack:C123:T456',
      topic_id: 'run-001',
      from_stage: 'intake',
      to_stage: 'speccing',
      attempt: 1,
      intent: 'idea',
      workspace_path: '/workspaces/my-project',
      branch: 'feature/my-feature',
      artifact_ref: null,
      pr_url: null,
      issue: null,
    };

    expect(record.event_type).toBe('transition');
    expect(record.from_stage).toBe('intake');
    expect(record.to_stage).toBe('speccing');
  });

  it('NoopJournalWriter implements JournalWriter and no-ops on append', async () => {
    const writer: JournalWriter = new NoopJournalWriter();

    await writer.append('messages', { seq: 1 });
    await writer.append('sessions', { seq: 2 });
    await writer.append('feedback', { seq: 3 });
    await writer.append('run-events', { seq: 4 });

    expect(true).toBe(true); // all calls resolved without error
  });
});
