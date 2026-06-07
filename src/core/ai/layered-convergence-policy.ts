import type {
  ImplementationReviewConvergenceDepth,
  ImplementationReviewFeedbackDepth,
  WorkflowConfig,
} from '../../types/config.js';
import type { ImplementationReviewFindingCategory } from '../../types/ai.js';

export type LayeredConvergenceGate = 'layout' | 'public_api' | 'private_api' | 'build';

export const IMPLEMENTATION_CONVERGENCE_DEPTHS = ['build_only', 'layout', 'public_api', 'full'] as const;
export const IMPLEMENTATION_FEEDBACK_DEPTHS = ['build_only', 'layout', 'public_api', 'full', 'inherit'] as const;

export interface ResolvedImplementationConvergencePolicy {
  enabled: boolean;
  allow_same_model: boolean;
  depth: ImplementationReviewConvergenceDepth;
  feedback_depth: ImplementationReviewFeedbackDepth;
  max_model_sessions_per_run: number;
}

const ALTITUDES_BY_DEPTH: Record<ImplementationReviewConvergenceDepth, readonly LayeredConvergenceGate[]> = {
  build_only: ['build'],
  layout: ['layout', 'build'],
  public_api: ['layout', 'public_api', 'build'],
  full: ['layout', 'public_api', 'private_api', 'build'],
};

export function altitudesForDepth(depth: ImplementationReviewConvergenceDepth): LayeredConvergenceGate[] {
  return [...ALTITUDES_BY_DEPTH[depth]];
}

export function resolveFeedbackDepth(
  feedbackDepth: ImplementationReviewFeedbackDepth | undefined,
  initialDepth: ImplementationReviewConvergenceDepth,
): ImplementationReviewConvergenceDepth {
  if (feedbackDepth === 'inherit') return initialDepth;
  return feedbackDepth ?? 'build_only';
}

export function resolveImplementationConvergencePolicy(
  config: WorkflowConfig,
  warn?: (warning: object) => void,
): ResolvedImplementationConvergencePolicy {
  const raw = config.implementation_review?.convergence;
  const configuredDepth = raw?.depth ?? 'build_only';
  let effectiveDepth: ImplementationReviewConvergenceDepth = 'build_only';
  if (configuredDepth !== 'build_only') {
    warn?.({
      event: 'implementation_review.convergence.depth_ignored',
      configured_depth: configuredDepth,
      effective_behavior: 'build_only',
    });
  } else {
    effectiveDepth = configuredDepth;
  }
  return {
    enabled: raw?.enabled ?? false,
    allow_same_model: raw?.allow_same_model ?? false,
    depth: effectiveDepth,
    feedback_depth: raw?.feedback_depth ?? 'build_only',
    max_model_sessions_per_run: raw?.max_model_sessions_per_run ?? 24,
  };
}

export function allowedCategoriesForGate(gate: LayeredConvergenceGate): ImplementationReviewFindingCategory[] {
  if (gate === 'layout') return ['maintainability', 'docs'];
  if (gate === 'public_api' || gate === 'private_api') return ['maintainability', 'docs', 'security'];
  return ['correctness', 'test', 'security', 'maintainability', 'docs', 'pr_readiness'];
}

export function gateLabel(gate: LayeredConvergenceGate): string {
  if (gate === 'public_api') return 'Public API';
  if (gate === 'private_api') return 'Private API';
  return gate[0]!.toUpperCase() + gate.slice(1);
}
