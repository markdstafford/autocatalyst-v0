import { promisify } from 'node:util';
import { execFile as _execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { PRManager, PRManagerOptions } from '../../types/issue-tracker.js';
import type { RequestIntent } from '../../types/runs.js';

const _promisifiedExecFile = promisify(_execFile);

// Augment PATH with common macOS Homebrew paths to ensure `gh` and `git` are found
// when the process is started without a full interactive shell environment.
const _extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
async function defaultExecFile(
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  const currentPath = process.env.PATH ?? '';
  const currentParts = new Set(currentPath.split(':'));
  const newParts = _extraPaths.filter(p => !currentParts.has(p));
  const augmentedPath = newParts.length > 0
    ? [...newParts, currentPath].filter(Boolean).join(':')
    : currentPath;
  return _promisifiedExecFile(cmd, args, { ...opts, env: { ...process.env, PATH: augmentedPath } });
}

type ExecFn = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

interface GHPRManagerOptions {
  logDestination?: pino.DestinationStream;
}

function extractSpecTitle(specContent: string): string {
  const match = specContent.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : 'spec';
}

function extractFrontmatterField(specContent: string, field: string): string | null {
  const delim = '---';
  const start = specContent.indexOf(delim);
  if (start === -1) return null;
  const end = specContent.indexOf(delim, start + 3);
  if (end === -1) return null;
  const frontmatter = specContent.slice(start + 3, end);
  const match = frontmatter.match(new RegExp(`^${field}\\s*:\\s*(.+)$`, 'm'));
  if (!match) return null;
  const val = match[1].trim();
  return val === 'null' ? null : val;
}

function derivePrTitle(runIntent: RequestIntent | undefined, specTitle: string): string {
  const lowerTitle = specTitle.toLowerCase();
  if (runIntent === 'bug') return `fix: ${lowerTitle}`;
  if (runIntent === 'chore') return `chore: ${lowerTitle}`;
  return `feat: ${lowerTitle}`;
}

function nonEmptyStrings(values: string[] | undefined): string[] {
  return values?.map(value => value.trim()).filter(Boolean) ?? [];
}

function specFooterLines(workspacePath: string, specPath: string): string[] {
  if (!workspacePath || !specPath) return [];

  const relativeSpecPath = relative(workspacePath, specPath);
  const isOutsideWorkspace = relativeSpecPath === '..'
    || relativeSpecPath.startsWith(`..${sep}`)
    || isAbsolute(relativeSpecPath);
  if (!relativeSpecPath || isOutsideWorkspace) return [];

  const repositoryRelativePath = relativeSpecPath.split(sep).join('/');
  if (repositoryRelativePath.startsWith('.autocatalyst/triage/')) return [];

  return ['---', `Spec: \`${repositoryRelativePath}\``];
}

function buildPrBody(
  workspacePath: string,
  specPath: string,
  issueNumber: number | null,
  options?: PRManagerOptions,
): string {
  const implResult = options?.impl_result;
  const changes = nonEmptyStrings(implResult?.review_summary?.changes);
  const confirmations = nonEmptyStrings(implResult?.review_summary?.confirm);
  const testingSteps = nonEmptyStrings(implResult?.testing_steps);
  const legacySummary = implResult?.summary?.trim() || 'No implementation summary provided.';
  const legacyTestingInstructions = implResult?.testing_instructions?.trim() || 'No testing instructions provided.';

  const lines: string[] = ['## Summary', ''];
  if (changes.length > 0) {
    lines.push(...changes.map(change => `- ${change}`));
  } else {
    lines.push(legacySummary);
  }

  if (confirmations.length > 0) {
    lines.push('', '## Verify', '', ...confirmations.map(item => `- [ ] ${item}`));
  }

  if (testingSteps.length > 0) {
    lines.push('', '## Test steps', '', ...testingSteps.map((step, index) => `${index + 1}. ${step}`));
  } else {
    lines.push('', '## Testing', '', legacyTestingInstructions);
  }

  const footer = specFooterLines(workspacePath, specPath);
  if (footer.length > 0) {
    lines.push('', ...footer);
  }

  if (issueNumber !== null && issueNumber > 0) {
    if (footer.length === 0) lines.push('');
    lines.push(`Closes #${issueNumber}`);
  }

  return lines.join('\n');
}

export class GHPRManager implements PRManager {
  private readonly execFn: ExecFn;
  private readonly logger: pino.Logger;

  constructor(execFn?: ExecFn, options?: GHPRManagerOptions) {
    this.execFn = execFn ?? defaultExecFile;
    this.logger = createLogger('pr-manager', { destination: options?.logDestination });
  }

  async createPR(
    workspace_path: string,
    branch: string,
    spec_path: string,
    options?: PRManagerOptions,
  ): Promise<string> {
    const specContent = readFileSync(spec_path, 'utf-8');
    const rawTitle = options?.title ?? extractSpecTitle(specContent);
    const prTitle = derivePrTitle(options?.run_intent, rawTitle);

    const issueFromOptions = options?.issue_number ?? null;
    const issueRaw = extractFrontmatterField(specContent, 'issue');
    const issueFromFrontmatter = issueRaw !== null ? parseInt(issueRaw, 10) : null;
    const issueForBody = issueFromOptions !== null
      ? issueFromOptions
      : (issueFromFrontmatter !== null && !isNaN(issueFromFrontmatter) ? issueFromFrontmatter : null);

    const prBody = buildPrBody(workspace_path, spec_path, issueForBody, options);

    // Push the branch
    try {
      await this.execFn('git', ['push', 'origin', branch], { cwd: workspace_path });
    } catch (err) {
      this.logger.error(
        { event: 'pr.creation_failed', error: String(err), step: 'push', branch },
        'git push failed',
      );
      throw new Error(`git push failed: ${String(err)}`);
    }

    // Create the PR
    let prUrl: string;
    try {
      const { stdout } = await this.execFn(
        'gh',
        ['pr', 'create', '--head', branch, '--title', prTitle, '--body', prBody],
        { cwd: workspace_path },
      );
      prUrl = stdout.trim();
    } catch (err) {
      this.logger.error(
        { event: 'pr.creation_failed', error: String(err), step: 'pr_create', branch },
        'gh pr create failed',
      );
      throw new Error(`gh pr create failed: ${String(err)}`);
    }

    this.logger.info(
      { event: 'pr.created', pr_url: prUrl, branch, spec_title: rawTitle },
      'PR created',
    );
    return prUrl;
  }

  async mergePR(workspace_path: string, pr_url: string): Promise<void> {
    try {
      await this.execFn(
        'gh',
        ['pr', 'merge', pr_url, '--squash', '--delete-branch'],
        { cwd: workspace_path },
      );
    } catch (err) {
      const errStr = String(err);
      this.logger.error(
        { event: 'pr.merge_failed', error: errStr, pr_url, workspace_path },
        'gh pr merge failed',
      );
      throw new Error(`gh pr merge failed: ${errStr}`);
    }

    this.logger.info(
      { event: 'pr.merged', pr_url, workspace_path },
      'PR merged',
    );
  }
}
