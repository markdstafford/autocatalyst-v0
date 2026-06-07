import type {
  JournalWriter,
  JournalMessageRecord,
  JournalSessionRecord,
  JournalFeedbackRecord,
  JournalRunEventRecord,
  NormalizedTokenUsage,
  JournalRunnerName,
  JournalClassificationStatus,
  JournalFeedbackTarget,
  JournalFeedbackCategory,
  JournalFeedbackDisposition,
  JournalFeedbackSeverity,
  JournalSessionOutcome,
} from '../../types/journal.js';
import { identityForRun, messageId } from '../../types/journal.js';
import { redactSecrets } from './redaction.js';
import type { Run, RunStage } from '../../types/runs.js';
import type { Intent } from '../../types/intent.js';
import type { AgentEffort, AgentThinking, AgentTaskKind } from '../../types/ai.js';
import { createLogger } from '../logger.js';

const logger = createLogger('run-journal');

export interface CaptureSessionParams {
  run: Run;
  ts_start: string;
  ts_end: string;
  phase?: string | null;
  step: AgentTaskKind | string;
  round: number;
  model: { provider: string; name: string | null };
  inference: { effort: AgentEffort | null; thinking: AgentThinking | null };
  tokens?: NormalizedTokenUsage | null;
  assistant_turns?: number | null;
  tool_calls?: number | null;
  tool_results?: number | null;
  outcome: JournalSessionOutcome;
  runner: JournalRunnerName;
}

export interface CaptureFeedbackParams {
  id: string;
  run: Run;
  target: JournalFeedbackTarget;
  author_principal: string;
  text: string;
  severity: JournalFeedbackSeverity;
  category: JournalFeedbackCategory;
  disposition?: JournalFeedbackDisposition;
  thread?: Array<{ author_principal: string | null; ts: string | null; text: string }>;
  received_at?: string;
}

export class RunJournal {
  private readonly writer: JournalWriter;
  /**
   * In-memory, process-local counter keyed by run_id.
   * Resets to 0 on process restart — the Map is not persisted.
   * Importers must use sessions.jsonl file order filtered by run_id, not session_seq or ts_start.
   */
  private readonly sessionSeq = new Map<string, number>();

  constructor(writer: JournalWriter) {
    this.writer = writer;
  }

  async captureInboundMessage(
    run: Run,
    message: { content: string; received_at?: string },
    intent: Intent | null,
    classificationStatus: JournalClassificationStatus,
  ): Promise<void> {
    const identity = identityForRun(run);
    const authorPrincipal = `${run.conversation?.provider ?? 'unknown'}:${run.origin?.message_id ?? 'unknown'}`;
    const ts = message.received_at ?? new Date().toISOString();

    const record: Omit<JournalMessageRecord, 'seq' | 'writer_id'> = {
      ts,
      conversation_id: identity.conversation_id,
      topic_id: identity.topic_id,
      run_id: identity.run_id,
      request_id: identity.request_id,
      direction: 'in',
      author_principal: authorPrincipal,
      content: redactSecrets(message.content),
      intent,
      classification_status: classificationStatus,
      origin_message_id: messageId(run.origin),
    };

    try {
      await this.writer.append('messages', record);
    } catch (err) {
      logger.warn({ event: 'run_journal.capture_failed', stream: 'messages', direction: 'in', error: String(err) }, 'Failed to capture inbound message');
    }
  }

  async captureOutboundMessage(run: Run, text: string, originMessageId?: string | null): Promise<void> {
    const identity = identityForRun(run);

    const record: Omit<JournalMessageRecord, 'seq' | 'writer_id'> = {
      ts: new Date().toISOString(),
      conversation_id: identity.conversation_id,
      topic_id: identity.topic_id,
      run_id: identity.run_id,
      request_id: identity.request_id,
      direction: 'out',
      author_principal: 'autocatalyst',
      content: redactSecrets(text),
      intent: null,
      classification_status: 'not_applicable',
      origin_message_id: originMessageId ?? null,
    };

    try {
      await this.writer.append('messages', record);
    } catch (err) {
      logger.warn({ event: 'run_journal.capture_failed', stream: 'messages', direction: 'out', error: String(err) }, 'Failed to capture outbound message');
    }
  }

