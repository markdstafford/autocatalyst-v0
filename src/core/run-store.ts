// src/core/run-store.ts
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'node:os';
import type pino from 'pino';
import { createLogger } from './logger.js';
import type { Run } from '../types/runs.js';
import { artifactKindForIntent } from '../types/artifact.js';

export interface RunStore {
  load(): Run[];
  save(runs: Map<string, Run>): void;
}

const STALE_STAGES = new Set(['intake', 'speccing', 'planning', 'implementing']);
const TERMINAL_STAGES = new Set(['done', 'failed']);

interface FileRunStoreOptions {
  logDestination?: pino.DestinationStream;
  legacyConversationFields?: LegacyConversationFields | LegacyConversationFields[];
}

interface LegacyConversationFields {
  provider: string;
  channelField: string;
  conversationField: string;
  messageField?: string;
}

export class FileRunStore implements RunStore {
  private readonly filePath: string;
  private readonly logger: pino.Logger;
  private readonly legacyConversationFields: LegacyConversationFields[];
  public demotedIds: Set<string> = new Set();

  constructor(workspaceRoot: string, options?: FileRunStoreOptions) {
    this.filePath = path.join(workspaceRoot.replace(/^~/, homedir()), '.autocatalyst', 'runs.json');
    this.logger = createLogger('run-store', { destination: options?.logDestination });
    this.legacyConversationFields = Array.isArray(options?.legacyConversationFields)
      ? options.legacyConversationFields
      : options?.legacyConversationFields
        ? [options.legacyConversationFields]
        : [];
  }

  load(): Run[] {
    this.demotedIds = new Set();

    // 1. File doesn't exist
    if (!fs.existsSync(this.filePath)) {
      this.logger.info({ event: 'run_store.loaded', total_loaded: 0, dropped_count: 0, demoted_count: 0 }, 'Run store loaded');
      return [];
    }

    // 2. Read + parse
    let raw: unknown;
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      raw = JSON.parse(content);
    } catch (err) {
      this.logger.error({ event: 'run_store.load_failed', error: String(err) }, 'Failed to read or parse runs file');
      return [];
    }

    // 3. Must be an array
    if (!Array.isArray(raw)) {
      this.logger.error({ event: 'run_store.load_failed', error: 'Runs file is not an array' }, 'Runs file contains non-array JSON');
      return [];
    }

    const runs = raw.map(run => migrateRun(run, this.legacyConversationFields)) as Run[];
    const kept: Run[] = [];
    let droppedCount = 0;
    let demotedCount = 0;

    for (const run of runs) {
      // 4. Drop runs with missing workspace (terminal runs are exempt — their workspace may be cleaned up)
      if (!TERMINAL_STAGES.has(run.stage) && (!run.workspace_path || !fs.existsSync(run.workspace_path))) {
        this.logger.warn({ event: 'run_store.run_dropped', request_id: run.request_id, workspace_path: run.workspace_path }, 'Dropping run with missing workspace_path');
        droppedCount++;
        continue;
      }

      // 5. Demote stale stages
      if (STALE_STAGES.has(run.stage)) {
        const fromStage = run.stage;
        run.stage = 'failed';
        run.updated_at = new Date().toISOString();
        this.demotedIds.add(run.request_id);
        demotedCount++;
        this.logger.info({ event: 'run_store.run_demoted', request_id: run.request_id, from_stage: fromStage, to_stage: 'failed' }, 'Demoted stale run to failed');
      }

      kept.push(run);
    }

    // 6. Log summary
    this.logger.info({ event: 'run_store.loaded', total_loaded: kept.length, dropped_count: droppedCount, demoted_count: demotedCount }, 'Run store loaded');

    return kept;
  }

  save(runs: Map<string, Run>): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify([...runs.values()], null, 2), 'utf-8');
      this.logger.debug({ event: 'run_store.saved', count: runs.size }, 'Run store saved');
    } catch (err) {
      this.logger.error({ event: 'run_store.save_failed', error: String(err) }, 'Failed to save runs file');
      // non-fatal — do not throw
    }
  }
}

function migrateRun(raw: unknown, legacyConversationFields: LegacyConversationFields[]): Run {
  const run = raw as Run & {
    review_artifact?: Run['artifact'];
    spec_path?: string;
    publisher_ref?: string;
  } & Record<string, unknown>;

  if (!run.artifact && run.review_artifact) {
    run.artifact = run.review_artifact;
  }

  if (!run.artifact && typeof run.spec_path === 'string') {
    const kind = artifactKindForIntent(run.intent) ?? 'feature_spec';
    run.artifact = {
      kind,
      local_path: run.spec_path,
      // Pre-refactor persisted refs had no provider metadata. Use an explicit
      // placeholder so migrated runs remain readable without guessing.
      published_ref: typeof run.publisher_ref === 'string'
        ? { provider: 'artifact_publisher', id: run.publisher_ref }
        : undefined,
      status: 'waiting_on_feedback',
    };
  }

  delete run.review_artifact;
  delete run.spec_path;
  delete run.publisher_ref;

  for (const fields of legacyConversationFields) {
    if (run.channel && run.conversation && run.origin) break;

    const channelId = stringField(run, fields.channelField);
    const conversationId = stringField(run, fields.conversationField);
    const messageId = stringField(run, fields.messageField ?? fields.conversationField);
    if (channelId && conversationId && messageId) {
      run.channel ??= { provider: fields.provider, id: channelId };
      run.conversation ??= { provider: fields.provider, channel_id: channelId, conversation_id: conversationId };
      run.origin ??= { provider: fields.provider, channel_id: channelId, conversation_id: conversationId, message_id: messageId };
    }
  }

  for (const fields of legacyConversationFields) {
    delete run[fields.channelField];
    delete run[fields.conversationField];
    if (fields.messageField) delete run[fields.messageField];
  }

  return run;
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' ? value : undefined;
}
