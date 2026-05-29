import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type pino from 'pino';
import {
  assertDirectWorkspaceChild,
  WorkspacePathGuardError,
  WorkspacePruner,
} from '../../src/core/workspace-pruner.js';
import type { WorkspacePruneRequest } from '../../src/core/workspace-pruner.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pruner-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ─── assertDirectWorkspaceChild ───────────────────────────────────────────────

describe('assertDirectWorkspaceChild', () => {
  it('accepts a direct child of the root', () => {
    const result = assertDirectWorkspaceChild(root, join(root, 'request-001'));
    expect(result.root).toBe(root);
    expect(result.workspace_path).toBe(join(root, 'request-001'));
  });

  it('rejects the root itself', () => {
    expect(() => assertDirectWorkspaceChild(root, root)).toThrow(WorkspacePathGuardError);
  });

  it('rejects a sibling path (different root)', () => {
    const sibling = join(root, '..', 'other-root', 'workspace');
    expect(() => assertDirectWorkspaceChild(root, sibling)).toThrow(WorkspacePathGuardError);
  });

  it('rejects a grandchild path', () => {
    const grandchild = join(root, 'parent', 'child');
    expect(() => assertDirectWorkspaceChild(root, grandchild)).toThrow(WorkspacePathGuardError);
  });

  it('rejects a traversal outside root', () => {
    const traversal = join(root, '..', '..', 'etc', 'passwd');
    expect(() => assertDirectWorkspaceChild(root, traversal)).toThrow(WorkspacePathGuardError);
  });

  it('rejects an empty string', () => {
    expect(() => assertDirectWorkspaceChild(root, '')).toThrow(WorkspacePathGuardError);
  });

  it('rejects a whitespace-only string', () => {
    expect(() => assertDirectWorkspaceChild(root, '   ')).toThrow(WorkspacePathGuardError);
  });

  it('WorkspacePathGuardError has correct code and name', () => {
    try {
      assertDirectWorkspaceChild(root, '');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspacePathGuardError);
      const guardErr = err as WorkspacePathGuardError;
      expect(guardErr.code).toBe('WORKSPACE_PATH_REJECTED');
      expect(guardErr.name).toBe('WorkspacePathGuardError');
      expect(guardErr.context).toBeDefined();
    }
  });
});

// ─── WorkspacePruner ──────────────────────────────────────────────────────────

describe('WorkspacePruner', () => {
  it('deletes a direct child workspace recursively and logs lifecycle events', async () => {
    const workspaceDir = join(root, 'my-workspace');
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(join(workspaceDir, 'nested'));

    const records: Record<string, unknown>[] = [];
    const pruner = new WorkspacePruner({
      logDestination: { write: (msg: string) => records.push(JSON.parse(msg)) } as pino.DestinationStream,
    });

    const request: WorkspacePruneRequest = {
      run_id: 'run-001',
      request_id: 'req-001',
      workspace_root: root,
      workspace_path: workspaceDir,
      mode: 'manual',
    };

    const result = await pruner.prune(request);

    expect(result.status).toBe('deleted');
    if (result.status === 'deleted') {
      expect(result.workspace_path).toBe(workspaceDir);
      expect(result.workspace_root).toBe(root);
    }

    // Directory should be gone
    expect(() => mkdirSync(workspaceDir, { recursive: false })).not.toThrow();

    // Lifecycle log events
    const events = records.map(r => r['event']);
    expect(events).toContain('workspace.prune_started');
    expect(events).toContain('workspace.pruned');
  });

  it('treats a missing direct-child workspace as successful force deletion', async () => {
    const pruner = new WorkspacePruner({
      logDestination: { write: () => {} } as pino.DestinationStream,
    });

    const result = await pruner.prune({
      run_id: 'run-002',
      request_id: 'req-002',
      workspace_root: root,
      workspace_path: join(root, 'missing'),
      mode: 'auto',
    });

    expect(result.status).toBe('deleted');
  });

  it('does not call rm when guard rejects and returns rejected status', async () => {
    const rmFn = vi.fn().mockResolvedValue(undefined);
    const pruner = new WorkspacePruner({
      logDestination: { write: () => {} } as pino.DestinationStream,
      rmFn,
    });

    const result = await pruner.prune({
      run_id: 'run-003',
      request_id: 'req-003',
      workspace_root: root,
      workspace_path: join(root, 'parent', 'grandchild'),
      mode: 'manual',
    });

    expect(result.status).toBe('rejected');
    expect(rmFn).not.toHaveBeenCalled();
    if (result.status === 'rejected') {
      expect(result.error).toBeInstanceOf(WorkspacePathGuardError);
    }
  });

  it('returns skipped when workspace_path is empty and allowEmpty is true', async () => {
    const pruner = new WorkspacePruner({
      logDestination: { write: () => {} } as pino.DestinationStream,
    });

    const result = await pruner.prune({
      run_id: 'run-004',
      request_id: 'req-004',
      workspace_root: root,
      workspace_path: '',
      mode: 'auto',
      allowEmpty: true,
    });

    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toBe('empty_workspace_path');
    }
  });

  it('returns failed status when rm throws an error', async () => {
    const rmFn = vi.fn().mockRejectedValue(new Error('permission denied'));
    const records: Record<string, unknown>[] = [];
    const pruner = new WorkspacePruner({
      logDestination: { write: (msg: string) => records.push(JSON.parse(msg)) } as pino.DestinationStream,
      rmFn,
    });

    const result = await pruner.prune({
      run_id: 'run-005',
      request_id: 'req-005',
      workspace_root: root,
      workspace_path: join(root, 'workspace'),
      mode: 'manual',
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBeInstanceOf(Error);
    }
    const events = records.map(r => r['event']);
    expect(events).toContain('workspace.prune_failed');
  });
});
