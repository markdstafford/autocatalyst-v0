import { describe, expect, it } from 'vitest';
import { ModelSessionBudget } from '../../../src/core/journal/model-session-budget.js';

function writer() {
  const records: unknown[] = [];
  return {
    records,
    append: async (_stream: string, record: unknown) => {
      records.push(record);
    },
  };
}

describe('ModelSessionBudget', () => {
  it('reserves before provider calls and tracks usage', async () => {
    const w = writer();
    const budget = new ModelSessionBudget({ runId: 'run-1', requestId: 'req-1', limit: 3, writer: w });

    const first = await budget.reserve({ gate: 'layout', role: 'proposer', round: 1, passKind: 'initial' });
    expect(budget.used()).toBe(1);
    expect(first.session_id).toBeTruthy();
    expect(first.used).toBe(1);
    expect(first.limit).toBe(3);
  });

  it('exhausts budget and throws before making another reservation', async () => {
    const w = writer();
    const budget = new ModelSessionBudget({ runId: 'run-1', requestId: 'req-1', limit: 2, writer: w });

    await budget.reserve({ gate: 'layout', role: 'proposer', round: 1, passKind: 'initial' });
    await budget.reserve({ gate: 'layout', role: 'critic', round: 1, passKind: 'initial' });

    expect(budget.used()).toBe(2);
    await expect(
      budget.reserve({ gate: 'public_api', role: 'proposer', round: 1, passKind: 'initial' })
    ).rejects.toThrow('Model-session budget exhausted for run run-1: used 2 of 2');
  });

  it('reconstructs consumed budget from session records by stable session_id', async () => {
    const w = writer();
    const budget = new ModelSessionBudget({ runId: 'run-1', requestId: 'req-1', limit: 2, writer: w });

    const first = await budget.reserve({ gate: 'layout', role: 'proposer', round: 1, passKind: 'initial' });
    await budget.complete(first.session_id, 'ok');
    await budget.reserve({ gate: 'layout', role: 'critic', round: 1, passKind: 'initial' });

    expect(budget.used()).toBe(2);

    const replayed = ModelSessionBudget.fromSessionRecords({
      runId: 'run-1',
      requestId: 'req-1',
      limit: 2,
      records: w.records,
    });
    expect(replayed.used()).toBe(2);
  });

  it('counts reserved-but-incomplete calls (crash safety)', async () => {
    const w = writer();
    const budget = new ModelSessionBudget({ runId: 'run-1', requestId: 'req-1', limit: 2, writer: w });

    await budget.reserve({ gate: 'layout', role: 'proposer', round: 1, passKind: 'initial' });
    // No complete() call — simulates a crash before completion

    const replayed = ModelSessionBudget.fromSessionRecords({
      runId: 'run-1',
      requestId: 'req-1',
      limit: 2,
      records: w.records,
    });
    expect(replayed.used()).toBe(1);
  });

  it('does not double-count if same session_id appears multiple times', async () => {
    const fakeReservedRecord = {
      record_kind: 'model_session_reserved',
      session_id: 'stable-id-1',
    };
    const replayed = ModelSessionBudget.fromSessionRecords({
      runId: 'run-1',
      requestId: 'req-1',
      limit: 10,
      records: [fakeReservedRecord, fakeReservedRecord],
    });
    expect(replayed.used()).toBe(1);
  });
});
