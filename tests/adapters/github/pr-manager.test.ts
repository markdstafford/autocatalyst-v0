import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GHPRManager } from '../../../src/adapters/github/pr-manager.js';

const nullDest = { write: () => {} };

let tmpDir: string;
let specPath: string;

const SPEC_WITH_ISSUE = [
  '---',
  'created: 2026-04-01',
  'last_updated: 2026-04-01',
  'status: implementing',
  'specced_by: alice',
  'issue: 42',
  'superseded_by: null',
  '---',
  '',
  '# My Feature',
  '',
  'This is the spec.',
].join('\n');

const SPEC_NO_ISSUE = [
  '---',
  'created: 2026-04-01',
  'last_updated: 2026-04-01',
  'status: implementing',
  'specced_by: alice',
  'issue: null',
  'superseded_by: null',
  '---',
  '',
  '# My Feature',
  '',
  'This is the spec.',
].join('\n');

const TRIAGE_DOC_NO_H1 = [
  '## Summary',
  '',
  'The widget blows up when you click it.',
  '',
  '## Steps to reproduce',
  '',
  '1. Click the widget',
].join('\n');

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pr-manager-'));
  mkdirSync(join(tmpDir, 'context-human', 'specs'), { recursive: true });
  specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
  writeFileSync(specPath, SPEC_NO_ISSUE, 'utf-8');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeExecFn(
  pushResult = { stdout: '', stderr: '' },
  prResult = { stdout: 'https://github.com/org/repo/pull/42\n', stderr: '' },
) {
  return vi.fn()
    .mockResolvedValueOnce(pushResult)
    .mockResolvedValueOnce(prResult);
}

// ---- createPR: title derivation ----

describe('GHPRManager — createPR() title derivation', () => {
  it('run_intent="idea" → title is "feat: my feature"', async () => {
    const execFn = makeExecFn();
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await manager.createPR(tmpDir, 'branch', specPath, { run_intent: 'idea' });
    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    expect(prArgs[prArgs.indexOf('--title') + 1]).toBe('feat: my feature');
  });

  it('run_intent="bug" → title is "fix: my feature"', async () => {
    const execFn = makeExecFn();
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await manager.createPR(tmpDir, 'branch', specPath, { run_intent: 'bug' });
    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    expect(prArgs[prArgs.indexOf('--title') + 1]).toBe('fix: my feature');
  });

  it('run_intent="chore" → title is "chore: my feature"', async () => {
    const execFn = makeExecFn();
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await manager.createPR(tmpDir, 'branch', specPath, { run_intent: 'chore' });
    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    expect(prArgs[prArgs.indexOf('--title') + 1]).toBe('chore: my feature');
  });

  it('run_intent not provided → defaults to "feat: my feature"', async () => {
    const execFn = makeExecFn();
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await manager.createPR(tmpDir, 'branch', specPath);
    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    expect(prArgs[prArgs.indexOf('--title') + 1]).toBe('feat: my feature');
  });
});

// ---- createPR: PR body ----

