#!/usr/bin/env node

import { parseArgs, printUsage } from './core/cli.js';
import { loadConfig, redactConfig, resolveEnvVars } from './core/config.js';
import { runInit, configExists } from './core/init.js';
import { ConfigWatcher } from './core/config-watcher.js';
import { registerSignalHandlers } from './core/signals.js';
import { createLogger } from './core/logger.js';
import { composeWorkflowRuntime } from './core/runtime-composition.js';
import { initTelemetry } from './core/telemetry.js';
import { join } from 'node:path';

let telemetry = initTelemetry();
const logger = createLogger('cli', { loggerProvider: telemetry.loggerProvider });

try {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    await telemetry.shutdown();
    process.exit(0);
  }

  if (args.command === 'init') {
    const repoPath = args.repoPath || process.cwd();
    await runInit(repoPath);
    await telemetry.shutdown();
    process.exit(0);
  }

  // run command — repoPath(s) validated by parseArgs
  const repoPaths = args.repoPaths;
  const repoPath = repoPaths[0];
  const isMultiRepo = repoPaths.length > 1;

  logger.info(
    { event: 'service.starting', mode: isMultiRepo ? 'multi-repo' : 'single-repo', ...(isMultiRepo ? { channel_count: repoPaths.length } : {}) },
    'Starting Autocatalyst',
  );

  // Init always runs before service startup
  await runInit(repoPath);

  if (!configExists(repoPath)) {
    logger.error(
      { event: 'service.init_incomplete' },
      'Config is not set up. Run `autocatalyst init --repo <path>` to initialize.',
    );
    await telemetry.shutdown();
    process.exit(1);
  }

  const configPath = join(repoPath, 'autocatalyst.yaml');
  let currentConfig = loadConfig(configPath, process.env as Record<string, string>);

  const { resolved: _resolved, missing } = resolveEnvVars(
    currentConfig.config as Record<string, unknown>,
    process.env as Record<string, string>,
  );

  if (missing.length > 0) {
    logger.warn({ event: 'config.env_missing', missing }, `Missing environment variables: ${missing.join(', ')}`);
    await telemetry.shutdown();
    process.exit(1);
  }

  const redacted = redactConfig(
    currentConfig.config as Record<string, unknown>,
    Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]
    ),
  );
  logger.info({ event: 'config.loaded', config: redacted }, 'Configuration loaded');

  // Re-init telemetry now that config is available; config values take precedence over env vars
  if (currentConfig.config.telemetry) {
    await telemetry.shutdown();
    telemetry = initTelemetry(currentConfig.config.telemetry);
  }

  const { service } = await composeWorkflowRuntime({
    currentConfig,
    repoPath,
    repoPaths,
    env: process.env as Record<string, string | undefined>,
    logger,
    meter: telemetry.meter,
    loggerProvider: telemetry.loggerProvider,
    logRequests: args.logRequests,
  });

  const cleanupSignals = registerSignalHandlers(service);

  const watcher = new ConfigWatcher(configPath, {
    onReload: () => {
      try {
        const newConfig = loadConfig(configPath, process.env as Record<string, string>);
        const changedKeys = Object.keys(newConfig.config).filter(
          k => JSON.stringify(newConfig.config[k]) !== JSON.stringify(currentConfig.config[k]),
        );
        currentConfig = newConfig;
        service.updateConfig(newConfig);
        logger.info({ event: 'config.reloaded', changed_keys: changedKeys }, 'Configuration reloaded');
      } catch (err) {
        logger.warn({ event: 'config.reload_failed', error: String(err) }, 'Config reload failed, keeping current config');
      }
    },
  });
  watcher.start();

  service.start();

  service.stopped.then(async () => {
    watcher.stop();
    cleanupSignals();
    await telemetry.shutdown();
    process.exit(0);
  });
} catch (err) {
  logger.error({ event: 'config.parse_error', error: String(err) }, String(err));
  await telemetry.shutdown();
  process.exit(1);
}
