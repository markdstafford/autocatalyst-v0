import { describe, expect, it, vi } from 'vitest';
import { CommandRegistryImpl } from '../../../src/core/command-registry.js';
import { registerDefaultCommands } from '../../../src/core/commands/registry-setup.js';
import type { WorkspacePruner } from '../../../src/core/workspace-pruner.js';

describe('registerDefaultCommands', () => {
  it('registers the built-in run, health, help, and classify commands', () => {
    const registry = new CommandRegistryImpl();

    registerDefaultCommands(registry, {
      runs: new Map(),
      cancelRun: vi.fn(),
      getRunLogs: vi.fn().mockReturnValue([]),
      isConnected: vi.fn().mockReturnValue(true),
      getActiveRunCount: vi.fn().mockReturnValue(0),
      intentClassifier: { classify: vi.fn().mockResolvedValue('idea') },
      overrideRunStage: vi.fn(),
    });

    expect(registry.list()).toEqual(expect.arrayContaining([
      'run.status',
      'run.list',
      'run.cancel',
      'run.logs',
      'health',
      'help',
      'classify-intent',
      'run.set-status',
    ]));
  });

  it('registers prune and prune.confirm when prune deps are provided', () => {
    const registry = new CommandRegistryImpl();
    const mockRuns = new Map();
    const mockPersist = vi.fn();
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    registerDefaultCommands(registry, {
      runs: mockRuns,
      cancelRun: vi.fn(),
      getRunLogs: vi.fn().mockReturnValue([]),
      isConnected: vi.fn().mockReturnValue(true),
      getActiveRunCount: vi.fn().mockReturnValue(0),
      intentClassifier: { classify: vi.fn().mockResolvedValue('idea') },
      overrideRunStage: vi.fn(),
      confirmationRegistry: { create: vi.fn(), consume: vi.fn(), hasPending: vi.fn(), sweepExpired: vi.fn() },
      workspacePruner: { prune: vi.fn() } as unknown as WorkspacePruner,
      channelRepoMap: new Map(),
      persist: mockPersist,
      logger: mockLogger,
    });

    expect(registry.list()).toContain('prune');
    expect(registry.list()).toContain('prune.confirm');
  });
});
