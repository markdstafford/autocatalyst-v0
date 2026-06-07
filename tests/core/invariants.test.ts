import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { loadConfig, redactConfig } from '../../src/core/config.js';
import { VALID_RUN_STAGES } from '../../src/types/runs.js';

describe('cross-cutting: JSON output validity', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'autocatalyst-invariant-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loadConfig error produces parseable error message, not raw stack', () => {
    writeFileSync(join(tempDir, 'WORKFLOW.md'), 'invalid content no frontmatter');
    try {
      loadConfig(join(tempDir, 'WORKFLOW.md'), {});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(typeof (err as Error).message).toBe('string');
      // Error messages should be structured, not stack traces
      expect((err as Error).message).not.toContain('    at ');
    }
  });
});

describe('cross-cutting: no secret leakage', () => {
  it('redactConfig never exposes env var values', () => {
    const secret = 'super-secret-token-12345';
    const config = {
      slack: { token: secret },
      nested: { deep: { value: secret } },
      safe: 'not-a-secret',
    };
    const redacted = redactConfig(config, { SECRET: secret });

    const json = JSON.stringify(redacted);
    expect(json).not.toContain(secret);
    expect(json).toContain('[from env]');
    expect(json).toContain('not-a-secret');
  });

  it('redactConfig handles secrets that appear as substrings', () => {
    const secret = 'abc';
    const config = { value: 'abc', other: 'xabcx' };
    const redacted = redactConfig(config, { SECRET: secret });

    // Exact match should be redacted
    expect(redacted.value).toBe('[from env]');
    // Substring should NOT be redacted (it's a different value)
    expect(redacted.other).toBe('xabcx');
  });
});

describe('run stage invariants', () => {
  it('does not introduce new run stages beyond the approved set', () => {
    expect([...VALID_RUN_STAGES].sort()).toEqual([
      'awaiting_impl_input',
      'awaiting_planning_input',
      'done',
      'failed',
      'implementing',
      'intake',
      'planning',
      'pr_open',
      'reviewing_implementation',
      'reviewing_spec',
      'speccing',
    ]);
  });
});
