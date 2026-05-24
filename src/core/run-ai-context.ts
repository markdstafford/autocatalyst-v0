import type pino from 'pino';
import type { AgentInvocationMetadata } from '../types/ai.js';
import type { Run, RunStage } from '../types/runs.js';

export const AI_ACTIVE_STAGES: ReadonlySet<RunStage> = new Set([
  'speccing',
  'planning',
  'implementing',
]);

export function isAiActiveStage(stage: RunStage): boolean {
  return AI_ACTIVE_STAGES.has(stage);
}

export function recordAgentRequest(run: Run, model: string | undefined, now = new Date()): void {
  run.current_model = model?.trim() || 'unknown';
  run.last_agent_request_at = now.toISOString();
}

export function clearAgentRequestContext(run: Run): void {
  delete run.current_model;
  delete run.last_agent_request_at;
}

export function makeRunAgentRequestRecorder(
  run: Run,
  persist: () => void,
  logger: Pick<pino.Logger, 'info'>,
): (metadata: AgentInvocationMetadata) => void {
  return metadata => {
    run.current_model = metadata.model?.trim() || 'unknown';
    run.last_agent_request_at = metadata.requested_at;
    persist();
    logger.info(
      {
        event: 'run.agent_request_recorded',
        run_id: run.id,
        request_id: run.request_id,
        model: run.current_model,
        route_task: metadata.route.task,
        ...(metadata.route.stage ? { route_stage: metadata.route.stage } : {}),
        ...(metadata.route.intent ? { route_intent: metadata.route.intent } : {}),
      },
      'Agent request metadata recorded',
    );
  };
}
