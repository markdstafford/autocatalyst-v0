import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);

function isSupportedFile(filePath: string): boolean {
  const ext = filePath.match(/\.[^.]+$/)?.[0] ?? '';
  return TS_JS_EXTENSIONS.has(ext);
}

export interface AcceptedAltitudeCheckpoint {
  gate: 'layout' | 'public_api' | 'private_api';
  ref: string;  // git ref (commit SHA or ref name)
}

export type BuildContractDriftKind =
  | 'source_path'
  | 'exported_name'
  | 'exported_signature'
  | 'public_type_shape'
  | 'private_helper_signature';

export interface BuildContractDrift {
  kind: BuildContractDriftKind;
  file: string;
  symbol?: string;
  message: string;
}

export interface BuildContractComparisonResult {
  valid: boolean;
  drift: BuildContractDrift[];
  unsupported_files: string[];
}

// Extract exported names from a TypeScript/JavaScript source file text
function extractExportedNames(source: string): string[] {
  const names: string[] = [];
  const patterns = [
    /^export\s+(?:default\s+)?(?:function|class|const|let|var|enum|type|interface)\s+(\w+)/gm,
    /^export\s+\{\s*([^}]+)\s*\}/gm,
    /^export\s+default\s+(\w+)/gm,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1]) {
        // Handle re-export lists: "export { a, b as c }"
        if (match[1].includes(',') || match[1].includes(' as ')) {
          const parts = match[1].split(',').map(p => p.trim().split(' as ').pop()!.trim());
          names.push(...parts.filter(Boolean));
        } else {
          names.push(match[1].trim());
        }
      }
    }
  }
  return [...new Set(names)].sort();
}

// Extract exported function/interface/type signatures (normalized, bodies stripped)
function extractExportedSignatures(source: string): string[] {
  const signatures: string[] = [];

  // Exported function declarations (strip body)
  const funcPattern = /^(export\s+(?:async\s+)?function\s+\w+\s*(?:<[^>]*>)?\s*\([^)]*\)(?:\s*:\s*[^{;]+)?)/gm;
  let match;
  while ((match = funcPattern.exec(source)) !== null) {
    signatures.push(match[1]!.replace(/\s+/g, ' ').trim());
  }

  // Exported interface declarations
  const interfacePattern = /^(export\s+(?:default\s+)?interface\s+\w+(?:\s+extends\s+[^{]+)?)\s*\{([^}]*)\}/gm;
  while ((match = interfacePattern.exec(source)) !== null) {
    const body = match[2]!.split('\n').map(l => l.trim()).filter(Boolean).join('; ');
    signatures.push(`${match[1]!.trim()} { ${body} }`.replace(/\s+/g, ' '));
  }

  // Exported type aliases
  const typePattern = /^export\s+type\s+(\w+)(?:\s*=\s*([^;]+))?;/gm;
  while ((match = typePattern.exec(source)) !== null) {
    signatures.push(`export type ${match[1]} = ${(match[2] ?? '').trim()}`.replace(/\s+/g, ' '));
  }

  return [...new Set(signatures)].sort();
}

// Extract private (non-exported) top-level function signatures
function extractPrivateHelperSignatures(source: string): string[] {
  const signatures: string[] = [];
  const pattern = /^(?!export)((?:async\s+)?function\s+\w+\s*(?:<[^>]*>)?\s*\([^)]*\)(?:\s*:\s*[^{;]+)?)/gm;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    signatures.push(match[1]!.replace(/\s+/g, ' ').trim());
  }
  return [...new Set(signatures)].sort();
}

async function listFilesAtRef(workingDirectory: string, ref: string): Promise<string[]> {
  const result = await exec('git', ['ls-tree', '--name-only', '-r', ref], { cwd: workingDirectory });
  return result.stdout.split('\n').filter(Boolean);
}

async function readFileAtRef(workingDirectory: string, ref: string, path: string): Promise<string> {
  const result = await exec('git', ['show', `${ref}:${path}`], { cwd: workingDirectory });
  return result.stdout;
}

async function getCurrentFiles(workingDirectory: string): Promise<string[]> {
  // Get tracked files + untracked non-ignored files
  const tracked = await exec('git', ['ls-files'], { cwd: workingDirectory });
  const untracked = await exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: workingDirectory });
  const all = [...tracked.stdout.split('\n'), ...untracked.stdout.split('\n')].filter(Boolean);
  return [...new Set(all)].sort();
}

async function readCurrentFile(workingDirectory: string, path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  return readFile(join(workingDirectory, path), 'utf8');
}

