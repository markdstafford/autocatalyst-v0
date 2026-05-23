import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import { parseArgs } from '../../src/core/cli.js';
import { printUsage } from '../../src/core/cli.js';
import { mkdtempSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

describe('parseArgs', () => {
  it('parses --repo with valid directory', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cli-test-'));
    try {
      const result = parseArgs(['--repo', tempDir]);
      expect(result.repoPath).toBe(tempDir);
      expect(result.repoPaths).toEqual([tempDir]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves relative --repo path to absolute', () => {
    const result = parseArgs(['--repo', '.']);
    expect(result.repoPath).toMatch(/^\//);
  });

  it('throws for --repo with nonexistent path', () => {
    expect(() => parseArgs(['--repo', '/nonexistent/path'])).toThrow(/does not exist/);
  });

  it('throws for --repo pointing to a file', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cli-test-'));
    const filePath = join(tempDir, 'file.txt');
    writeFileSync(filePath, 'content');
    try {
      expect(() => parseArgs(['--repo', filePath])).toThrow(/not a directory/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('throws when --repo is not provided', () => {
    expect(() => parseArgs([])).toThrow(/--repo/);
  });

  it('returns help flag when --help is passed', () => {
    const result = parseArgs(['--help']);
    expect(result.help).toBe(true);
  });

  it('returns help flag when -h is passed', () => {
    const result = parseArgs(['-h']);
    expect(result.help).toBe(true);
  });
});

describe('parseArgs subcommand routing', () => {
  it('parses init with no --repo', () => {
    const result = parseArgs(['init']);
    expect(result.command).toBe('init');
    expect(result.repoPath).toBe('');
    expect(result.help).toBe(false);
  });

  it('parses init with --repo', () => {
    const result = parseArgs(['init', '--repo', '/p']);
    expect(result.command).toBe('init');
    expect(result.repoPath).toBe('/p');
    expect(result.help).toBe(false);
  });

  it('preserves run command behavior with --repo (backward compat)', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cli-test-'));
    try {
      const result = parseArgs(['--repo', tempDir]);
      expect(result.command).toBe('run');
      expect(result.repoPath).toBe(tempDir);
      expect(result.help).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns command: run with --help', () => {
    const result = parseArgs(['--help']);
    expect(result.command).toBe('run');
    expect(result.repoPath).toBe('');
    expect(result.help).toBe(true);
  });

  it('returns command: init with init --help', () => {
    const result = parseArgs(['init', '--help']);
    expect(result.command).toBe('init');
    expect(result.repoPath).toBe('');
    expect(result.help).toBe(true);
  });

  it('still throws when no subcommand and no --repo', () => {
    expect(() => parseArgs([])).toThrow(/--repo/);
  });
});

describe('parseArgs — multi-repo', () => {
  it('parses --repo with two valid directories', () => {
    const dir1 = mkdtempSync(join(tmpdir(), 'cli-test-'));
    const dir2 = mkdtempSync(join(tmpdir(), 'cli-test-'));
    try {
      const result = parseArgs(['--repo', dir1, dir2]);
      expect(result.repoPaths).toHaveLength(2);
      expect(result.repoPaths[0]).toBe(dir1);
      expect(result.repoPaths[1]).toBe(dir2);
      expect(result.repoPath).toBe(dir1); // backward compat: first path
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('single --repo path returns repoPaths with one element', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cli-test-'));
    try {
      const result = parseArgs(['--repo', tempDir]);
      expect(result.repoPaths).toEqual([tempDir]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('parseArgs — --log-requests', () => {
  it('parses --log-requests flag', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cli-test-'));
    try {
      const result = parseArgs(['--repo', tempDir, '--log-requests']);
      expect(result.logRequests).toBe(true);
      expect(result.repoPaths).toEqual([tempDir]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('defaults logRequests to false when --log-requests is absent', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cli-test-'));
    try {
      const result = parseArgs(['--repo', tempDir]);
      expect(result.logRequests).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('--log-requests before --repo paths still collects all paths', () => {
    const dir1 = mkdtempSync(join(tmpdir(), 'cli-test-'));
    const dir2 = mkdtempSync(join(tmpdir(), 'cli-test-'));
    try {
      const result = parseArgs(['--log-requests', '--repo', dir1, dir2]);
      expect(result.logRequests).toBe(true);
      expect(result.repoPaths).toHaveLength(2);
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe('printUsage', () => {
  it('documents both command forms', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printUsage();
    const output = spy.mock.calls[0]?.[0] as string;
    spy.mockRestore();
    expect(output).toContain('autocatalyst --repo');
    expect(output).toContain('autocatalyst init');
  });

  it('documents --log-requests option', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printUsage();
    const output = spy.mock.calls[0]?.[0] as string;
    spy.mockRestore();
    expect(output).toContain('--log-requests');
  });

  it('describes --log-requests as dumping request and response diagnostics', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printUsage();
    const output = spy.mock.calls[0]?.[0] as string;
    spy.mockRestore();
    expect(output).toMatch(/response/i);
  });
});
