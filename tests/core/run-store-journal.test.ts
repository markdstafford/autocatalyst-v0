// tests/core/run-store-journal.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileRunStore } from '../../src/core/run-store.js';
import { RunJournal } from '../../src/core/journal/run-journal.js';
import { JsonlJournalWriter } from '../../src/core/journal/jsonl-writer.js';
import type { Run } from '../../src/types/runs.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: randomUUID(),
    request_id: randomUUID(),
    intent: 'idea',
    stage: 'reviewing_spec',
    workspace_path: '/tmp/placeholder',
    branch: 'spec/test',
    artifact: undefined,
    impl_feedback_ref: undefined,
    attempt: 0,
    channel: { provider: 'test', id: 'C123' },
    conversation: { provider: 'test', channel_id: 'C123', conversation_id: '100.0' },
    origin: { provider: 'test', channel_id: 'C123', conversation_id: '100.0', message_id: '100.0' },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

async function readJournalLines(tempDir: string): Promise<Record<string, unknown>[]> {
  const journalPath = path.join(tempDir, '.autocatalyst', 'journal', 'run-events.jsonl');
  const content = await fsPromises.readFile(journalPath, 'utf-8');
  return content
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>);
}

let tempDir: string;

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────
// Journal survives FileRunStore.load() prune (workspace deleted)
// ─────────────────────────────────────────────

describe('FileRunStore journal integration — prune', () => {
  it('appends pruned event and preserves pre-existing journal lines when workspace is missing', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runstore-journal-test-'));

    const writer = new JsonlJournalWriter(tempDir, { writerId: 'test' });
    const journal = new RunJournal(writer);

    const run = makeRun({
      stage: 'reviewing_spec',
      workspace_path: path.join(tempDir, 'nonexistent-workspace'),
    });

    // Pre-write a journal line to prove it survives the prune
    await journal.captureRunEvent(run, 'created');

    // Set up the store with the run persisted to disk
    const autocatalystDir = path.join(tempDir, '.autocatalyst');
    fs.mkdirSync(autocatalystDir, { recursive: true });
    fs.writeFileSync(path.join(autocatalystDir, 'runs.json'), JSON.stringify([run]));

    const store = new FileRunStore(tempDir, { journal });
    const loaded = store.load();

    // Wait for async journal writes to settle
    await writer.close?.();

    // Run was dropped because workspace doesn't exist
    expect(loaded).toHaveLength(0);

    const lines = await readJournalLines(tempDir);

    // Original 'created' entry must still be there
    expect(lines.some(l => l['event_type'] === 'created')).toBe(true);

    // A 'pruned' entry was appended by the store
    expect(lines.some(l => l['event_type'] === 'pruned')).toBe(true);

    // Exactly two entries total
    expect(lines).toHaveLength(2);
  });

  it('pruned event records the correct run_id and request_id', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runstore-journal-test-'));

    const writer = new JsonlJournalWriter(tempDir, { writerId: 'test' });
    const journal = new RunJournal(writer);

    const run = makeRun({
      stage: 'speccing',
      workspace_path: path.join(tempDir, 'gone-workspace'),
    });

    const autocatalystDir = path.join(tempDir, '.autocatalyst');
    fs.mkdirSync(autocatalystDir, { recursive: true });
    fs.writeFileSync(path.join(autocatalystDir, 'runs.json'), JSON.stringify([run]));

    const store = new FileRunStore(tempDir, { journal });
    store.load();

    await writer.close?.();

    const lines = await readJournalLines(tempDir);
    const prunedEntry = lines.find(l => l['event_type'] === 'pruned');
    expect(prunedEntry).toBeDefined();
    expect(prunedEntry!['run_id']).toBe(run.id);
    expect(prunedEntry!['request_id']).toBe(run.request_id);
  });
});

// ─────────────────────────────────────────────
// Journal survives FileRunStore.load() demote (stale run)
// ─────────────────────────────────────────────