export async function compareBuildToAcceptedContracts(args: {
  workingDirectory: string;
  acceptedCheckpoints: AcceptedAltitudeCheckpoint[];
  currentRef?: string;
  // Injectable for testing
  readFileAtRef?: (ref: string, path: string) => Promise<string>;
  listFilesAtRef?: (ref: string) => Promise<string[]>;
}): Promise<BuildContractComparisonResult> {
  if (args.acceptedCheckpoints.length === 0) {
    return { valid: true, drift: [], unsupported_files: [] };
  }

  const {
    workingDirectory,
    acceptedCheckpoints,
    readFileAtRef: readFile = (ref, path) => readFileAtRef(workingDirectory, ref, path),
    listFilesAtRef: listFiles = (ref) => listFilesAtRef(workingDirectory, ref),
  } = args;

  const drift: BuildContractDrift[] = [];
  const unsupported_files: string[] = [];

  // Get current file list
  const currentFiles = await getCurrentFiles(workingDirectory).catch(() => [] as string[]);

  for (const checkpoint of acceptedCheckpoints) {
    const checkpointFiles = await listFiles(checkpoint.ref).catch(() => [] as string[]);
    const checkpointSourceFiles = checkpointFiles.filter(isSupportedFile);

    // Check source path layout drift
    const currentSourceFiles = new Set(currentFiles.filter(isSupportedFile));
    for (const file of checkpointSourceFiles) {
      // Allow test files and docs to be added in build
      if (file.match(/\.test\.[jt]sx?$/) || file.match(/\.spec\.[jt]sx?$/)) continue;

      if (!currentSourceFiles.has(file)) {
        // Fall back to checking if the file exists on disk (handles non-git working directories)
        const existsOnDisk = await readCurrentFile(workingDirectory, file).then(() => true).catch(() => false);
        if (!existsOnDisk) {
          drift.push({
            kind: 'source_path',
            file,
            message: `source file ${file} from ${checkpoint.gate} checkpoint is missing in build result (moved or deleted)`,
          });
        }
      }
    }

    // Check per-file signature drift
    for (const file of checkpointSourceFiles) {
      if (!isSupportedFile(file)) {
        unsupported_files.push(file);
        continue;
      }

      let checkpointSource: string;
      let currentSource: string;

      try {
        checkpointSource = await readFile(checkpoint.ref, file);
      } catch {
        continue; // File didn't exist at checkpoint; skip
      }

      try {
        currentSource = await readCurrentFile(workingDirectory, file);
      } catch {
        continue; // File doesn't exist currently (handled by path drift above)
      }

      const checkpointExportedNames = extractExportedNames(checkpointSource);
      const currentExportedNames = extractExportedNames(currentSource);

      if (checkpoint.gate === 'public_api' || checkpoint.gate === 'layout') {
        // Check for exported name drift
        const removedNames = checkpointExportedNames.filter(n => !currentExportedNames.includes(n));
        const addedNames = currentExportedNames.filter(n => !checkpointExportedNames.includes(n));

        for (const name of removedNames) {
          drift.push({
            kind: 'exported_name',
            file,
            symbol: name,
            message: `exported name '${name}' from ${checkpoint.gate} checkpoint was removed or renamed in build`,
          });
        }

        // New exported names in build are allowed (build adds implementations)
        // Only flag if a previously accepted name was removed (rename is delete+add)
        for (const name of addedNames) {
          // A new name alongside a removed name indicates a rename
          const isRename = removedNames.length > 0;
          if (isRename) {
            drift.push({
              kind: 'exported_name',
              file,
              symbol: name,
              message: `exported name '${name}' was not present in ${checkpoint.gate} checkpoint — possible rename of reviewed symbol`,
            });
          }
        }
      }

      if (checkpoint.gate === 'public_api') {
        // Check exported signature drift
        const checkpointSigs = extractExportedSignatures(checkpointSource);
        const currentSigs = extractExportedSignatures(currentSource);

        const removedSigs = checkpointSigs.filter(s => !currentSigs.some(cs => cs.startsWith(s.split('{')[0]!.trim())));
        for (const sig of removedSigs) {
          // Only report if not just a TODO replaced by implementation (bodies added = OK)
          // Conservative: report any removed/changed signature
          drift.push({
            kind: 'exported_signature',
            file,
            symbol: sig.match(/\s(\w+)\s*[<(]/)?.[1],
            message: `exported signature from ${checkpoint.gate} checkpoint changed in build: ${sig.slice(0, 60)}`,
          });
        }
      }

      if (checkpoint.gate === 'private_api') {
        // Check private helper signature drift
        const checkpointPriv = extractPrivateHelperSignatures(checkpointSource);
        const currentPriv = extractPrivateHelperSignatures(currentSource);

        const removedPriv = checkpointPriv.filter(s => !currentPriv.includes(s));
        for (const sig of removedPriv) {
          drift.push({
            kind: 'private_helper_signature',
            file,
            symbol: sig.match(/function\s+(\w+)/)?.[1],
            message: `private helper from ${checkpoint.gate} checkpoint changed in build: ${sig.slice(0, 60)}`,
          });
        }
      }
    }
  }

  return {
    valid: drift.length === 0,
    drift,
    unsupported_files: [...new Set(unsupported_files)],
  };
}
