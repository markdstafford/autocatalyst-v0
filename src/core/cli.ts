import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ParsedArgs {
  command: 'run' | 'init';
  repoPath: string;      // first path (backward compat)
  repoPaths: string[];   // all paths; length >= 1 when --repo is provided
  help: boolean;
  logRequests: boolean;
}

export function parseArgs(args: string[]): ParsedArgs {
  // Detect 'init' as first positional argument
  if (args[0] === 'init') {
    const remaining = args.slice(1);

    if (remaining.includes('--help') || remaining.includes('-h')) {
      return { command: 'init', repoPath: '', repoPaths: [], help: true, logRequests: false };
    }

    const repoIndex = remaining.indexOf('--repo');
    const repoPath =
      repoIndex !== -1 && repoIndex + 1 < remaining.length
        ? remaining[repoIndex + 1]
        : '';

    return { command: 'init', repoPath, repoPaths: repoPath ? [repoPath] : [], help: false, logRequests: false };
  }

  // --help / -h (run command)
  if (args.includes('--help') || args.includes('-h')) {
    return { command: 'run', repoPath: '', repoPaths: [], help: true, logRequests: false };
  }

  const logRequests = args.includes('--log-requests');

  // run command — --repo is required and validated
  const repoIndex = args.indexOf('--repo');
  if (repoIndex === -1 || repoIndex + 1 >= args.length) {
    throw new Error('Missing required argument: --repo <path>');
  }

  // Collect all paths after --repo (until next flag or end)
  const rawPaths: string[] = [];
  let i = repoIndex + 1;
  while (i < args.length && !args[i].startsWith('-')) {
    rawPaths.push(args[i]);
    i++;
  }

  if (rawPaths.length === 0) {
    throw new Error('Missing required argument: --repo <path>');
  }

  const repoPaths = rawPaths.map(p => {
    const resolved = resolve(p);
    if (!existsSync(resolved)) {
      throw new Error(`--repo path does not exist: ${resolved}`);
    }
    if (!statSync(resolved).isDirectory()) {
      throw new Error(`--repo path is not a directory: ${resolved}`);
    }
    return resolved;
  });

  return { command: 'run', repoPath: repoPaths[0], repoPaths, help: false, logRequests };
}

export function printUsage(): void {
  // Help text intentionally writes to stdout (not the logger) so shell wrappers can capture it.
  console.log(`Usage:
  autocatalyst --repo <path>                    Start the service for a single repository
  autocatalyst --repo <path1> <path2> ...       Start the service for multiple repositories
  autocatalyst init [--repo <path>]             Initialize and validate configuration

Options:
  --repo <path> [<path2>...]   Path(s) to target repository/repositories
  --log-requests               Dump outbound proxy requests to <workspace root>/request-logs/
  --help                       Show this help message
`);
}