describe('GHPRManager — createPR() PR body', () => {
  it('body renders structured implementation result fields when provided', async () => {
    const execFn = makeExecFn();
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await manager.createPR(tmpDir, 'branch', specPath, {
      issue_number: 182,
      impl_result: {
        summary: 'legacy fallback — use review_summary instead',
        testing_instructions: 'legacy fallback — use testing_steps instead',
        review_summary: {
          changes: ['Stored review summary fields', 'Updated GitHub PR body renderer'],
          confirm: ['PR summary uses review_summary.changes', 'PR verify uses review_summary.confirm'],
        },
        testing_steps: ['cd /Users/mark.stafford/.autocatalyst/workspaces/autocatalyst/4ec756c1-2385-45c2-ac96-48ba64d6be8a', 'npm test -- tests/adapters/github/pr-manager.test.ts'],
      },
    });
    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    const body = prArgs[prArgs.indexOf('--body') + 1] as string;
    expect(body).toContain('## Summary');
    expect(body).toContain('- Stored review summary fields');
    expect(body).toContain('- Updated GitHub PR body renderer');
    expect(body).toContain('## Verify');
    expect(body).toContain('- [ ] PR summary uses review_summary.changes');
    expect(body).toContain('- [ ] PR verify uses review_summary.confirm');
    expect(body).toContain('## Test steps');
    expect(body).toContain('1. cd /Users/mark.stafford/.autocatalyst/workspaces/autocatalyst/4ec756c1-2385-45c2-ac96-48ba64d6be8a');
    expect(body).toContain('2. npm test -- tests/adapters/github/pr-manager.test.ts');
    expect(body).toContain('Closes #182');
    expect(body).not.toContain('legacy fallback — use review_summary instead');
    expect(body).not.toContain('legacy fallback — use testing_steps instead');
    expect(body).not.toContain('## Testing');
  });

  it('body falls back to legacy summary and testing instructions when structured fields are absent', async () => {
    const execFn = makeExecFn();
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await manager.createPR(tmpDir, 'branch', specPath, {
      impl_result: {
        summary: 'Built the legacy-only thing.',
        testing_instructions: 'Run npm test for the legacy-only thing.',
      },
    });
    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    const body = prArgs[prArgs.indexOf('--body') + 1] as string;
    expect(body).toContain('## Summary');
    expect(body).toContain('Built the legacy-only thing.');
    expect(body).toContain('## Testing');
    expect(body).toContain('Run npm test for the legacy-only thing.');
    expect(body).not.toContain('## Verify');
    expect(body).not.toContain('## Test steps');
  });

  it('body renders safe defaults when impl_result is not provided', async () => {
    const execFn = makeExecFn();
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await manager.createPR(tmpDir, 'branch', specPath);
    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    const body = prArgs[prArgs.indexOf('--body') + 1] as string;
    expect(body).toContain('## Summary');
    expect(body).toContain('No implementation summary provided.');
    expect(body).toContain('## Testing');
    expect(body).toContain('No testing instructions provided.');
  });

  it('body contains "Closes #42" when spec frontmatter issue is 42', async () => {
    writeFileSync(specPath, SPEC_WITH_ISSUE, 'utf-8');
    const execFn = makeExecFn();
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await manager.createPR(tmpDir, 'branch', specPath);
    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    const body = prArgs[prArgs.indexOf('--body') + 1] as string;
    expect(body).toContain('Closes #42');
  });

  it('body does NOT contain "Closes #" when spec frontmatter issue is null', async () => {
    const execFn = makeExecFn();
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await manager.createPR(tmpDir, 'branch', specPath);
    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    const body = prArgs[prArgs.indexOf('--body') + 1] as string;
    expect(body).not.toContain('Closes #');
  });

  it('body renders repository-relative spec path when artifact is inside the workspace', async () => {
    const execFn = makeExecFn();
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await manager.createPR(tmpDir, 'branch', specPath);
    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    const body = prArgs[prArgs.indexOf('--body') + 1] as string;
    expect(body).toContain('Spec: `context-human/specs/feature-my-feature.md`');
    expect(body).not.toContain(specPath);
  });

  it('body omits Spec footer for internal triage artifacts', async () => {
    mkdirSync(join(tmpDir, '.autocatalyst', 'triage'), { recursive: true });
    const triagePath = join(tmpDir, '.autocatalyst', 'triage', 'triage-bug-182.md');
    writeFileSync(triagePath, TRIAGE_DOC_NO_H1, 'utf-8');
    const execFn = makeExecFn();
    const manager = new GHPRManager(execFn, { logDestination: nullDest });

    await manager.createPR(tmpDir, 'branch', triagePath, { issue_number: 182 });

    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    const body = prArgs[prArgs.indexOf('--body') + 1] as string;
    expect(body).not.toContain('Spec:');
    expect(body).not.toContain(triagePath);
    expect(body).toContain('Closes #182');
  });

  it('body omits Spec footer when artifact path is outside the workspace', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'pr-manager-outside-'));
    const outsidePath = join(outsideDir, 'external-spec.md');
    writeFileSync(outsidePath, SPEC_NO_ISSUE, 'utf-8');
    const execFn = makeExecFn();
    const manager = new GHPRManager(execFn, { logDestination: nullDest });

    try {
      await manager.createPR(tmpDir, 'branch', outsidePath);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }

    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    const body = prArgs[prArgs.indexOf('--body') + 1] as string;
    expect(body).not.toContain('Spec:');
    expect(body).not.toContain(outsidePath);
  });
});

// ---- createPR: error handling ----

describe('GHPRManager — createPR() error handling', () => {
  it('throws when git push fails; gh pr create is not called', async () => {
    const execFn = vi.fn().mockRejectedValue(new Error('push failed'));
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await expect(manager.createPR(tmpDir, 'branch', specPath)).rejects.toThrow(/push/i);
    expect(execFn).toHaveBeenCalledTimes(1);
  });

  it('throws when gh pr create fails', async () => {
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('gh failed'));
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await expect(manager.createPR(tmpDir, 'branch', specPath)).rejects.toThrow();
  });
});

// ---- createPR: logging ----

describe('GHPRManager — createPR() logging', () => {
  it('emits pr.created on success with pr_url, branch, and spec_title', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const execFn = makeExecFn(
      { stdout: '', stderr: '' },
      { stdout: 'https://github.com/org/repo/pull/99\n', stderr: '' },
    );
    const manager = new GHPRManager(execFn, { logDestination: dest });
    await manager.createPR(tmpDir, 'spec/my-feature', specPath);
    const created = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'pr.created');
    expect(created).toBeDefined();
    expect(created!['pr_url']).toBe('https://github.com/org/repo/pull/99');
    expect(created!['branch']).toBe('spec/my-feature');
  });

  it('emits pr.creation_failed on push failure', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const execFn = vi.fn().mockRejectedValue(new Error('push failed'));
    const manager = new GHPRManager(execFn, { logDestination: dest });
    await expect(manager.createPR(tmpDir, 'branch', specPath)).rejects.toThrow();
    const failed = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'pr.creation_failed');
    expect(failed).toBeDefined();
    expect(failed!['step']).toBe('push');
  });
});

