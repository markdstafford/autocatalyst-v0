import { describe, expect, it } from 'vitest';
import { filterLayeredFindings } from '../../../src/core/ai/layered-finding-filter.js';

const blockingMaintainabilityFinding = {
  id: 'LAYOUT-1',
  severity: 'blocker' as const,
  category: 'maintainability' as const,
  finding: 'Function body is missing',
};

const blockingCorrectnessFinding = {
  id: 'LAYOUT-2',
  severity: 'blocker' as const,
  category: 'correctness' as const,
  finding: 'Missing implementation',
};

describe('filterLayeredFindings', () => {
  describe('early gate — missing layered metadata', () => {
    it('downgrades missing scope+reason_code to filtered_note with invalid_layered_metadata', () => {
      const result = filterLayeredFindings({
        gate: 'layout',
        round: 1,
        findings: [blockingMaintainabilityFinding],
      });

      expect(result.blockingFindings).toHaveLength(0);
      expect(result.filteredCount).toBe(1);
      expect(result.findings[0]!.layered).toMatchObject({
        disposition: 'filtered_note',
        filter_reason: 'invalid_layered_metadata',
        original_severity: 'blocker',
        original_category: 'maintainability',
      });
    });

    it('does not block even when missing-body finding uses allowed category (maintainability) without metadata', () => {
      const result = filterLayeredFindings({
        gate: 'public_api',
        round: 1,
        findings: [{
          id: 'PUB-1',
          severity: 'blocker' as const,
          category: 'maintainability' as const,
          finding: 'Function body is missing — should be implemented',
          // No scope or reason_code
        }],
      });

      expect(result.blockingFindings).toHaveLength(0);
      expect(result.findings[0]!.layered?.filter_reason).toBe('invalid_layered_metadata');
    });
  });

  describe('early gate — lower altitude scope', () => {
    it('filters lower_altitude scope findings before category check', () => {
      const result = filterLayeredFindings({
        gate: 'public_api',
        round: 1,
        findings: [{
          id: 'PUB-2',
          severity: 'blocker' as const,
          category: 'maintainability' as const,
          finding: 'Missing body',
          scope: 'lower_altitude' as const,
          reason_code: 'missing_lower_altitude_body' as const,
        }],
      });

      expect(result.blockingFindings).toHaveLength(0);
      expect(result.findings[0]!.layered?.filter_reason).toBe('lower_altitude_scope');
    });

    it('filters missing_lower_altitude_body reason code even with current_altitude scope', () => {
      const result = filterLayeredFindings({
        gate: 'private_api',
        round: 1,
        findings: [{
          id: 'PRIV-1',
          severity: 'warning' as const,
          category: 'maintainability' as const,
          finding: 'Body not implemented',
          scope: 'current_altitude' as const,
          reason_code: 'missing_lower_altitude_body' as const,
        }],
      });

      expect(result.blockingFindings).toHaveLength(0);
      expect(result.findings[0]!.layered?.filter_reason).toBe('lower_altitude_reason_code');
    });
  });

  describe('early gate — category not allowed', () => {
    it('filters correctness findings at layout (not in allowlist)', () => {
      const result = filterLayeredFindings({
        gate: 'layout',
        round: 1,
        findings: [{
          id: 'LAYOUT-3',
          severity: 'blocker' as const,
          category: 'correctness' as const,
          finding: 'Logic error',
          scope: 'current_altitude' as const,
          reason_code: 'layout_boundary' as const,
        }],
      });

      expect(result.blockingFindings).toHaveLength(0);
      expect(result.findings[0]!.layered?.filter_reason).toBe('category_not_allowed');
    });
  });

  describe('early gate — blocking findings that pass all filters', () => {
    it('allows maintainability blocker at layout with proper metadata', () => {
      const result = filterLayeredFindings({
        gate: 'layout',
        round: 1,
        findings: [{
          id: 'LAYOUT-4',
          severity: 'blocker' as const,
          category: 'maintainability' as const,
          finding: 'New file duplicates existing boundary',
          scope: 'current_altitude' as const,
          reason_code: 'layout_boundary' as const,
        }],
      });

      expect(result.blockingFindings).toHaveLength(1);
      expect(result.findings[0]!.layered?.disposition).toBe('blocking');
    });
  });

  describe('info severity', () => {
    it('info findings are never blocking', () => {
      const result = filterLayeredFindings({
        gate: 'layout',
        round: 1,
        findings: [{
          id: 'INFO-1',
          severity: 'info' as const,
          category: 'maintainability' as const,
          finding: 'Consider renaming',
        }],
      });

      expect(result.blockingFindings).toHaveLength(0);
      expect(result.findings[0]!.layered?.disposition).toBe('info');
    });
  });

  describe('build gate — no early filtering', () => {
    it('does not filter correctness findings at build gate', () => {
      const result = filterLayeredFindings({
        gate: 'build',
        round: 1,
        findings: [{
          id: 'BUILD-1',
          severity: 'blocker' as const,
          category: 'correctness' as const,
          finding: 'Logic error in body',
          // No scope/reason_code needed at build gate
        }],
      });

      expect(result.blockingFindings).toHaveLength(1);
      expect(result.findings[0]!.layered?.disposition).toBe('blocking');
    });

    it('does not filter missing metadata at build gate', () => {
      const result = filterLayeredFindings({
        gate: 'build',
        round: 1,
        findings: [blockingCorrectnessFinding],
      });

      expect(result.blockingFindings).toHaveLength(1);
    });
  });
});
