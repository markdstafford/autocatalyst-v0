import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonlJournalWriter } from '../../../src/core/journal/jsonl-writer.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('JsonlJournalWriter', () => {
  it('creates dir and writes valid JSON lines ending in newline', async () => {
    const writer = new JsonlJournalWriter(tmpDir);
    await writer.append('messages', { content: 'hello' });
    await writer.close?.();

    const filePath = path.join(tmpDir, '.autocatalyst', 'journal', 'messages.jsonl');
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content.endsWith('\n')).toBe(true);

    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({ content: 'hello' });
  });

  it('includes writer_id and increments seq for two messages appends', async () => {
    const writer = new JsonlJournalWriter(tmpDir, { writerId: 'test-writer-id' });
    await writer.append('messages', { content: 'first' });
    await writer.append('messages', { content: 'second' });
    await writer.close?.();

    const filePath = path.join(tmpDir, '.autocatalyst', 'journal', 'messages.jsonl');
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);

    expect(first.writer_id).toBe('test-writer-id');
    expect(second.writer_id).toBe('test-writer-id');
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });

  it('per-stream seq: sessions append starts at seq 1 independent of messages seq', async () => {
    const writer = new JsonlJournalWriter(tmpDir, { writerId: 'per-stream-test' });
    await writer.append('messages', { content: 'msg1' });
    await writer.append('messages', { content: 'msg2' });
    await writer.append('sessions', { phase: 'implementation' });
    await writer.close?.();

    const sessionsPath = path.join(tmpDir, '.autocatalyst', 'journal', 'sessions.jsonl');
    const sessionLines = fs.readFileSync(sessionsPath, 'utf-8').trim().split('\n');
    expect(sessionLines).toHaveLength(1);

    const sessionRecord = JSON.parse(sessionLines[0]);
    expect(sessionRecord.seq).toBe(1);
  });

  it('second writer preserves existing lines and uses new writer_id, starts seq at 1', async () => {
    const firstWriter = new JsonlJournalWriter(tmpDir, { writerId: 'writer-one' });
    await firstWriter.append('messages', { content: 'from first' });
    await firstWriter.close?.();

    const secondWriter = new JsonlJournalWriter(tmpDir, { writerId: 'writer-two' });
    await secondWriter.append('messages', { content: 'from second' });
    await secondWriter.close?.();

    const filePath = path.join(tmpDir, '.autocatalyst', 'journal', 'messages.jsonl');
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);

    expect(first.writer_id).toBe('writer-one');
    expect(second.writer_id).toBe('writer-two');
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(1);
  });

  it('concurrent appends produce 25 complete parseable lines with seq 1..25', async () => {
    const writer = new JsonlJournalWriter(tmpDir);
    await Promise.all([...Array(25).keys()].map(i => writer.append('feedback', { msg: i })));
    await writer.close?.();

    const filePath = path.join(tmpDir, '.autocatalyst', 'journal', 'feedback.jsonl');
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(25);

    const seqs: number[] = [];
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(typeof parsed.seq).toBe('number');
      expect(typeof parsed.writer_id).toBe('string');
      seqs.push(parsed.seq);
    }

    seqs.sort((a, b) => a - b);
    expect(seqs).toEqual([...Array(25).keys()].map(i => i + 1));
  });

  it('write failure is non-fatal: logs journal.append_failed and append resolves', async () => {
    const warnCalls: Array<{ obj: unknown; msg: string }> = [];
    const mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn((...args: unknown[]) => {
        const [obj, msg] = args as [unknown, string];
        warnCalls.push({ obj, msg });
      }),
      error: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
    } as unknown as import('pino').Logger;

    const failingAppend = vi.fn(async () => {
      throw new Error('disk full');
    });

    const writer = new JsonlJournalWriter(tmpDir, {
      logger: mockLogger,
      appendFile: failingAppend,
    });

    // Should resolve without throwing
    await expect(writer.append('feedback', { msg: 'test' })).resolves.toBeUndefined();
    await writer.close?.();

    const appendFailedCall = warnCalls.find(
      c => (c.obj as Record<string, unknown>)?.event === 'journal.append_failed',
    );
    expect(appendFailedCall).toBeDefined();
  });

  it('close() logs journal.closed with per-stream append counts', async () => {
    const infoCalls: Array<{ obj: unknown; msg: string }> = [];
    const mockLogger = {
      info: vi.fn((...args: unknown[]) => {
        const [obj, msg] = args as [unknown, string];
        infoCalls.push({ obj, msg: msg ?? '' });
      }),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
    } as unknown as import('pino').Logger;

    const writer = new JsonlJournalWriter(tmpDir, { logger: mockLogger });
    await writer.append('messages', { content: 'a' });
    await writer.append('messages', { content: 'b' });
    await writer.append('sessions', { phase: 'x' });
    await writer.close?.();

    const closedCall = infoCalls.find(
      c => (c.obj as Record<string, unknown>)?.event === 'journal.closed',
    );
    expect(closedCall).toBeDefined();

    const counts = (closedCall!.obj as Record<string, unknown>).counts as Record<string, number>;
    expect(counts['messages']).toBe(2);
    expect(counts['sessions']).toBe(1);
  });
});
