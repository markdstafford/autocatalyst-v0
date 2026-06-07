import type { ImplementationReviewFinding } from '../../types/ai.js';
import { allowedCategoriesForGate } from './layered-convergence-policy.js';

const LOWER_ALTITUDE_REASON_CODES = new Set([
  'missing_lower_altitude_body',
  'missing_lower_altitude_test',
  'missing_lower_altitude_implementation',
  'build_signal_unavailable_until_build',
]);

const VALID_SCOPES = new Set(['current_altitude', 'lower_altitude', 'prior_context']);
const VALID_REASON_CODES = new Set([
  'altitude_contract_violation',
  'layout_boundary',
  'public_api_contract',
  'private_api_contract',
  'security_contract',
  'documentation_gap',
  'missing_lower_altitude_body',
  'missing_lower_altitude_test',
  'missing_lower_altitude_implementation',
  'build_signal_unavailable_until_build',
]);

export interface FilterLayeredFindingsResult {
  findings: ImplementationReviewFinding[];  // all findings with layered metadata attached
  blockingFindings: ImplementationReviewFinding[];  // only findings that block convergence
  filteredCount: number;
}

export function filterLayeredFindings(args: {
  gate: string;
  round: number;
  findings: ImplementationReviewFinding[];
  runId?: string;
}): FilterLayeredFindingsResult {
  const { gate, findings } = args;
  const isEarlyGate = gate === 'layout' || gate === 'public_api' || gate === 'private_api';
  const allowedCategories = isEarlyGate
    ? allowedCategoriesForGate(gate as 'layout' | 'public_api' | 'private_api' | 'build')
    : null; // build gate: no category filtering

  const enrichedFindings: ImplementationReviewFinding[] = [];
  const blockingFindings: ImplementationReviewFinding[] = [];
  let filteredCount = 0;

  for (const finding of findings) {
    const originalSeverity = finding.severity;
    const originalCategory = finding.category;

    // Step 1: Info severity never blocks
    if (originalSeverity === 'info') {
      enrichedFindings.push({
        ...finding,
        layered: {
          scope: finding.scope,
          reason_code: finding.reason_code,
          disposition: 'info',
          original_severity: originalSeverity,
          original_category: originalCategory,
        },
      });
      continue;
    }

    if (isEarlyGate) {
      // Step 2: Missing or invalid layered metadata → filtered_note with invalid_layered_metadata
      const hasValidScope = finding.scope !== undefined && VALID_SCOPES.has(finding.scope);
      const hasValidReasonCode = finding.reason_code !== undefined && VALID_REASON_CODES.has(finding.reason_code);

      if (!hasValidScope || !hasValidReasonCode) {
        enrichedFindings.push({
          ...finding,
          layered: {
            disposition: 'filtered_note',
            filter_reason: 'invalid_layered_metadata',
            original_severity: originalSeverity,
            original_category: originalCategory,
          },
        });
        filteredCount++;
        continue;
      }

      // Step 3: Lower altitude scope → filtered_note with lower_altitude_scope
      if (finding.scope === 'lower_altitude') {
        enrichedFindings.push({
          ...finding,
          layered: {
            scope: finding.scope,
            reason_code: finding.reason_code,
            disposition: 'filtered_note',
            filter_reason: 'lower_altitude_scope',
            original_severity: originalSeverity,
            original_category: originalCategory,
          },
        });
        filteredCount++;
        continue;
      }

      // Step 4: Lower altitude reason codes → filtered_note with lower_altitude_reason_code
      if (finding.reason_code && LOWER_ALTITUDE_REASON_CODES.has(finding.reason_code)) {
        enrichedFindings.push({
          ...finding,
          layered: {
            scope: finding.scope,
            reason_code: finding.reason_code,
            disposition: 'filtered_note',
            filter_reason: 'lower_altitude_reason_code',
            original_severity: originalSeverity,
            original_category: originalCategory,
          },
        });
        filteredCount++;
        continue;
      }

      // Step 5: Category not in allowlist → filtered_note with category_not_allowed
      if (allowedCategories && !allowedCategories.includes(originalCategory)) {
        enrichedFindings.push({
          ...finding,
          layered: {
            scope: finding.scope,
            reason_code: finding.reason_code,
            disposition: 'filtered_note',
            filter_reason: 'category_not_allowed',
            original_severity: originalSeverity,
            original_category: originalCategory,
          },
        });
        filteredCount++;
        continue;
      }
    }

    // Remaining blocker/warning findings block convergence
    const enrichedFinding: ImplementationReviewFinding = {
      ...finding,
      layered: {
        scope: finding.scope,
        reason_code: finding.reason_code,
        disposition: 'blocking',
        original_severity: originalSeverity,
        original_category: originalCategory,
      },
    };
    enrichedFindings.push(enrichedFinding);
    if (originalSeverity === 'blocker' || originalSeverity === 'warning') {
      blockingFindings.push(enrichedFinding);
    }
  }

  return { findings: enrichedFindings, blockingFindings, filteredCount };
}
