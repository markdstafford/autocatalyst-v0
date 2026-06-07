import { describe, expect, it } from 'vitest';
import { validateAltitudeContract } from '../../../src/core/ai/altitude-contract-validator.js';

const layoutWithBody = `diff --git a/src/a.ts b/src/a.ts
new file mode 100644
--- /dev/null
+++ b/src/a.ts
@@ -0,0 +1,3 @@
+export function run() {
+  return 1;
+}
`;

const layoutWithSkeletonOnly = `diff --git a/src/a.ts b/src/a.ts
new file mode 100644
--- /dev/null
+++ b/src/a.ts
@@ -0,0 +1,4 @@
+// Module: Core runner
+export class Runner {
+  // TODO(gate-layout): implement run method
+}
`;

const publicApiWithSignature = `diff --git a/src/a.ts b/src/a.ts
new file mode 100644
--- /dev/null
+++ b/src/a.ts
@@ -0,0 +1,2 @@
+export interface Result { ok: boolean }
+export function parse(input: string): Result;
`;

const publicApiWithBody = `diff --git a/src/a.ts b/src/a.ts
new file mode 100644
--- /dev/null
+++ b/src/a.ts
@@ -0,0 +1,3 @@
+export function parse(input: string): boolean {
+  return input.length > 0;
+}
`;

const testFile = `diff --git a/src/a.test.ts b/src/a.test.ts
new file mode 100644
--- /dev/null
+++ b/src/a.test.ts
@@ -0,0 +1,3 @@
+describe('test', () => {
+  it('works', () => {});
+});
`;

describe('validateAltitudeContract', () => {
  describe('layout gate', () => {
    it('rejects layout diffs with function bodies', async () => {
      const result = await validateAltitudeContract({
        gate: 'layout',
        diff: layoutWithBody,
        changedFiles: ['src/a.ts'],
      });

      expect(result.valid).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0]!.reason_code).toBe('altitude_contract_violation');
    });

    it('accepts layout diffs with skeleton/comments only', async () => {
      const result = await validateAltitudeContract({
        gate: 'layout',
        diff: layoutWithSkeletonOnly,
        changedFiles: ['src/a.ts'],
      });

      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('rejects layout diffs that include test files', async () => {
      const result = await validateAltitudeContract({
        gate: 'layout',
        diff: testFile,
        changedFiles: ['src/a.test.ts'],
      });

      expect(result.valid).toBe(false);
    });
  });

  describe('public_api gate', () => {
    it('accepts public API exported signatures and types', async () => {
      const result = await validateAltitudeContract({
        gate: 'public_api',
        diff: publicApiWithSignature,
        changedFiles: ['src/a.ts'],
      });

      expect(result.valid).toBe(true);
    });

    it('rejects public_api diffs with function bodies', async () => {
      const result = await validateAltitudeContract({
        gate: 'public_api',
        diff: publicApiWithBody,
        changedFiles: ['src/a.ts'],
      });

      expect(result.valid).toBe(false);
    });
  });

  describe('build gate', () => {
    it('always passes (no restriction)', async () => {
      const result = await validateAltitudeContract({
        gate: 'build',
        diff: layoutWithBody,
        changedFiles: ['src/a.ts'],
      });

      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  describe('unsupported file types', () => {
    it('puts unsupported files in unsupported_files list', async () => {
      const result = await validateAltitudeContract({
        gate: 'layout',
        diff: 'diff --git a/config.yaml b/config.yaml\n+some: value\n',
        changedFiles: ['config.yaml'],
      });

      expect(result.unsupported_files).toContain('config.yaml');
      expect(result.valid).toBe(true); // unsupported files don't fail the gate
    });
  });
});
