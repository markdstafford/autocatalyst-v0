import type pino from 'pino';
import type { ImplementationPlanningAgent } from '../../types/ai.js';
import type { ThreadMessage } from '../../types/events.js';
import type { ConversationRef } from '../../types/channel.js';
import type { Run, RunStage } from '../../types/runs.js';
import { requireArtifactRefs } from '../run-refs.js';

export interface PlanningHandlerDeps {
  planner: Pick<ImplementationPlanningAgent, 'plan'>;
  postMessage: (conversation: ConversationRef, text: string) => Promise<void>;
  transition: (run: Run, stage: RunStage) => void;
  failRun: (run: Run, conversation: ConversationRef, error: unknown) => Promise<void>;
  persist: () => void;
  logger: Pick<pino.Logger, 'info' | 'warn' | 'error'>;
}

export type PlanningResult =
  | { status: 'implementing'; plan_path: string }
  | { status: 'needs_input' }
  | { status: 'failed' };

export class PlanningHandler {
  constructor(private readonly deps: PlanningHandlerDeps) {}

  async handle(run: Run, feedback: ThreadMessage): Promise<PlanningResult> {
    const refs = requireArtifactRefs(run);
    if (!refs) {
      await this.deps.failRun(run, feedback.conversation, new Error('Run missing artifact local path or publisher ref for planning'));
      return { status: 'failed' };
    }

    const onProgress = (message: string): Promise<void> =>
      this.deps.postMessage(feedback.conversation, message).catch(err => {
        this.deps.logger.warn(
          { event: 'progress_failed', phase: 'planning', run_id: run.id, error: String(err) },
          'Failed to post planning progress update',
        );
      });

    this.deps.logger.info({ event: 'planning.started', run_id: run.id, request_id: run.request_id }, 'Implementation planning started');

    let result;
    try {
      result = await this.deps.planner.plan(
        refs.local_path,
        run.workspace_path,
        onProgress,
        { run_id: run.id, request_id: run.request_id },
      );
    } catch (err) {
      this.deps.logger.error({ event: 'planning.failed', run_id: run.id, request_id: run.request_id, error: String(err) }, 'Implementation planning failed');
      await this.deps.failRun(run, feedback.conversation, err);
      return { status: 'failed' };
    }

    if (result.status === 'needs_input') {
      this.deps.logger.info({ event: 'planning.needs_input', run_id: run.id, request_id: run.request_id }, 'Implementation planning needs input');
      try {
        await this.deps.postMessage(feedback.conversation, `I need input before planning implementation — ${result.question ?? 'please provide more context'}`);
      } catch (err) {
        this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post planning question');
      }
      this.deps.transition(run, 'awaiting_impl_input');
      return { status: 'needs_input' };
    }

    if (result.status === 'failed') {
      const err = new Error(result.error ?? 'Implementation planning failed');
      this.deps.logger.error({ event: 'planning.failed', run_id: run.id, request_id: run.request_id, error: err.message }, 'Implementation planning failed');
      await this.deps.failRun(run, feedback.conversation, err);
      return { status: 'failed' };
    }

    if (!result.plan_path) {
      const err = new Error('Implementation planning completed without a plan_path');
      this.deps.logger.error({ event: 'planning.failed', run_id: run.id, request_id: run.request_id, error: err.message }, 'Implementation planning returned malformed result');
      await this.deps.failRun(run, feedback.conversation, err);
      return { status: 'failed' };
    }

    run.implementation_plan_path = result.plan_path;
    this.deps.persist();
    this.deps.transition(run, 'implementing');
    this.deps.logger.info(
      { event: 'planning.completed', run_id: run.id, request_id: run.request_id, plan_path: result.plan_path },
      'Implementation planning completed',
    );
    return { status: 'implementing', plan_path: result.plan_path };
  }
}