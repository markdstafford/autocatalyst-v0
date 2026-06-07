import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);

export interface GitCheckpointResult {
  strategy: 'internal_ref';
  ref: string;
  commit: string;
  gate: string;
}

export async function createGitSnapshotCheckpoint(args: {
  workingDirectory: string;
  runId: string;
  gate: string;
  message?: string;
}): Promise<GitCheckpointResult> {
  const { workingDirectory, runId, gate, message } = args;

  // Create a temporary index file
  const tempDir = await mkdtemp(join(tmpdir(), 'ac-checkpoint-'));
  const tempIndex = join(tempDir, 'index');

  try {
    // Read the current HEAD tree into the temp index
    const headSha = await git(workingDirectory, ['rev-parse', 'HEAD']);
    await gitWithIndex(workingDirectory, tempIndex, ['read-tree', headSha.trim()]);

    // Update tracked working-tree files in the temp index
    // This picks up any unstaged modifications to tracked files
    await gitWithIndex(workingDirectory, tempIndex, ['update-index', '--refresh', '--ignore-missing']).catch(() => {});

    // Add working-tree versions of all tracked changed files
    const changedTracked = await git(workingDirectory, ['diff', '--name-only', 'HEAD']).catch(() => '');
    const trackedFiles = changedTracked.trim().split('\n').filter(Boolean);
    for (const file of trackedFiles) {
      await gitWithIndex(workingDirectory, tempIndex, ['update-index', '--add', '--', file]).catch(() => {});
    }

    // Get non-ignored untracked files
    const untrackedOutput = await git(workingDirectory, ['ls-files', '--others', '--exclude-standard']);
    const untrackedFiles = untrackedOutput.trim().split('\n').filter(Boolean);

    // Add each untracked file to the temp index using hash-object + update-index
    for (const file of untrackedFiles) {
      try {
        const blobSha = await git(workingDirectory, ['hash-object', '-w', '--', file]);
        await gitWithIndex(workingDirectory, tempIndex, [
          'update-index',
          '--add',
          '--cacheinfo',
          `100644,${blobSha.trim()},${file}`,
        ]);
      } catch {
        // Skip files we can't hash
      }
    }

    // Write the tree from temp index
    const treeSha = await gitWithIndex(workingDirectory, tempIndex, ['write-tree']);

    // Create a commit from this tree
    const parentSha = headSha.trim();
    const commitMsg = message ?? `autocatalyst: ${gate} checkpoint for ${runId}`;
    const commitSha = await git(workingDirectory, [
      'commit-tree',
      treeSha.trim(),
      '-p', parentSha,
      '-m', commitMsg,
    ]);

    // Create an internal ref
    const timestamp = Date.now();
    const ref = `refs/autocatalyst/runs/${runId}/${gate}/${timestamp}`;
    await git(workingDirectory, ['update-ref', ref, commitSha.trim()]);

    return {
      strategy: 'internal_ref',
      ref,
      commit: commitSha.trim(),
      gate,
    };
  } finally {
    // Always clean up the temp directory
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec('git', args, { cwd });
  return result.stdout;
}

async function gitWithIndex(cwd: string, indexFile: string, args: string[]): Promise<string> {
  const result = await exec('git', args, {
    cwd,
    env: { ...process.env, GIT_INDEX_FILE: indexFile },
  });
  return result.stdout;
}
