import { describe, expect, it } from 'vitest';
import {
  compareBuildToAcceptedContracts,
} from '../../../src/core/ai/build-contract-preservation.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const publicApiSource = `export interface Result { ok: boolean }
export function parse(input: string): Result;
`;

const buildWithSameSignature = `export interface Result { ok: boolean }
export function parse(input: string): Result {
  return { ok: input.length > 0 };
}
`;

const buildWithChangedSignature = `export interface Result { ok: boolean; code: number }
export function parse(input: string): boolean {
  return input.length > 0;
}
`;

const buildWithRenamedExport = `export interface Outcome { ok: boolean }
export function processInput(input: string): Outcome {
  return { ok: input.length > 0 };
}
`;

async function makeWorkdir() {
  const dir = await mkdtemp(join(tmpdir(), 'bcp-test-'));
  return dir;
}

describe('compareBuildToAcceptedContracts', () => {
  it('passes when no checkpoints are accepted', async () => {
    const dir = await makeWorkdir();
    const result = await compareBuildToAcceptedContracts({
      workingDirectory: dir,
      acceptedCheckpoints: [],
    });
    expect(result.valid).toBe(true);
    expect(result.drift).toHaveLength(0);
  });

  it('detects exported signature change (return type change)', async () => {
    const dir = await makeWorkdir();
    await writeFile(join(dir, 'api.ts'), buildWithChangedSignature);

    const result = await compareBuildToAcceptedContracts({
      workingDirectory: dir,
      acceptedCheckpoints: [{ gate: 'public_api', ref: 'mock-ref' }],
      readFileAtRef: async (_ref, path) => path === 'api.ts' ? publicApiSource : '',
      listFilesAtRef: async () => ['api.ts'],
    });

    expect(result.valid).toBe(false);
    expect(result.drift.some(d => d.kind === 'exported_signature' || d.kind === 'exported_name')).toBe(true);
  });

  it('passes when build only adds bodies to existing signatures', async () => {
    const dir = await makeWorkdir();
    await writeFile(join(dir, 'api.ts'), buildWithSameSignature);

    const result = await compareBuildToAcceptedContracts({
      workingDirectory: dir,
      acceptedCheckpoints: [{ gate: 'public_api', ref: 'mock-ref' }],
      readFileAtRef: async (_ref, path) => path === 'api.ts' ? publicApiSource : '',
      listFilesAtRef: async () => ['api.ts'],
    });

    expect(result.valid).toBe(true);
    expect(result.drift).toHaveLength(0);
  });

  it('detects source path drift (file moved/deleted)', async () => {
    const dir = await makeWorkdir();
    // Write current file at different path, not at original path
    await writeFile(join(dir, 'api-new.ts'), buildWithSameSignature);

    const result = await compareBuildToAcceptedContracts({
      workingDirectory: dir,
      acceptedCheckpoints: [{ gate: 'layout', ref: 'mock-ref' }],
      readFileAtRef: async (_ref, path) => path === 'src/api.ts' ? publicApiSource : '',
      listFilesAtRef: async () => ['src/api.ts'],
    });

    expect(result.drift.some(d => d.kind === 'source_path')).toBe(true);
  });

  it('detects rename as delete+add drift', async () => {
    const dir = await makeWorkdir();
    await writeFile(join(dir, 'api.ts'), buildWithRenamedExport);

    const result = await compareBuildToAcceptedContracts({
      workingDirectory: dir,
      acceptedCheckpoints: [{ gate: 'public_api', ref: 'mock-ref' }],
      readFileAtRef: async (_ref, path) => path === 'api.ts' ? publicApiSource : '',
      listFilesAtRef: async () => ['api.ts'],
    });

    // Renamed from parse/Result to processInput/Outcome - should detect drift
    expect(result.valid).toBe(false);
    expect(result.drift.length).toBeGreaterThan(0);
  });
});
