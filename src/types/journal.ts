/**
 * Journal type contracts.
 *
 * - tokens: null means token usage was unavailable (not zero); the OpenAI Agent SDK may not
 *   provide token counts, so callers must treat null as "unknown" rather than "no tokens used".
 * - Raw counts only — pricing, usd conversion, and rate tables are intentionally out of scope.
 * - Session replay order: physical sessions.jsonl file order filtered by run_id is canonical.
 *   session_seq is best-effort and resets on process restart; do not rely on it for global ordering.
 * - Write failures are logged and must never fail an active run (best-effort writes).
 * - Schema importer for future versions is deferred; no migration utilities exist in v0.
 */
import type { AgentEffort, AgentThinking, AgentTaskKind, ImplementationReviewExchange, ImplementationReviewFindingCategory, ImplementationReviewFindingSeverity } from './ai.js';
import type { ConversationRef, MessageRef } from './channel.js';
import type { Intent } from './intent.js';
import type { Run, RunStage } from './runs.js';

export type JournalStream = 'messages' | 'sessions' | 'feedback' | 'run-events';
export const JOURNAL_STREAMS: JournalStream[] = ['messages', 'sessions', 'feedback', 'run-events'];

/** Raw token counts only. Pricing, usd, rate tables, and cost rollups are intentionally out of scope. */
export interface NormalizedTokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export type JournalRunnerName = 'anthropic_direct' | 'openai_direct' | 'anthropic_agent' | 'openai_agent';
export type JournalDirection = 'in' | 'out';
export type JournalClassificationStatus = 'classified' | 'defaulted' | 'failed' | 'not_applicable';
export type JournalSessionOutcome = 'ok' | 'failed' | 'incomplete';
export type JournalRunEventType = 'created' | 'transition' | 'pruned' | 'demoted';
export type JournalFeedbackTarget = 'artifact' | 'implementation';
export type JournalFeedbackDisposition = 'open' | 'addressed' | 'resolved' | 'wont_fix';
export type JournalFeedbackSeverity = ImplementationReviewFindingSeverity | 'info';
export type JournalFeedbackCategory = ImplementationReviewFindingCategory | 'human_feedback' | 'artifact_comment' | 'ai_review';

export interface JournalBaseRecord {
  seq: number;
  writer_id: string;
}

export interface JournalMessageRecord extends JournalBaseRecord {
  ts: string;
  conversation_id: string | null;
  topic_id: string | null;
  run_id: string | null;
  request_id: string | null;
  direction: JournalDirection;
  author_principal: string;
  content: string;
  intent: Intent | null;
  classification_status: JournalClassificationStatus;
  origin_message_id: string | null;
}

/**
 * Session replay order is the physical sessions.jsonl file order filtered by run_id.
 * session_seq is best-effort: it is in-memory and resets on process restart.
 * Importers must not use session_seq or ts_start for global ordering.
 */
export interface JournalSessionRecord extends JournalBaseRecord {
  session_seq: number;
  ts_start: string;
  ts_end: string;
  conversation_id: string | null;
  topic_id: string | null;
  run_id: string | null;
  request_id: string | null;
  phase: string | null;
  step: AgentTaskKind | string;
  role: string | null;
  round: number;
  gate: string | null;
  model: { provider: string; name: string | null };
  inference: { effort: AgentEffort | null; thinking: AgentThinking | null };
  /** null means token usage was unavailable (e.g. OpenAI Agent SDK did not provide counts), not zero. */
  tokens: NormalizedTokenUsage | null;
  assistant_turns: number | null;
  tool_calls: number | null;
  tool_results: number | null;
  outcome: JournalSessionOutcome;
  runner: JournalRunnerName;
}

export interface JournalFeedbackThreadItem {
  author_principal: string | null;
  ts: string | null;
  text: string;
}

export interface JournalFeedbackRecord extends JournalBaseRecord {
  id: string;
  ts_created: string;
  conversation_id: string | null;
  topic_id: string | null;
  run_id: string | null;
  request_id: string | null;
  target: JournalFeedbackTarget;
  gate: string | null;
  author_principal: string;
  text: string;
  anchor: unknown | null;
  severity: JournalFeedbackSeverity;
  category: JournalFeedbackCategory;
  disposition: JournalFeedbackDisposition;
  thread: JournalFeedbackThreadItem[];
}

export interface JournalRunEventRecord extends JournalBaseRecord {
  event_type: JournalRunEventType;
  ts: string;
  run_id: string;
  request_id: string;
  conversation_id: string | null;
  topic_id: string | null;
  from_stage: RunStage | null;
  to_stage: RunStage | null;
  attempt: number;
  intent: Run['intent'] | Intent | null;
  workspace_path: string | null;
  branch: string | null;
  artifact_ref: string | null;
  pr_url: string | null;
  issue: number | null;
}

/** Journal writers are best-effort; append failures are logged and must not fail active runs. */
export interface JournalWriter {
  append(stream: JournalStream, record: unknown): Promise<void>;
  appendSync?(stream: JournalStream, record: unknown): void;
  close?(): Promise<void>;
}

export class NoopJournalWriter implements JournalWriter {
  async append(_stream: JournalStream, _record: unknown): Promise<void> {}
  appendSync(_stream: JournalStream, _record: unknown): void {}
  async close(): Promise<void> {}
}

export function conversationId(conversation: ConversationRef | undefined): string | null {
  if (!conversation) return null;
  return `${conversation.provider}:${conversation.channel_id}:${conversation.conversation_id}`;
}

export function messageId(message: MessageRef | undefined): string | null {
  if (!message) return null;
  return `${message.provider}:${message.channel_id}:${message.conversation_id}:${message.message_id}`;
}

export function identityForRun(run: Pick<Run, 'id' | 'request_id' | 'conversation'>) {
  return { conversation_id: conversationId(run.conversation), topic_id: run.id, run_id: run.id, request_id: run.request_id };
}

export interface JournalReviewExchangeCapture {
  run: Run;
  exchange: ImplementationReviewExchange;
}
