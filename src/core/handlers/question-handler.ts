import type pino from 'pino';
import type { QuestionAnsweringAgent, AgentSessionCaptureFn } from '../../types/ai.js';
import type { Run } from '../../types/runs.js';
import type { ConversationRef } from '../../types/channel.js';
import { isAiActiveStage, makeRunAgentRequestRecorder } from '../run-ai-context.js';
import type { RunJournal } from '../journal/run-journal.js';

export interface QuestionDeps {
  questionAnswerer?: Pick<QuestionAnsweringAgent, 'answer'>;
  postMessage: (conversation: ConversationRef, text: string) => Promise<void>;
  postError: (conversation: ConversationRef, text: string) => Promise<void>;
  persist?: () => void;
  logger: Pick<pino.Logger, 'info' | 'error'>;
  journal?: Pick<RunJournal, 'captureSession'>;
}

export interface QuestionResult {
  status: 'answered' | 'unavailable' | 'not_configured';
}

const QUESTION_UNAVAILABLE_MESSAGE =
  'I could not answer that question because the AI service is unavailable. Please try again shortly.';

export class QuestionHandler {
  constructor(private readonly deps: QuestionDeps) {}

  async handle(content: string, conversation: ConversationRef, run: Run): Promise<QuestionResult> {
    this.deps.logger.info({ event: 'question.received', run_id: run.id, request_id: run.request_id }, 'Question received');

    const onAgentRequest = (this.deps.persist && isAiActiveStage(run.stage))
      ? makeRunAgentRequestRecorder(run, this.deps.persist, this.deps.logger)
      : undefined;

    let response: string;
    if (this.deps.questionAnswerer) {
      const captureSession: AgentSessionCaptureFn | undefined = this.deps.journal
        ? (data) => { void this.deps.journal!.captureSession({ ...data, run, round: 1 }).catch(() => {}); }
        : undefined;
      try {
        response = await this.deps.questionAnswerer.answer(content, { run_id: run.id, request_id: run.request_id, onAgentRequest, captureSession });
      } catch (err) {
        this.deps.logger.error({ event: 'question.answer_failed', run_id: run.id, error: String(err) }, 'Failed to answer question');
        await this.deps.postError(conversation, QUESTION_UNAVAILABLE_MESSAGE);
        return { status: 'unavailable' };
      }
    } else {
      response = "I've noted your question \u2014 question answering is coming soon.";
    }

    try {
      await this.deps.postMessage(conversation, response);
    } catch (err) {
      this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post question response');
    }
    return { status: this.deps.questionAnswerer ? 'answered' : 'not_configured' };
  }
}
