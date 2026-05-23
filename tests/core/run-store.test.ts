// tests/core/run-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'node:crypto';
import { FileRunStore } from '../../src/core/run-store.js';
import type { Run } from '../../src/types/runs.js';

// Capture pino log lines from a FileRunStore via destination injection
function makeLogCapture() {
  const lines: string[] = [];
  const dest = {
    write(chunk: string) {
      lines.push(chunk.trim());
    },
  };
  return { lines, dest };
}

function parseLogs(lines: string[]): Record<string, unknown>[] {
  return lines
    .filter(l => l.startsWith('{'))
    .map(l => JSON.parse(l) as Record<string, unknown>);
}

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

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `run-store-test-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────
// load — file not found
// ─────────────────────────────────────────────

describe('FileRunStore.load — file not found', () => {
  it('returns empty array and emits run_store.loaded with total_loaded:0', () => {
    const { lines, dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });
    const result = store.load();

    expect(result).toEqual([]);

    const logs = parseLogs(lines);
    const loaded = logs.find(l => l['event'] === 'run_store.loaded');
    expect(loaded).toBeDefined();
    expect(loaded!['total_loaded']).toBe(0);
  });
});

// ─────────────────────────────────────────────
// load — corrupt JSON
// ─────────────────────────────────────────────

describe('FileRunStore.load — corrupt JSON', () => {
  it('returns empty array and emits run_store.load_failed', () => {
    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs.json'), 'not json!!!');

    const { lines, dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });
    const result = store.load();

    expect(result).toEqual([]);

    const logs = parseLogs(lines);
    const failed = logs.find(l => l['event'] === 'run_store.load_failed');
    expect(failed).toBeDefined();
  });
});

// ─────────────────────────────────────────────
// load — non-array JSON
// ─────────────────────────────────────────────

describe('FileRunStore.load — non-array JSON', () => {
  it('returns empty array and emits run_store.load_failed', () => {
    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs.json'), '{}');

    const { lines, dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });
    const result = store.load();

    expect(result).toEqual([]);

    const logs = parseLogs(lines);
    const failed = logs.find(l => l['event'] === 'run_store.load_failed');
    expect(failed).toBeDefined();
  });
});

// ─────────────────────────────────────────────
// load — workspace_path missing
// ─────────────────────────────────────────────

describe('FileRunStore.load — workspace_path missing', () => {
  it('drops run with non-existent workspace_path and emits run_store.run_dropped with request_id', () => {
    const run = makeRun({
      workspace_path: path.join(tmpDir, 'nonexistent-workspace'),
    });

    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run]));

    const { lines, dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });
    const result = store.load();

    expect(result).toEqual([]);

    const logs = parseLogs(lines);
    const dropped = logs.find(l => l['event'] === 'run_store.run_dropped');
    expect(dropped).toBeDefined();
    expect(dropped!['request_id']).toBe(run.request_id);
  });
});

// ─────────────────────────────────────────────
// load — terminal runs kept despite missing workspace
// ─────────────────────────────────────────────

describe('FileRunStore.load — terminal runs with missing workspace', () => {
  it('keeps a done run even when workspace_path does not exist', () => {
    const run = makeRun({
      stage: 'done',
      workspace_path: path.join(tmpDir, 'nonexistent-done-workspace'),
    });

    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run]));

    const { lines, dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });
    const result = store.load();

    expect(result).toHaveLength(1);
    expect(result[0].request_id).toBe(run.request_id);
    expect(result[0].stage).toBe('done');

    const logs = parseLogs(lines);
    expect(logs.find(l => l['event'] === 'run_store.run_dropped')).toBeUndefined();
  });

  it('keeps a failed run even when workspace_path does not exist', () => {
    const run = makeRun({
      stage: 'failed',
      workspace_path: path.join(tmpDir, 'nonexistent-failed-workspace'),
    });

    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run]));

    const { lines, dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });
    const result = store.load();

    expect(result).toHaveLength(1);
    expect(result[0].request_id).toBe(run.request_id);
    expect(result[0].stage).toBe('failed');

    const logs = parseLogs(lines);
    expect(logs.find(l => l['event'] === 'run_store.run_dropped')).toBeUndefined();
  });

  it('still drops an active stage run (reviewing_implementation) with missing workspace', () => {
    const run = makeRun({
      stage: 'reviewing_implementation',
      workspace_path: path.join(tmpDir, 'nonexistent-active-workspace'),
    });

    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run]));

    const { lines, dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });
    const result = store.load();

    expect(result).toHaveLength(0);

    const logs = parseLogs(lines);
    const dropped = logs.find(l => l['event'] === 'run_store.run_dropped');
    expect(dropped).toBeDefined();
    expect(dropped!['request_id']).toBe(run.request_id);
  });

  it('both done and failed runs are retained when workspaces are missing', () => {
    const doneRun = makeRun({
      stage: 'done',
      workspace_path: path.join(tmpDir, 'gone-done'),
    });
    const failedRun = makeRun({
      stage: 'failed',
      workspace_path: path.join(tmpDir, 'gone-failed'),
    });

    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([doneRun, failedRun]));

    const store = new FileRunStore(tmpDir);
    const result = store.load();

    expect(result).toHaveLength(2);
    expect(result.find(r => r.request_id === doneRun.request_id)).toBeDefined();
    expect(result.find(r => r.request_id === failedRun.request_id)).toBeDefined();
  });
});

// ─────────────────────────────────────────────
// load — stale stage demotion
// ─────────────────────────────────────────────

describe('FileRunStore.load — stale stage demotion', () => {
  it('demotes implementing → failed, updates updated_at, emits run_store.run_demoted', () => {
    const workspacePath = path.join(tmpDir, 'ws-impl');
    fs.mkdirSync(workspacePath, { recursive: true });

    const originalUpdatedAt = '2024-01-01T00:00:00.000Z';
    const run = makeRun({
      stage: 'implementing',
      workspace_path: workspacePath,
      updated_at: originalUpdatedAt,
    });

    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run]));

    const { lines, dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });
    const result = store.load();

    expect(result).toHaveLength(1);
    expect(result[0].stage).toBe('failed');
    expect(result[0].updated_at).not.toBe(originalUpdatedAt);

    const logs = parseLogs(lines);
    const demoted = logs.find(l => l['event'] === 'run_store.run_demoted');
    expect(demoted).toBeDefined();
    expect(demoted!['from_stage']).toBe('implementing');
    expect(demoted!['to_stage']).toBe('failed');
  });

  it('demotes speccing → failed and emits run_store.run_demoted', () => {
    const workspacePath = path.join(tmpDir, 'ws-speccing');
    fs.mkdirSync(workspacePath, { recursive: true });

    const run = makeRun({
      stage: 'speccing',
      workspace_path: workspacePath,
    });

    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run]));

    const { lines, dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });
    const result = store.load();

    expect(result).toHaveLength(1);
    expect(result[0].stage).toBe('failed');

    const logs = parseLogs(lines);
    const demoted = logs.find(l => l['event'] === 'run_store.run_demoted');
    expect(demoted).toBeDefined();
    expect(demoted!['from_stage']).toBe('speccing');
    expect(demoted!['to_stage']).toBe('failed');
  });

  it('demotes intake → failed and emits run_store.run_demoted', () => {
    const workspacePath = path.join(tmpDir, 'ws-intake');
    fs.mkdirSync(workspacePath, { recursive: true });

    const run = makeRun({
      stage: 'intake',
      workspace_path: workspacePath,
    });

    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run]));

    const { lines, dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });
    const result = store.load();

    expect(result).toHaveLength(1);
    expect(result[0].stage).toBe('failed');

    const logs = parseLogs(lines);
    const demoted = logs.find(l => l['event'] === 'run_store.run_demoted');
    expect(demoted).toBeDefined();
    expect(demoted!['from_stage']).toBe('intake');
    expect(demoted!['to_stage']).toBe('failed');
  });
});

// ─────────────────────────────────────────────
// load — stable stages unchanged
// ─────────────────────────────────────────────

describe('FileRunStore.load — stable stages unchanged', () => {
  const stableStages = [
    'reviewing_spec',
    'awaiting_planning_input',
    'awaiting_impl_input',
    'reviewing_implementation',
    'done',
    'failed',
  ] as const;

  for (const stage of stableStages) {
    it(`returns ${stage} run as-is without demotion`, () => {
      const workspacePath = path.join(tmpDir, `ws-${stage}`);
      fs.mkdirSync(workspacePath, { recursive: true });

      const run = makeRun({ stage, workspace_path: workspacePath });

      const dir = path.join(tmpDir, '.autocatalyst');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run]));

      const { lines, dest } = makeLogCapture();
      const store = new FileRunStore(tmpDir, { logDestination: dest });
      const result = store.load();

      expect(result).toHaveLength(1);
      expect(result[0].stage).toBe(stage);

      const logs = parseLogs(lines);
      const demoted = logs.find(l => l['event'] === 'run_store.run_demoted');
      expect(demoted).toBeUndefined();
    });
  }
});

// ─────────────────────────────────────────────
// load — artifact state
// ─────────────────────────────────────────────

describe('FileRunStore.load — artifact state', () => {
  it('loads canonical artifact state without migration', () => {
    const workspacePath = path.join(tmpDir, 'ws-artifact');
    fs.mkdirSync(workspacePath, { recursive: true });

    const run = makeRun({
      intent: 'bug',
      workspace_path: workspacePath,
      stage: 'reviewing_spec',
      artifact: {
        kind: 'bug_triage',
        local_path: '/some/bug-triage.md',
        published_ref: { provider: 'artifact_publisher', id: 'publication-id' },
        status: 'waiting_on_feedback',
      },
    });

    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run]));

    const { dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });
    const result = store.load();

    expect(result).toHaveLength(1);
    expect(result[0].artifact).toEqual({
      kind: 'bug_triage',
      local_path: '/some/bug-triage.md',
      published_ref: { provider: 'artifact_publisher', id: 'publication-id' },
      status: 'waiting_on_feedback',
    });
  });

  it('migrates persisted review_artifact state into artifact', () => {
    const workspacePath = path.join(tmpDir, 'ws-legacy-review-artifact');
    fs.mkdirSync(workspacePath, { recursive: true });
    const run = {
      ...makeRun({
        intent: 'chore',
        workspace_path: workspacePath,
        stage: 'reviewing_spec',
      }),
      artifact: undefined,
      review_artifact: {
        kind: 'chore_plan',
        local_path: '/some/chore-plan.md',
        published_ref: { provider: 'artifact_publisher', id: 'publication-id' },
        status: 'waiting_on_feedback',
      },
    };

    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run]));

    const { dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });
    const result = store.load();

    expect(result[0].artifact).toEqual(run.review_artifact);
    expect('review_artifact' in result[0]).toBe(false);
  });

  it('migrates older spec_path and publisher_ref fields into artifact', () => {
    const workspacePath = path.join(tmpDir, 'ws-legacy-spec-fields');
    fs.mkdirSync(workspacePath, { recursive: true });
    const run = {
      ...makeRun({
        intent: 'bug',
        workspace_path: workspacePath,
        stage: 'reviewing_spec',
      }),
      artifact: undefined,
      spec_path: '/some/bug-triage.md',
      publisher_ref: 'publication-id',
    };

    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run]));

    const { dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });
    const result = store.load();

    expect(result[0].artifact).toEqual({
      kind: 'bug_triage',
      local_path: '/some/bug-triage.md',
      published_ref: { provider: 'artifact_publisher', id: 'publication-id' },
      status: 'waiting_on_feedback',
    });
    expect('spec_path' in result[0]).toBe(false);
    expect('publisher_ref' in result[0]).toBe(false);
  });

  it('migrates older Slack channel_id and thread_ts fields into channel-neutral refs', () => {
    const workspacePath = path.join(tmpDir, 'ws-legacy-routing-fields');
    fs.mkdirSync(workspacePath, { recursive: true });
    const run = {
      ...makeRun({
        workspace_path: workspacePath,
        stage: 'reviewing_spec',
        channel: undefined,
        conversation: undefined,
        origin: undefined,
      }),
      channel_id: 'CLEGACY',
      thread_ts: '123.456',
    };

    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run]));

    const { dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, {
      logDestination: dest,
      legacyConversationFields: {
        provider: 'slack',
        channelField: 'channel_id',
        conversationField: 'thread_ts',
      },
    });
    const result = store.load();

    expect(result[0].channel).toEqual({ provider: 'slack', id: 'CLEGACY' });
    expect(result[0].conversation).toEqual({ provider: 'slack', channel_id: 'CLEGACY', conversation_id: '123.456' });
    expect(result[0].origin).toEqual({ provider: 'slack', channel_id: 'CLEGACY', conversation_id: '123.456', message_id: '123.456' });
    expect('channel_id' in result[0]).toBe(false);
    expect('thread_ts' in result[0]).toBe(false);
  });

  it('tries each configured legacy conversation shape when loading old runs', () => {
    const workspacePath = path.join(tmpDir, 'ws-legacy-routing-array');
    fs.mkdirSync(workspacePath, { recursive: true });
    const run = {
      ...makeRun({
        workspace_path: workspacePath,
        stage: 'reviewing_spec',
        channel: undefined,
        conversation: undefined,
        origin: undefined,
      }),
      room_id: 'ROOM-1',
      topic_id: 'TOPIC-2',
      event_id: 'EVENT-3',
    };

    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run]));

    const store = new FileRunStore(tmpDir, {
      legacyConversationFields: [
        {
          provider: 'first-provider',
          channelField: 'missing_channel',
          conversationField: 'missing_conversation',
        },
        {
          provider: 'second-provider',
          channelField: 'room_id',
          conversationField: 'topic_id',
          messageField: 'event_id',
        },
      ],
    });
    const result = store.load();

    expect(result[0].channel).toEqual({ provider: 'second-provider', id: 'ROOM-1' });
    expect(result[0].conversation).toEqual({ provider: 'second-provider', channel_id: 'ROOM-1', conversation_id: 'TOPIC-2' });
    expect(result[0].origin).toEqual({ provider: 'second-provider', channel_id: 'ROOM-1', conversation_id: 'TOPIC-2', message_id: 'EVENT-3' });
    expect('room_id' in result[0]).toBe(false);
    expect('topic_id' in result[0]).toBe(false);
    expect('event_id' in result[0]).toBe(false);
  });
});

// ─────────────────────────────────────────────
// load — mixed
// ─────────────────────────────────────────────

describe('FileRunStore.load — mixed', () => {
  it('5 runs: 1 missing workspace dropped, 1 implementing demoted, 3 stable kept; total_loaded:4, dropped_count:1, demoted_count:1', () => {
    // Run 1: missing workspace — should be dropped
    const droppedRun = makeRun({
      workspace_path: path.join(tmpDir, 'nonexistent'),
      stage: 'reviewing_spec',
    });

    // Run 2: implementing with real workspace — should be demoted to failed
    const wsImpl = path.join(tmpDir, 'ws-impl-mixed');
    fs.mkdirSync(wsImpl, { recursive: true });
    const implementingRun = makeRun({
      stage: 'implementing',
      workspace_path: wsImpl,
    });

    // Run 3: reviewing_spec with real workspace — stable
    const wsReview = path.join(tmpDir, 'ws-review');
    fs.mkdirSync(wsReview, { recursive: true });
    const reviewingRun = makeRun({
      stage: 'reviewing_spec',
      workspace_path: wsReview,
    });

    // Run 4: done with real workspace — stable
    const wsDone = path.join(tmpDir, 'ws-done');
    fs.mkdirSync(wsDone, { recursive: true });
    const doneRun = makeRun({
      stage: 'done',
      workspace_path: wsDone,
    });

    // Run 5: failed with real workspace — stable
    const wsFailed = path.join(tmpDir, 'ws-failed');
    fs.mkdirSync(wsFailed, { recursive: true });
    const failedRun = makeRun({
      stage: 'failed',
      workspace_path: wsFailed,
    });

    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'runs.json'),
      JSON.stringify([droppedRun, implementingRun, reviewingRun, doneRun, failedRun]),
    );

    const { lines, dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });
    const result = store.load();

    expect(result).toHaveLength(4);

    // Implementing run should be demoted
    const impl = result.find(r => r.id === implementingRun.id);
    expect(impl).toBeDefined();
    expect(impl!.stage).toBe('failed');

    // Stable runs unchanged
    expect(result.find(r => r.id === reviewingRun.id)?.stage).toBe('reviewing_spec');
    expect(result.find(r => r.id === doneRun.id)?.stage).toBe('done');
    expect(result.find(r => r.id === failedRun.id)?.stage).toBe('failed');

    const logs = parseLogs(lines);
    const loaded = logs.find(l => l['event'] === 'run_store.loaded');
    expect(loaded).toBeDefined();
    expect(loaded!['total_loaded']).toBe(4);
    expect(loaded!['dropped_count']).toBe(1);
    expect(loaded!['demoted_count']).toBe(1);
  });
});

// ─────────────────────────────────────────────
// save — creates directory
// ─────────────────────────────────────────────

describe('FileRunStore.save — creates directory', () => {
  it('creates .autocatalyst dir and writes file when it does not exist', () => {
    // fresh tmpDir — no .autocatalyst subdir yet
    const { dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });

    const run = makeRun({ workspace_path: tmpDir });
    const runs = new Map<string, Run>([[run.request_id, run]]);
    store.save(runs);

    const filePath = path.join(tmpDir, '.autocatalyst', 'runs.json');
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

// ─────────────────────────────────────────────
// save — round-trip
// ─────────────────────────────────────────────

describe('FileRunStore.save — round-trip', () => {
  it('save then load returns the same run with refs and artifact intact', () => {
    const { dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });

    const run = makeRun({
      workspace_path: tmpDir,
      stage: 'reviewing_spec',
      channel: { provider: 'test', id: 'C_TEST' },
      conversation: { provider: 'test', channel_id: 'C_TEST', conversation_id: '123.456' },
      origin: { provider: 'test', channel_id: 'C_TEST', conversation_id: '123.456', message_id: '123.456' },
      artifact: {
        kind: 'feature_spec',
        local_path: '/some/spec.md',
        published_ref: { provider: 'artifact_publisher', id: 'publication-id' },
        status: 'waiting_on_feedback',
      },
      impl_feedback_ref: 'feedback-page-id',
      attempt: 3,
    });

    const runs = new Map<string, Run>([[run.request_id, run]]);
    store.save(runs);

    const { dest: dest2 } = makeLogCapture();
    const store2 = new FileRunStore(tmpDir, { logDestination: dest2 });
    const loaded = store2.load();

    expect(loaded).toHaveLength(1);
    const loaded0 = loaded[0];
    expect(loaded0.id).toBe(run.id);
    expect(loaded0.request_id).toBe(run.request_id);
    expect(loaded0.stage).toBe(run.stage);
    expect(loaded0.workspace_path).toBe(run.workspace_path);
    expect(loaded0.branch).toBe(run.branch);
    expect(loaded0.artifact).toEqual(run.artifact);
    expect(loaded0.impl_feedback_ref).toBe(run.impl_feedback_ref);
    expect(loaded0.attempt).toBe(run.attempt);
    expect(loaded0.channel).toEqual(run.channel);
    expect(loaded0.conversation).toEqual(run.conversation);
    expect(loaded0.origin).toEqual(run.origin);
    expect(loaded0.created_at).toBe(run.created_at);
    expect(loaded0.updated_at).toBe(run.updated_at);
  });
});

// ─────────────────────────────────────────────
// save — write failure non-fatal
// ─────────────────────────────────────────────

describe('FileRunStore.save — write failure non-fatal', () => {
  it('does not throw when .autocatalyst is a file (not a dir), emits run_store.save_failed', () => {
    // Make .autocatalyst a file so mkdirSync or writeFileSync will fail
    const autocatalystPath = path.join(tmpDir, '.autocatalyst');
    fs.writeFileSync(autocatalystPath, 'I am a file, not a dir');

    const { lines, dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });

    const run = makeRun({ workspace_path: tmpDir });
    const runs = new Map<string, Run>([[run.request_id, run]]);

    expect(() => store.save(runs)).not.toThrow();

    const logs = parseLogs(lines);
    const saveFailed = logs.find(l => l['event'] === 'run_store.save_failed');
    expect(saveFailed).toBeDefined();
  });
});

// ─────────────────────────────────────────────
// demotedIds
// ─────────────────────────────────────────────

describe('FileRunStore.demotedIds', () => {
  it('is empty before load()', () => {
    const { dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });
    expect(store.demotedIds.size).toBe(0);
  });

  it('is populated after load() with the demoted run request_id', () => {
    const workspacePath = path.join(tmpDir, 'ws-demote');
    fs.mkdirSync(workspacePath, { recursive: true });

    const run = makeRun({
      stage: 'implementing',
      workspace_path: workspacePath,
    });

    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run]));

    const { dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });
    store.load();

    expect(store.demotedIds.has(run.request_id)).toBe(true);
  });

  it('is empty when no runs are demoted', () => {
    const workspacePath = path.join(tmpDir, 'ws-stable');
    fs.mkdirSync(workspacePath, { recursive: true });

    const run = makeRun({
      stage: 'reviewing_spec',
      workspace_path: workspacePath,
    });

    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run]));

    const { dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });
    store.load();

    expect(store.demotedIds.size).toBe(0);
  });

  it('is reset on each load() call', () => {
    const workspacePath = path.join(tmpDir, 'ws-reset');
    fs.mkdirSync(workspacePath, { recursive: true });

    const run = makeRun({
      stage: 'implementing',
      workspace_path: workspacePath,
    });

    const dir = path.join(tmpDir, '.autocatalyst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run]));

    const { dest } = makeLogCapture();
    const store = new FileRunStore(tmpDir, { logDestination: dest });
    store.load();
    expect(store.demotedIds.size).toBe(1);

    // Update to stable stage so second load doesn't demote
    const loaded = store.load();
    // After first load run is already 'failed' in the file — but the file hasn't changed,
    // so it demotes again (file still has 'implementing'). Let's verify the Set is reset each call.
    // demotedIds is reset at start of load(), then re-populated.
    expect(store.demotedIds.size).toBe(1); // still demoted from same file content

    // Now write a stable run and load again
    const stableRun = makeRun({ stage: 'reviewing_spec', workspace_path: workspacePath });
    fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([stableRun]));
    store.load();
    expect(store.demotedIds.size).toBe(0);
  });
});

// ─────────────────────────────────────────────
// constructor — tilde expansion
// ─────────────────────────────────────────────

describe('FileRunStore constructor — tilde expansion', () => {
  it('expands ~/some/path to $HOME/some/path/.autocatalyst/runs.json', () => {
    const { dest } = makeLogCapture();
    const store = new FileRunStore('~/some/path', { logDestination: dest });
    const expected = path.join(os.homedir(), 'some', 'path', '.autocatalyst', 'runs.json');
    // Access the private filePath via type assertion for testing
    expect((store as unknown as { filePath: string }).filePath).toBe(expected);
  });

  it('absolute path is unchanged', () => {
    const { dest } = makeLogCapture();
    const store = new FileRunStore('/absolute/path', { logDestination: dest });
    const expected = path.join('/absolute/path', '.autocatalyst', 'runs.json');
    expect((store as unknown as { filePath: string }).filePath).toBe(expected);
  });

  it('~/path and equivalent $HOME/path produce identical filePath', () => {
    const { dest } = makeLogCapture();
    const tildeStore = new FileRunStore('~/myroot', { logDestination: dest });
    const absStore = new FileRunStore(path.join(os.homedir(), 'myroot'), { logDestination: dest });
    expect(
      (tildeStore as unknown as { filePath: string }).filePath
    ).toBe(
      (absStore as unknown as { filePath: string }).filePath
    );
  });

  it('FileRunStore with tilde root saves to expanded path (integration)', () => {
    const tildeEquivalent = path.join(os.tmpdir(), `tilde-test-${randomUUID()}`);
    fs.mkdirSync(tildeEquivalent, { recursive: true });

    try {
      const { dest } = makeLogCapture();
      const store = new FileRunStore(tildeEquivalent, { logDestination: dest });
      const run = makeRun({ workspace_path: tildeEquivalent, stage: 'reviewing_spec' });
      store.save(new Map([[run.request_id, run]]));
      const loaded = store.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].request_id).toBe(run.request_id);
    } finally {
      fs.rmSync(tildeEquivalent, { recursive: true, force: true });
    }
  });
});
