import { randomUUID } from 'node:crypto';

export interface ReserveModelSessionInput {
  gate: string;
  role: 'proposer' | 'critic' | string;
  round: number;
  passKind: 'initial' | 'feedback' | 'final';
}

export interface ReservationResult {
  session_id: string;
  used: number;
  limit: number;
}

export interface BudgetWriter {
  append(stream: string, record: unknown): Promise<void>;
}

interface ModelSessionBudgetOptions {
  runId: string;
  requestId: string;
  limit: number;
  writer: BudgetWriter;
}

export class ModelSessionBudget {
  private readonly runId: string;
  private readonly requestId: string;
  private readonly _limit: number;
  private readonly writer: BudgetWriter;
  private reservedIds = new Set<string>();
  private seq = 0;

  constructor(options: ModelSessionBudgetOptions) {
    this.runId = options.runId;
    this.requestId = options.requestId;
    this._limit = options.limit;
    this.writer = options.writer;
  }

  async reserve(input: ReserveModelSessionInput): Promise<ReservationResult> {
    if (this.reservedIds.size >= this._limit) {
      throw new Error(`Model-session budget exhausted for run ${this.runId}: used ${this.reservedIds.size} of ${this._limit}`);
    }
    const session_id = randomUUID();
    this.seq++;
    await this.writer.append('sessions', {
      record_kind: 'model_session_reserved',
      session_id,
      run_id: this.runId,
      request_id: this.requestId,
      gate: input.gate,
      role: input.role,
      round: input.round,
      pass_kind: input.passKind,
      reservation_seq: this.seq,
      budget_limit: this._limit,
      timestamp: new Date().toISOString(),
    });
    this.reservedIds.add(session_id);
    return { session_id, used: this.reservedIds.size, limit: this._limit };
  }

  async complete(sessionId: string, outcome: 'ok' | 'failed' | 'incomplete'): Promise<void> {
    await this.writer.append('sessions', {
      record_kind: 'model_session_completed',
      session_id: sessionId,
      run_id: this.runId,
      outcome,
      timestamp: new Date().toISOString(),
    });
  }

  used(): number {
    return this.reservedIds.size;
  }

  limit(): number {
    return this._limit;
  }

  static fromSessionRecords(args: {
    runId: string;
    requestId: string;
    limit: number;
    records: unknown[];
  }): ModelSessionBudget {
    const budget = new ModelSessionBudget({
      runId: args.runId,
      requestId: args.requestId,
      limit: args.limit,
      writer: { append: async () => {} },
    });
    for (const record of args.records) {
      if (
        typeof record === 'object' &&
        record !== null &&
        (record as Record<string, unknown>)['record_kind'] === 'model_session_reserved' &&
        typeof (record as Record<string, unknown>)['session_id'] === 'string'
      ) {
        budget.reservedIds.add((record as Record<string, unknown>)['session_id'] as string);
      }
    }
    return budget;
  }
}