describe('FileRunStore journal integration — demote', () => {
  it('appends demoted event and preserves pre-existing journal lines when run is stale', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runstore-journal-test-'));

    const workspacePath = path.join(tempDir, 'ws-stale');
    fs.mkdirSync(workspacePath, { recursive: true });

    const writer = new JsonlJournalWriter(tempDir, { writerId: 'test' });
    const journal = new RunJournal(writer);

    const run = makeRun({
      stage: 'implementing',
      workspace_path: workspacePath,
    });

    // Pre-write a journal line to prove it survives the demotion
    await journal.captureRunEvent(run, 'created');

    const autocatalystDir = path.join(tempDir, '.autocatalyst');
    fs.mkdirSync(autocatalystDir, { recursive: true });
    fs.writeFileSync(path.join(autocatalystDir, 'runs.json'), JSON.stringify([run]));

    const store = new FileRunStore(tempDir, { journal });
    const loaded = store.load();

    // Wait for async journal writes to settle
    await writer.close?.();

    // Run was kept but demoted to 'failed'
    expect(loaded).toHaveLength(1);
    expect(loaded[0].stage).toBe('failed');

    const lines = await readJournalLines(tempDir);

    // Original 'created' entry must still be there
    expect(lines.some(l => l['event_type'] === 'created')).toBe(true);

    // A 'demoted' entry was appended by the store
    expect(lines.some(l => l['event_type'] === 'demoted')).toBe(true);

    // Exactly two entries total
    expect(lines).toHaveLength(2);
  });

  it('demoted event records from_stage and to_stage correctly', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runstore-journal-test-'));

    const workspacePath = path.join(tempDir, 'ws-speccing');
    fs.mkdirSync(workspacePath, { recursive: true });

    const writer = new JsonlJournalWriter(tempDir, { writerId: 'test' });
    const journal = new RunJournal(writer);

    const run = makeRun({
      stage: 'speccing',
      workspace_path: workspacePath,
    });

    const autocatalystDir = path.join(tempDir, '.autocatalyst');
    fs.mkdirSync(autocatalystDir, { recursive: true });
    fs.writeFileSync(path.join(autocatalystDir, 'runs.json'), JSON.stringify([run]));

    const store = new FileRunStore(tempDir, { journal });
    store.load();

    await writer.close?.();

    const lines = await readJournalLines(tempDir);
    const demotedEntry = lines.find(l => l['event_type'] === 'demoted');
    expect(demotedEntry).toBeDefined();
    expect(demotedEntry!['from_stage']).toBe('speccing');
    expect(demotedEntry!['to_stage']).toBe('failed');
    expect(demotedEntry!['run_id']).toBe(run.id);
  });
});

// ─────────────────────────────────────────────
// Disabled journal writes no files
// ─────────────────────────────────────────────

describe('FileRunStore — no journal (config-gating)', () => {
  it('does not create a journal directory when no journal is configured', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runstore-journal-test-'));

    // Store created WITHOUT a journal option
    const store = new FileRunStore(tempDir);
    const loaded = store.load();

    expect(loaded).toEqual([]);

    const journalDir = path.join(tempDir, '.autocatalyst', 'journal');
    expect(fs.existsSync(journalDir)).toBe(false);
  });

  it('does not create journal files when runs are pruned and no journal is configured', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runstore-journal-test-'));

    const run = makeRun({
      stage: 'reviewing_spec',
      workspace_path: path.join(tempDir, 'nonexistent'),
    });

    const autocatalystDir = path.join(tempDir, '.autocatalyst');
    fs.mkdirSync(autocatalystDir, { recursive: true });
    fs.writeFileSync(path.join(autocatalystDir, 'runs.json'), JSON.stringify([run]));

    const store = new FileRunStore(tempDir);
    const loaded = store.load();

    expect(loaded).toHaveLength(0);

    const journalPath = path.join(tempDir, '.autocatalyst', 'journal', 'run-events.jsonl');
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  it('does not create journal files when runs are demoted and no journal is configured', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runstore-journal-test-'));

    const workspacePath = path.join(tempDir, 'ws-demote');
    fs.mkdirSync(workspacePath, { recursive: true });

    const run = makeRun({
      stage: 'implementing',
      workspace_path: workspacePath,
    });

    const autocatalystDir = path.join(tempDir, '.autocatalyst');
    fs.mkdirSync(autocatalystDir, { recursive: true });
    fs.writeFileSync(path.join(autocatalystDir, 'runs.json'), JSON.stringify([run]));

    const store = new FileRunStore(tempDir);
    const loaded = store.load();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].stage).toBe('failed');

    const journalPath = path.join(tempDir, '.autocatalyst', 'journal', 'run-events.jsonl');
    expect(fs.existsSync(journalPath)).toBe(false);
  });
});

// ─────────────────────────────────────────────
// NoopJournalWriter unit test (config-gating via writer)
// ─────────────────────────────────────────────

describe('NoopJournalWriter — writes no files', () => {
  it('NoopJournalWriter.append() resolves without creating any files', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runstore-journal-test-'));

    const { NoopJournalWriter } = await import('../../src/types/journal.js');
    const writer = new NoopJournalWriter();

    await writer.append('run-events', { event_type: 'created', run_id: 'r1' });
    await writer.append('messages', { content: 'test' });

    // No files were written anywhere under tempDir
    const journalDir = path.join(tempDir, '.autocatalyst', 'journal');
    expect(fs.existsSync(journalDir)).toBe(false);
  });
});
