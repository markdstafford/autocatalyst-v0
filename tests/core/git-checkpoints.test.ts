import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGitSnapshotCheckpoint } from '../../src/core/git-checkpoints.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return exec('git', args, { cwd });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  return result.stdout.trim();
}

async function setupRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'checkpoint-test-'));
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(repo, 'tracked.ts'), 'export const a = 1;\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'base']);
  return repo;
}

describe('createGitSnapshotCheckpoint', () => {
  it('creates an internal ref checkpoint without mutating real index', async () => {
    const repo = await setupRepo();

    await writeFile(join(repo, 'tracked.ts'), 'export const a = 2;\n');
    await writeFile(join(repo, 'new.ts'), 'export const b = 1;\n');
    await writeFile(join(repo, 'ignored.txt'), 'ignored\n');

    const checkpoint = await createGitSnapshotCheckpoint({
      workingDirectory: repo,
      runId: 'run-1',
      gate: 'layout',
    });

    expect(checkpoint.strategy).toBe('internal_ref');
    expect(checkpoint.ref).toMatch(/^refs\/autocatalyst\/runs\/run-1\/layout\//);
    expect(checkpoint.commit).toMatch(/^[0-9a-f]{40}$/);

    // Verify tracked file change was captured in checkpoint
    const trackedContent = await gitOutput(repo, ['show', `${checkpoint.commit}:tracked.ts`]);
    expect(trackedContent).toContain('export const a = 2');

    // Verify untracked non-ignored file was captured
    const newContent = await gitOutput(repo, ['show', `${checkpoint.commit}:new.ts`]);
    expect(newContent).toContain('export const b = 1');

    // Verify ignored file was NOT captured
    await expect(gitOutput(repo, ['show', `${checkpoint.commit}:ignored.txt`])).rejects.toThrow();
  });

  it('does not leave untracked files staged in the real index', async () => {
    const repo = await setupRepo();
    await writeFile(join(repo, 'new.ts'), 'export const b = 1;\n');

    await createGitSnapshotCheckpoint({
      workingDirectory: repo,
      runId: 'run-1',
      gate: 'layout',
    });

    // Check that new.ts is still untracked (not staged) after checkpoint
    const statusResult = await git(repo, ['status', '--porcelain']);
    const status = statusResult.stdout;
    expect(status).toContain('?? new.ts');
    expect(status).not.toContain('A  new.ts');
  });

  it('does not switch or create branches', async () => {
    const repo = await setupRepo();
    const branchBefore = await gitOutput(repo, ['branch', '--show-current']);

    await createGitSnapshotCheckpoint({
      workingDirectory: repo,
      runId: 'run-1',
      gate: 'public_api',
    });

    const branchAfter = await gitOutput(repo, ['branch', '--show-current']);
    expect(branchAfter).toBe(branchBefore);
  });

  it('captures the ref under refs/autocatalyst namespace', async () => {
    const repo = await setupRepo();

    const checkpoint = await createGitSnapshotCheckpoint({
      workingDirectory: repo,
      runId: 'run-42',
      gate: 'private_api',
    });

    expect(checkpoint.ref.startsWith('refs/autocatalyst/runs/run-42/private_api/')).toBe(true);

    // Verify the ref exists in git
    const resolvedRef = await gitOutput(repo, ['rev-parse', checkpoint.ref]);
    expect(resolvedRef).toBe(checkpoint.commit);
  });
});
