import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface ConvergenceGateContext {
  gate: string;
  base_ref: string;
  checkpoint_ref?: string;
  working_directory: string;
}

export interface BuiltGateContext {
  gate: string;
  base_ref: string;
  diff: string;
  changed_files: string[];
  diff_byte_count: number;
}

export async function buildGateContext(context: ConvergenceGateContext): Promise<BuiltGateContext> {
  const { gate, base_ref, working_directory } = context;

  // Get tracked changes diff from base_ref
  let trackedDiff = '';
  try {
    const result = await exec('git', ['diff', base_ref, '--patch', '--', '.'], { cwd: working_directory, maxBuffer: 10 * 1024 * 1024 });
    trackedDiff = result.stdout;
  } catch {
    // If base_ref doesn't exist or diff fails, return empty
  }

  // Get tracked changed files
  let trackedFiles: string[] = [];
  try {
    const result = await exec('git', ['diff', '--name-only', base_ref, '--', '.'], { cwd: working_directory });
    trackedFiles = result.stdout.split('\n').filter(Boolean);
  } catch {
    // ignore
  }

  // Get non-ignored untracked files
  let untrackedFiles: string[] = [];
  try {
    const result = await exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: working_directory });
    untrackedFiles = result.stdout.split('\n').filter(Boolean);
  } catch {
    // ignore
  }

  // Build untracked file patches using git diff --no-index
  let untrackedDiff = '';
  for (const filePath of untrackedFiles) {
    try {
      // git diff --no-index /dev/null <file> exits with code 1 when there are differences (which is always for new files)
      // We need to catch the error and use stdout
      const fullPath = `${working_directory}/${filePath}`;
      let patchOutput = '';
      try {
        const result = await exec('git', ['diff', '--no-index', '--', '/dev/null', fullPath], { cwd: working_directory, maxBuffer: 1024 * 1024 });
        patchOutput = result.stdout;
      } catch (err: unknown) {
        // git diff --no-index always exits with code 1 when files differ
        if (err && typeof err === 'object' && 'stdout' in err) {
          patchOutput = (err as { stdout: string }).stdout;
        }
      }
      if (patchOutput) {
        // Normalize the path in the diff header to be repo-relative
        patchOutput = patchOutput
          .replace(/^diff --git a\/dev\/null b\/.*$/m, `diff --git a/${filePath} b/${filePath}`)
          .replace(/^--- \/dev\/null$/m, '--- /dev/null')
          .replace(/^\+\+\+ b\/.*$/m, `+++ b/${filePath}`);
        untrackedDiff += patchOutput;
      }
    } catch {
      // Skip files we can't read
    }
  }

  // Normalize changed files: unique, sorted, POSIX paths
  const allChangedFiles = [...new Set([...trackedFiles, ...untrackedFiles])]
    .map(f => f.replace(/\\/g, '/'))
    .sort();

  const fullDiff = trackedDiff + untrackedDiff;

  return {
    gate,
    base_ref,
    diff: fullDiff,
    changed_files: allChangedFiles,
    diff_byte_count: Buffer.byteLength(fullDiff, 'utf8'),
  };
}
