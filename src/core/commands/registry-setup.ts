import type { CommandRegistry } from '../../types/commands.js';
import type { Run, RunStage } from '../../types/runs.js';
import type { IntentClassifier } from '../../types/intent.js';
import type { ChannelRepoMap } from '../../types/config.js';
import type { CommandConfirmationRegistry } from '../command-confirmations.js';
import type { PruneConfirmationPayload } from './prune-command.js';
import type { WorkspacePruner } from '../workspace-pruner.js';
import type { ThreadPruner } from '../../types/thread-pruner.js';
import type pino from 'pino';
import { makeClassifyIntentHandler } from './classify-intent-command.js';
import { makeHealthHandler, makeHelpHandler } from './meta-commands.js';
import {
  makeRunCancelHandler,
  makeRunListHandler,
  makeRunLogsHandler,
  makeRunStatusHandler,
} from './run-commands.js';
import { createSetStatusHandler } from './set-status-command.js';
import { makePruneHandler, makePruneConfirmHandler } from './prune-command.js';

export interface DefaultCommandDeps {
  runs: Map<string, Run>;
  cancelRun: (requestId: string) => 'cancelled' | 'already_terminal' | 'not_found';
  getRunLogs: (requestId: string) => string[];
  isConnected: () => boolean;
  getActiveRunCount: () => number;
  intentClassifier: IntentClassifier;
  overrideRunStage: (requestId: string, stage: RunStage) => 'updated' | 'not_found' | 'invalid_stage';
  confirmationRegistry?: CommandConfirmationRegistry<PruneConfirmationPayload>;
  workspacePruner?: WorkspacePruner;
  threadPruner?: ThreadPruner;
  channelRepoMap?: ChannelRepoMap;
  persist?: () => void;
  logger?: Pick<pino.Logger, 'info' | 'warn' | 'error'>;
}

export function registerDefaultCommands(registry: CommandRegistry, deps: DefaultCommandDeps): void {
  registry.register(
    'run.status',
    makeRunStatusHandler(deps.runs),
    'Show the current stage, intent, and time in stage for a run. Usage: `:ac-run-status:` (in thread) or `:ac-run-status: <run-id>`',
  );
  registry.register(
    'run.list',
    makeRunListHandler(deps.runs),
    'List all active runs. Usage: `:ac-run-list:`',
  );
  registry.register(
    'run.cancel',
    makeRunCancelHandler(deps.runs, deps.cancelRun),
    'Cancel an active run. Usage: `:ac-run-cancel:` (in thread) or `:ac-run-cancel: <run-id>`',
  );
  registry.register(
    'run.logs',
    makeRunLogsHandler(deps.runs, deps.getRunLogs),
    'Show the log tail for a run. Usage: `:ac-run-logs:` (in thread) or `:ac-run-logs: <run-id>`',
  );
  registry.register(
    'health',
    makeHealthHandler(deps.isConnected, deps.getActiveRunCount),
    'Check system health and active run count. Usage: `:ac-health:`',
  );
  registry.register(
    'help',
    makeHelpHandler(registry),
    'Show available commands. Usage: `:ac-help:` or `:ac-help: <command>`',
  );
  registry.register(
    'classify-intent',
    makeClassifyIntentHandler(deps.intentClassifier),
    'Test how a message would be classified. Usage: `:ac-classify-intent: <message>` or `:ac-classify-intent: <context> <message>`',
  );
  registry.register(
    'run.set-status',
    createSetStatusHandler({
      findRunById: (requestId: string) => deps.runs.get(requestId),
      overrideRunStage: deps.overrideRunStage,
    }),
    "Override a stuck run's stage. Usage: reply with `:ac-set-status: <stage>` in a run thread. E.g. `:ac-set-status: reviewing_implementation`",
  );

  // Only register prune commands when all required dependencies are provided
  if (deps.confirmationRegistry && deps.workspacePruner && deps.channelRepoMap && deps.persist && deps.logger) {
    const pruneDeps: import('./prune-command.js').PruneCommandDeps = {
      runs: deps.runs,
      confirmationRegistry: deps.confirmationRegistry,
      workspacePruner: deps.workspacePruner,
      threadPruner: deps.threadPruner,
      channelRepoMap: deps.channelRepoMap,
      persist: deps.persist,
      logger: deps.logger,
    };
    registry.register('prune', makePruneHandler(pruneDeps), 'Preview and confirm destructive run cleanup. Usage: `:ac-prune: completed` or `:ac-prune: <run-id> [...] [--active]`');
    registry.register('prune.confirm', makePruneConfirmHandler(pruneDeps), 'Internal confirmation handler for pending prune operations. Reply exactly `Yes` in the prune preview thread.');
  }
}
