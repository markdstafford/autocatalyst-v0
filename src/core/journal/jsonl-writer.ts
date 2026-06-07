import { mkdir, appendFile as fsAppendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type pino from 'pino';
import { createLogger } from '../logger.js';
import type { JournalStream, JournalWriter } from '../../types/journal.js';
import { JOURNAL_STREAMS } from '../../types/journal.js';
import { redactSecrets } from './redaction.js';

type AppendFileFn = (path: string, data: string, encoding: string) => Promise<void>;

export interface JsonlJournalWriterOptions {
  logger?: pino.Logger;
  appendFile?: AppendFileFn;
  writerId?: string;
}

/**
 * Append-only JSONL journal writer.
 *
 * - A new writer_id is generated on each process boot (randomUUID at construction time).
 * - seq resets to 0 on restart; importers must use physical file order, not seq alone,
 *   for global ordering across process restarts.
 * - Cross-process global sequence ordering is not required for v0.
 */
export class JsonlJournalWriter implements JournalWriter {
  private readonly journalDir: string;
  private readonly writer_id: string;
  private readonly logger: pino.Logger;
  private readonly appendFileFn: AppendFileFn;
  private readonly seq = new Map<JournalStream, number>();
  private readonly counts = new Map<JournalStream, number>();
  private readonly queues = new Map<JournalStream, Promise<void>>();

  constructor(workspaceRoot: string, options?: JsonlJournalWriterOptions) {
    this.journalDir = join(workspaceRoot, '.autocatalyst', 'journal');
    this.writer_id = options?.writerId ?? randomUUID();
    this.logger = options?.logger ?? createLogger('journal-writer');
    this.appendFileFn = options?.appendFile ?? ((path, data, enc) => fsAppendFile(path, data, enc as 'utf-8'));

    for (const stream of JOURNAL_STREAMS) {
      this.seq.set(stream, 0);
      this.counts.set(stream, 0);
      this.queues.set(stream, Promise.resolve());
    }

    this.logger.info({ event: 'journal.writer_started', journal_dir: this.journalDir }, 'Journal writer started');
  }

  async append(stream: JournalStream, record: unknown): Promise<void> {
    const enqueue = this.queues.get(stream)!.then(() => this.appendNow(stream, record));
    this.queues.set(stream, enqueue.catch(() => {}));
    return enqueue.catch(() => {});
  }

  private async appendNow(stream: JournalStream, record: unknown): Promise<void> {
    const seq = (this.seq.get(stream) ?? 0) + 1;
    this.seq.set(stream, seq);

    let payload: string;
    try {
      payload = JSON.stringify({ seq, writer_id: this.writer_id, ...(record as Record<string, unknown>) }) + '\n';
    } catch (err) {
      this.logger.warn(
        { event: 'journal.record_invalid', stream, seq, error: redactSecrets(String(err)) },
        'Journal record serialization failed',
      );
      return;
    }

    const tsStart = performance.now();
    try {
      await mkdir(this.journalDir, { recursive: true });
      await this.appendFileFn(join(this.journalDir, `${stream}.jsonl`), payload, 'utf-8');
      const duration_ms = Math.round(performance.now() - tsStart);
      this.counts.set(stream, (this.counts.get(stream) ?? 0) + 1);
      this.logger.debug({ event: 'journal.appended', stream, seq, duration_ms }, 'Journal record appended');
    } catch (err) {
      this.logger.warn(
        { event: 'journal.append_failed', stream, seq, error: redactSecrets(String(err)) },
        'Journal append failed',
      );
    }
  }

  appendSync(_stream: JournalStream, _record: unknown): void {
    // Sync file I/O would block the event loop; callers should use append() instead
  }

  async close(): Promise<void> {
    // Drain all per-stream queues before reporting counts
    await Promise.allSettled([...this.queues.values()]);
    const countSummary = Object.fromEntries(this.counts.entries());
    this.logger.info({ event: 'journal.closed', counts: countSummary }, 'Journal writer closed');
  }
}