  async captureSession(params: CaptureSessionParams): Promise<void> {
    const { run, ts_start, ts_end, phase, step, round, model, inference, tokens, assistant_turns, tool_calls, tool_results, outcome, runner } = params;
    const identity = identityForRun(run);

    const runId = run.id;
    const currentSeq = this.sessionSeq.get(runId) ?? 0;
    const nextSeq = currentSeq + 1;
    this.sessionSeq.set(runId, nextSeq);

    const record: Omit<JournalSessionRecord, 'seq' | 'writer_id'> = {
      session_seq: nextSeq,
      ts_start,
      ts_end,
      conversation_id: identity.conversation_id,
      topic_id: identity.topic_id,
      run_id: identity.run_id,
      request_id: identity.request_id,
      phase: phase ?? null,
      step,
      role: null,
      round,
      gate: null,
      model,
      inference,
      tokens: tokens ?? null,
      assistant_turns: assistant_turns ?? null,
      tool_calls: tool_calls ?? null,
      tool_results: tool_results ?? null,
      outcome,
      runner,
    };

    try {
      await this.writer.append('sessions', record);
    } catch (err) {
      logger.warn({ event: 'run_journal.capture_failed', stream: 'sessions', run_id: runId, error: String(err) }, 'Failed to capture session');
    }
  }

  async captureFeedback(params: CaptureFeedbackParams): Promise<void> {
    const { id, run, target, author_principal, text, severity, category, disposition = 'open', thread = [], received_at } = params;
    const identity = identityForRun(run);

    const record: Omit<JournalFeedbackRecord, 'seq' | 'writer_id'> = {
      id,
      ts_created: received_at ?? new Date().toISOString(),
      conversation_id: identity.conversation_id,
      topic_id: identity.topic_id,
      run_id: identity.run_id,
      request_id: identity.request_id,
      target,
      gate: null,
      author_principal,
      text: redactSecrets(text),
      anchor: null,
      severity,
      category,
      disposition,
      thread: thread.map((item) => ({
        author_principal: item.author_principal,
        ts: item.ts,
        text: redactSecrets(item.text),
      })),
    };

    try {
      await this.writer.append('feedback', record);
    } catch (err) {
      logger.warn({ event: 'run_journal.capture_failed', stream: 'feedback', id, error: String(err) }, 'Failed to capture feedback');
    }
  }

  async captureRunEvent(
    run: Run,
    eventType: 'created' | 'transition' | 'pruned' | 'demoted',
    fromStage?: RunStage | null,
    toStage?: RunStage | null,
  ): Promise<void> {
    const identity = identityForRun(run);

    let resolvedFromStage: RunStage | null;
    let resolvedToStage: RunStage | null;

    if (eventType === 'created') {
      resolvedFromStage = null;
      resolvedToStage = 'intake';
    } else if (eventType === 'pruned') {
      resolvedFromStage = fromStage ?? run.stage;
      resolvedToStage = null;
    } else if (eventType === 'demoted') {
      resolvedFromStage = fromStage ?? run.stage;
      resolvedToStage = 'failed';
    } else {
      // transition
      resolvedFromStage = fromStage ?? null;
      resolvedToStage = toStage ?? null;
    }

    const record: Omit<JournalRunEventRecord, 'seq' | 'writer_id'> = {
      event_type: eventType,
      ts: new Date().toISOString(),
      run_id: run.id,
      request_id: run.request_id,
      conversation_id: identity.conversation_id,
      topic_id: identity.topic_id,
      from_stage: resolvedFromStage,
      to_stage: resolvedToStage,
      attempt: run.attempt,
      intent: run.intent,
      workspace_path: run.workspace_path,
      branch: run.branch,
      artifact_ref: null,
      pr_url: run.pr_url ?? null,
      issue: run.issue ?? null,
    };

    try {
      await this.writer.append('run-events', record);
    } catch (err) {
      logger.warn({ event: 'run_journal.capture_failed', stream: 'run-events', event_type: eventType, run_id: run.id, error: String(err) }, 'Failed to capture run event');
    }
  }
}
