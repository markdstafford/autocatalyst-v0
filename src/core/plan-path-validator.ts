import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** Resolve and validate an implementation plan path under the workspace plans directory.
 * @param workspacePath Current run workspace root.
 * @param planPath Path returned by the planning agent.
 * @returns Canonical absolute plan path.
 */
export function validateImplementationPlanPath(workspacePath: string, planPath: string): string {
  const candidate = isAbsolute(planPath) ? planPath : resolve(workspacePath, planPath);
  const plansDir = join(workspacePath, 'docs', 'superpowers', 'plans');

  if (!existsSync(plansDir)) {
    throw new Error(`Implementation planning returned plan_path before plans directory exists: ${plansDir}`);
  }
  if (!existsSync(candidate)) {
    throw new Error(`Implementation planning returned non-existent plan_path: ${planPath}`);
  }

  const realPlansDir = realpathSync(plansDir);
  const realPlanPath = realpathSync(candidate);
  const stat = statSync(realPlanPath);
  if (!stat.isFile()) {
    throw new Error(`Implementation planning returned plan_path that is not a file: ${planPath}`);
  }

  const contained = relative(realPlansDir, realPlanPath);
  if (contained === '' || contained.startsWith('..') || isAbsolute(contained)) {
    throw new Error(`Implementation planning returned plan_path outside docs/superpowers/plans: ${planPath}`);
  }

  return realPlanPath;
}