// ---- mergePR ----

describe('GHPRManager — mergePR()', () => {
  it('calls gh pr merge <pr_url> --squash --delete-branch with cwd: workspace_path', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    const prUrl = 'https://github.com/org/repo/pull/42';
    await manager.mergePR(tmpDir, prUrl);
    expect(execFn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = execFn.mock.calls[0] as [string, string[], { cwd: string }];
    expect(cmd).toBe('gh');
    expect(args).toContain('merge');
    expect(args).toContain(prUrl);
    expect(args).toContain('--squash');
    expect(args).toContain('--delete-branch');
    expect(opts.cwd).toBe(tmpDir);
  });

  it('resolves when command exits zero', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await expect(manager.mergePR(tmpDir, 'https://github.com/org/repo/pull/1')).resolves.toBeUndefined();
  });

  it('throws with error content when command exits non-zero', async () => {
    const execFn = vi.fn().mockRejectedValue(
      Object.assign(new Error('Process exited with code 1'), { stderr: 'merge conflict detected' }),
    );
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await expect(manager.mergePR(tmpDir, 'https://github.com/org/repo/pull/1')).rejects.toThrow();
  });

  it('throws when gh not found', async () => {
    const execFn = vi.fn().mockRejectedValue(
      Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
    );
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await expect(manager.mergePR(tmpDir, 'https://github.com/org/repo/pull/1')).rejects.toThrow();
  });

  it('emits pr.merged on success with pr_url and workspace_path', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const manager = new GHPRManager(execFn, { logDestination: dest });
    const prUrl = 'https://github.com/org/repo/pull/42';
    await manager.mergePR(tmpDir, prUrl);
    const merged = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'pr.merged');
    expect(merged).toBeDefined();
    expect(merged!['pr_url']).toBe(prUrl);
    expect(merged!['workspace_path']).toBe(tmpDir);
  });

  it('emits pr.merge_failed on failure', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const execFn = vi.fn().mockRejectedValue(new Error('merge failed'));
    const manager = new GHPRManager(execFn, { logDestination: dest });
    await expect(manager.mergePR(tmpDir, 'https://github.com/org/repo/pull/1')).rejects.toThrow();
    const failed = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'pr.merge_failed');
    expect(failed).toBeDefined();
  });
});

// ---- createPR: options.title and options.issue_number ----

describe('GHPRManager — createPR() with options.title and options.issue_number', () => {
  it('uses options.title instead of spec H1 when provided', async () => {
    writeFileSync(specPath, TRIAGE_DOC_NO_H1, 'utf-8');
    const execFn = makeExecFn();
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await manager.createPR(tmpDir, 'branch', specPath, {
      run_intent: 'bug',
      title: 'Replace databases.query with dataSources.query',
    });
    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    expect(prArgs[prArgs.indexOf('--title') + 1]).toBe('fix: replace databases.query with datasources.query');
  });

  it('falls back to spec H1 when options.title is not provided', async () => {
    const execFn = makeExecFn();
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await manager.createPR(tmpDir, 'branch', specPath, { run_intent: 'idea' });
    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    expect(prArgs[prArgs.indexOf('--title') + 1]).toBe('feat: my feature');
  });

  it('body contains "Closes #54" when options.issue_number is 54 and spec has no issue frontmatter', async () => {
    writeFileSync(specPath, TRIAGE_DOC_NO_H1, 'utf-8');
    const execFn = makeExecFn();
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await manager.createPR(tmpDir, 'branch', specPath, { issue_number: 54 });
    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    const body = prArgs[prArgs.indexOf('--body') + 1] as string;
    expect(body).toContain('Closes #54');
  });

  it('options.issue_number takes precedence over spec frontmatter issue', async () => {
    writeFileSync(specPath, SPEC_WITH_ISSUE, 'utf-8'); // frontmatter has issue: 42
    const execFn = makeExecFn();
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await manager.createPR(tmpDir, 'branch', specPath, { issue_number: 99 });
    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    const body = prArgs[prArgs.indexOf('--body') + 1] as string;
    expect(body).toContain('Closes #99');
    expect(body).not.toContain('Closes #42');
  });

  it('body does NOT contain "Closes #" when no issue_number in options and spec has no issue frontmatter', async () => {
    writeFileSync(specPath, TRIAGE_DOC_NO_H1, 'utf-8');
    const execFn = makeExecFn();
    const manager = new GHPRManager(execFn, { logDestination: nullDest });
    await manager.createPR(tmpDir, 'branch', specPath);
    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    const body = prArgs[prArgs.indexOf('--body') + 1] as string;
    expect(body).not.toContain('Closes #');
  });
});
