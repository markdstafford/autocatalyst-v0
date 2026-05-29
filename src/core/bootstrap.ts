import type { Meter } from '@opentelemetry/api';
import type { LoadedConfig } from '../types/config.js';
import type { CommandRegistry } from '../types/commands.js';
import type { IntentClassifier } from '../types/intent.js';
import { CommandRegistryImpl } from './command-registry.js';
import { registerDefaultCommands } from './commands/registry-setup.js';
import { OrchestratorImpl, type OrchestratorDeps } from './orchestrator.js';
import { Service } from './service.js';

export interface BootstrapWorkflowRuntimeDeps extends Omit<OrchestratorDeps, 'commandRegistry'> {
  commandRegistry?: OrchestratorDeps['commandRegistry'];
  intentClassifier: IntentClassifier;
  isConnected: () => boolean;
  meter?: Meter;
  onStop?: () => Promise<void>;
  confirmationRegistry?: import('./command-confirmations.js').CommandConfirmationRegistry<import('./commands/prune-command.js').PruneConfirmationPayload>;
  workspacePruner?: import('./workspace-pruner.js').WorkspacePruner;
  threadPruner?: import('../types/thread-pruner.js').ThreadPruner;
  persist?: () => void;
  pruneLogger?: Pick<import('pino').Logger, 'info' | 'warn' | 'error'>;
}

export function bootstrapWorkflowRuntime(
  config: LoadedConfig,
  deps: BootstrapWorkflowRuntimeDeps,
): {
  commandRegistry: CommandRegistry;
  orchestrator: OrchestratorImpl;
  service: Service;
} {
  const commandRegistry = deps.commandRegistry ?? new CommandRegistryImpl();
  const orchestrator = new OrchestratorImpl(
    {
      ...deps,
      commandRegistry,
    },
    { meter: deps.meter },
  );

  // Build persist using the orchestrator's live runs map and the runStore from deps.
  // This is used by the prune command to save run state after modifying it directly.
  const persistFn: (() => void) | undefined = deps.persist ?? (
    deps.runStore ? () => deps.runStore!.save(orchestrator.getRuns()) : undefined
  );

  registerDefaultCommands(commandRegistry, {
    runs: orchestrator.getRuns(),
    cancelRun: requestId => orchestrator.cancelRun(requestId),
    getRunLogs: requestId => orchestrator.getRunLogs(requestId),
    isConnected: deps.isConnected,
    getActiveRunCount: () => orchestrator.getActiveRunCount(),
    intentClassifier: deps.intentClassifier,
    overrideRunStage: (requestId, stage) => orchestrator.overrideRunStage(requestId, stage),
    confirmationRegistry: deps.confirmationRegistry,
    workspacePruner: deps.workspacePruner,
    threadPruner: deps.threadPruner,
    channelRepoMap: deps.channelRepoMap,
    persist: persistFn,
    logger: deps.pruneLogger,
  });

  const service = new Service(config, { orchestrator, onStop: deps.onStop });
  return { commandRegistry, orchestrator, service };
}
