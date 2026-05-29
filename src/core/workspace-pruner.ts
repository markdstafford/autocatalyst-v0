import path from 'node:path';
import { homedir } from 'node:os';
import { rm, stat } from 'node:fs/promises';
import type pino from 'pino';
import { createLogger } from './logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkspacePathGuardResult {
  root: string;
  workspace_path: string;
}

export class WorkspacePathGuardError extends Error {
  readonly code = 'WORKSPACE_PATH_REJECTED' as const;
  readonly context: Record<string, string>;

  constructor(message: string, context: Record<string, string>) {
    super(message);
    this.name = 'WorkspacePathGuardError';
    this.context = context;
  }
}

export type WorkspacePruneMode = 'manual' | 'auto';

export type WorkspacePruneResult =
  | { status: 'deleted'; workspace_path: string; workspace_root: string }
  | { status: 'missing'; workspace_path: string; workspace_root: string }
  | { status: 'skipped'; reason: 'empty_workspace_path' }
  | { status: 'rejected'; error: WorkspacePathGuardError }
  | { status: 'failed'; workspace_path: string; workspace_root: string; error: unknown };

export interface WorkspacePruneRequest {
  run_id: string;
  request_id: string;
  workspace_root: string;
  workspace_path: string;
  mode: WorkspacePruneMode;
  allowEmpty?: boolean;
}

// ─── assertDirectWorkspaceChild ───────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return homedir() + p.slice(1);
  }
  return p;
}

export function assertDirectWorkspaceChild(
  workspaceRoot: string,
  workspacePath: string,
): WorkspacePathGuardResult {
  if (!workspacePath || !workspacePath.trim()) {
    throw new WorkspacePathGuardError('workspace_path must not be empty', {
      workspace_root: workspaceRoot,
      workspace_path: workspacePath,
    });
  }

  const resolvedRoot = path.resolve(expandHome(workspaceRoot));
  const resolvedWorkspacePath = path.resolve(expandHome(workspacePath));

  if (resolvedWorkspacePath === resolvedRoot) {
    throw new WorkspacePathGuardError(
      'workspace_path must not equal workspace_root',
      { workspace_root: resolvedRoot, workspace_path: resolvedWorkspacePath },
    );
  }

  if (path.dirname(resolvedWorkspacePath) !== resolvedRoot) {
    throw new WorkspacePathGuardError(
      'workspace_path must be a direct child of workspace_root',
      { workspace_root: resolvedRoot, workspace_path: resolvedWorkspacePath },
    );
  }

  return { root: resolvedRoot, workspace_path: resolvedWorkspacePath };
}

// ─── WorkspacePruner ──────────────────────────────────────────────────────────

interface WorkspacePrunerOptions {
  logDestination?: pino.DestinationStream;
  rmFn?: typeof rm;
  statFn?: typeof stat;
}

export class WorkspacePruner {
  private readonly log: pino.Logger;
  private readonly rmFn: typeof rm;
  private readonly statFn: typeof stat;

  constructor(options?: WorkspacePrunerOptions) {
    this.log = createLogger('workspace-pruner', {
      destination: options?.logDestination,
    });
    this.rmFn = options?.rmFn ?? rm;
    this.statFn = options?.statFn ?? stat;
  }

  async prune(request: WorkspacePruneRequest): Promise<WorkspacePruneResult> {
    const { run_id, request_id, workspace_root, workspace_path, mode, allowEmpty } = request;

    // Handle empty workspace path
    if ((!workspace_path || !workspace_path.trim()) && allowEmpty) {
      return { status: 'skipped', reason: 'empty_workspace_path' };
    }

    // Guard check
    let guardResult: WorkspacePathGuardResult;
    try {
      guardResult = assertDirectWorkspaceChild(workspace_root, workspace_path);
    } catch (err) {
      if (err instanceof WorkspacePathGuardError) {
        this.log.warn(
          { event: 'workspace.prune_rejected', run_id, request_id, mode, ...err.context },
          'workspace prune rejected by path guard',
        );
        return { status: 'rejected', error: err };
      }
      throw err;
    }

    const { root: resolvedRoot, workspace_path: resolvedPath } = guardResult;

    this.log.info(
      { event: 'workspace.prune_started', run_id, request_id, mode, workspace_root: resolvedRoot, workspace_path: resolvedPath },
      'workspace prune started',
    );

    const startedAt = Date.now();

    try {
      // Check existence first so missing workspaces return 'missing' rather than
      // silently succeeding as 'deleted' (force:true makes rm indistinguishable).
      try {
        await this.statFn(resolvedPath);
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code === 'ENOENT') {
          const duration_ms = Date.now() - startedAt;
          this.log.info(
            { event: 'workspace.pruned', run_id, request_id, mode, workspace_root: resolvedRoot, workspace_path: resolvedPath, duration_ms, missing: true },
            'workspace already missing',
          );
          return { status: 'missing', workspace_path: resolvedPath, workspace_root: resolvedRoot };
        }
        throw statErr;
      }

      await this.rmFn(resolvedPath, { recursive: true, force: true });
      const duration_ms = Date.now() - startedAt;

      this.log.info(
        { event: 'workspace.pruned', run_id, request_id, mode, workspace_root: resolvedRoot, workspace_path: resolvedPath, duration_ms },
        'workspace pruned',
      );

      return { status: 'deleted', workspace_path: resolvedPath, workspace_root: resolvedRoot };
    } catch (error) {
      const duration_ms = Date.now() - startedAt;

      this.log.error(
        { event: 'workspace.prune_failed', run_id, request_id, mode, workspace_root: resolvedRoot, workspace_path: resolvedPath, duration_ms, error },
        'workspace prune failed',
      );

      return { status: 'failed', workspace_path: resolvedPath, workspace_root: resolvedRoot, error };
    }
  }
}
