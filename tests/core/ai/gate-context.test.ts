import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildGateContext } from '../../../src/core/ai/gate-context.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]) {
  await exec('git', args, { cwd });
}

describe('buildGateContext', () => {
  it('returns cumulative diff for tracked changes', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'gate-context-'));
    await git(repo, ['init']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    await writeFile(join(repo, 'src.ts'), 'export const a = 1;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'base']);
    const baseResult = await exec('git', ['rev-parse', 'HEAD'], { cwd: repo });
    const base = baseResult.stdout.trim();

    await writeFile(join(repo, 'src.ts'), 'export const a = 2;\n');

    const context = await buildGateContext({ gate: 'layout', base_ref: base, working_directory: repo });

    expect(context.changed_files).toContain('src.ts');
    expect(context.diff).toContain('diff --git a/src.ts b/src.ts');
    expect(context.gate).toBe('layout');
    expect(context.base_ref).toBe(base);
  });

  it('includes non-ignored untracked files in diff and changed_files', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'gate-context-'));
    await git(repo, ['init']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(repo, 'base.ts'), 'export const x = 1;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'base']);
    const baseResult = await exec('git', ['rev-parse', 'HEAD'], { cwd: repo });
    const base = baseResult.stdout.trim();

    await writeFile(join(repo, 'new.ts'), 'export const b = 1;\n');
    await writeFile(join(repo, 'ignored.txt'), 'ignored content\n');

    const context = await buildGateContext({ gate: 'layout', base_ref: base, working_directory: repo });

    expect(context.changed_files).toContain('new.ts');
    expect(context.changed_files).not.toContain('ignored.txt');
    expect(context.diff).toContain('new.ts');
    expect(context.diff).not.toContain('ignored.txt');
  });

  it('excludes ignored untracked files from diff and changed_files', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'gate-context-'));
    await git(repo, ['init']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    await writeFile(join(repo, '.gitignore'), 'secret.txt\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'base']);
    const baseResult = await exec('git', ['rev-parse', 'HEAD'], { cwd: repo });
    const base = baseResult.stdout.trim();

    await writeFile(join(repo, 'secret.txt'), 'secret content\n');

    const context = await buildGateContext({ gate: 'build', base_ref: base, working_directory: repo });

    expect(context.changed_files).not.toContain('secret.txt');
    expect(context.diff).not.toContain('secret.txt');
  });

  it('returns sorted unique changed_files', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'gate-context-'));
    await git(repo, ['init']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    await writeFile(join(repo, 'a.ts'), 'const a = 1;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'base']);
    const baseResult = await exec('git', ['rev-parse', 'HEAD'], { cwd: repo });
    const base = baseResult.stdout.trim();

    await writeFile(join(repo, 'z.ts'), 'const z = 1;\n');
    await writeFile(join(repo, 'b.ts'), 'const b = 1;\n');

    const context = await buildGateContext({ gate: 'public_api', base_ref: base, working_directory: repo });

    expect(context.changed_files).toEqual([...context.changed_files].sort());
  });
});
