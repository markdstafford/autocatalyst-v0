const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);

const BODY_PATTERNS = [
  // Function/method body opening with real statements (not just `{` on declaration line)
  /^\+\s*((?:export\s+)?(?:async\s+)?function\s+\w+[^{]*\{)\s*(?![\s}])/, // function with immediate statement
  /^\+\s*(?:return|throw|const|let|var|if|for|while|do|switch)\s+/, // executable statements
  /^\+\s*\w+\s*\(.*\)\s*;/, // function calls
  /^\+\s*(?:it|test|describe|beforeEach|afterEach|beforeAll|afterAll)\s*\(/, // test assertions
  /^\+\s*expect\s*\(/, // jest/vitest expect
  /^\+\s*assert\s*[\.(]/, // assertions
];

const TEST_FILE_PATTERNS = [/\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /__tests__\//];

function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some(p => p.test(filePath));
}

function isSupportedFile(filePath: string): boolean {
  const ext = filePath.match(/\.[^.]+$/)?.[0] ?? '';
  return TS_JS_EXTENSIONS.has(ext);
}

function getAddedLines(diff: string, filePath: string): string[] {
  const lines = diff.split('\n');
  const addedLines: string[] = [];
  let inFile = false;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      inFile = line.includes(` b/${filePath}`) || line.includes(` b/${filePath.replace(/\\/g, '/')}`);
    }
    if (inFile && line.startsWith('+') && !line.startsWith('+++')) {
      addedLines.push(line);
    }
  }
  return addedLines;
}

export interface AltitudeContractViolation {
  id: string;
  file: string;
  message: string;
  reason_code: 'altitude_contract_violation';
}

export interface AltitudeContractValidationResult {
  valid: boolean;
  violations: AltitudeContractViolation[];
  unsupported_files: string[];
}

export async function validateAltitudeContract(args: {
  gate: 'layout' | 'public_api' | 'private_api' | string;
  diff: string;
  changedFiles: string[];
  workingDirectory?: string;
}): Promise<AltitudeContractValidationResult> {
  const { gate, diff, changedFiles } = args;

  if (gate === 'build') {
    return { valid: true, violations: [], unsupported_files: [] };
  }

  const violations: AltitudeContractViolation[] = [];
  const unsupported_files: string[] = [];
  let violationIdx = 0;

  for (const filePath of changedFiles) {
    if (!isSupportedFile(filePath)) {
      unsupported_files.push(filePath);
      continue;
    }

    const addedLines = getAddedLines(diff, filePath);

    if (gate === 'layout') {
      // Reject test files
      if (isTestFile(filePath)) {
        violationIdx++;
        violations.push({
          id: `ALTITUDE-CONTRACT-${violationIdx}`,
          file: filePath,
          message: `layout altitude may not add test files: ${filePath}`,
          reason_code: 'altitude_contract_violation',
        });
        continue;
      }

      // Check added lines for body/statement patterns
      for (const line of addedLines) {
        // Skip comment lines
        if (/^\+\s*\/\//.test(line) || /^\+\s*\/\*/.test(line) || /^\+\s*\*/.test(line)) continue;
        // Skip TODO markers
        if (/TODO\(gate-layout\)/.test(line)) continue;

        if (BODY_PATTERNS.some(p => p.test(line))) {
          violationIdx++;
          violations.push({
            id: `ALTITUDE-CONTRACT-${violationIdx}`,
            file: filePath,
            message: `layout altitude added lower-altitude work in ${filePath}: ${line.slice(0, 80).trim()}`,
            reason_code: 'altitude_contract_violation',
          });
          break; // one violation per file is enough
        }
      }
    } else if (gate === 'public_api') {
      // Reject test files
      if (isTestFile(filePath)) {
        violationIdx++;
        violations.push({
          id: `ALTITUDE-CONTRACT-${violationIdx}`,
          file: filePath,
          message: `public_api altitude may not add test files: ${filePath}`,
          reason_code: 'altitude_contract_violation',
        });
        continue;
      }

      for (const line of addedLines) {
        if (/^\+\s*\/\//.test(line) || /^\+\s*\/\*/.test(line) || /^\+\s*\*/.test(line)) continue;
        if (/TODO\(gate-public_api\)/.test(line)) continue;

        // Reject executable bodies and statements
        const bodyPatterns = [
          /^\+\s*(?:return|throw|const|let|var|if|for|while|do|switch)\s+/,
          /^\+\s*\w+\s*\(.*\)\s*;/,
          /^\+\s*(?:it|test|describe|expect|assert)\s*[\(.(]/,
        ];
        if (bodyPatterns.some(p => p.test(line))) {
          violationIdx++;
          violations.push({
            id: `ALTITUDE-CONTRACT-${violationIdx}`,
            file: filePath,
            message: `public_api altitude added lower-altitude work in ${filePath}: ${line.slice(0, 80).trim()}`,
            reason_code: 'altitude_contract_violation',
          });
          break;
        }
      }
    } else if (gate === 'private_api') {
      // Reject test files
      if (isTestFile(filePath)) {
        violationIdx++;
        violations.push({
          id: `ALTITUDE-CONTRACT-${violationIdx}`,
          file: filePath,
          message: `private_api altitude may not add test files: ${filePath}`,
          reason_code: 'altitude_contract_violation',
        });
        continue;
      }

      // Count placeholder throws - only one is allowed
      const throwPlaceholders = addedLines.filter(l => /throw new Error\("TODO\(gate-private_api\)"\)/.test(l)).length;
      let hasBody = false;

      for (const line of addedLines) {
        if (/^\+\s*\/\//.test(line) || /^\+\s*\/\*/.test(line) || /^\+\s*\*/.test(line)) continue;
        if (/TODO\(gate-private_api\)/.test(line)) continue;

        // Allow single placeholder throw
        if (/throw new Error\(/.test(line) && throwPlaceholders === 1) continue;

        const bodyPatterns = [
          /^\+\s*(?:return|throw)\s+(?!new Error\("TODO)/, // throw not matching placeholder
          /^\+\s*const\s+\w+\s*=\s*(?!\s*\(|\s*async\s*\()/, // const assignment (not arrow fn declaration)
          /^\+\s*(?:let|var)\s+/,
          /^\+\s*if\s*\(/,
          /^\+\s*for\s*[\s(]/,
          /^\+\s*while\s*\(/,
          /^\+\s*(?:it|test|describe|expect|assert)\s*[\(.(]/,
        ];

        if (bodyPatterns.some(p => p.test(line))) {
          hasBody = true;
          break;
        }
      }

      if (hasBody) {
        violationIdx++;
        violations.push({
          id: `ALTITUDE-CONTRACT-${violationIdx}`,
          file: filePath,
          message: `private_api altitude added bodies or tests beyond syntax placeholders in ${filePath}`,
          reason_code: 'altitude_contract_violation',
        });
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    unsupported_files,
  };
}
