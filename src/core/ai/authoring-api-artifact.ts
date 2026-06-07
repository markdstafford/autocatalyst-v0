import type { ConvergedApiArtifact, ConvergedApiFile, ConvergedApiPublicItem, ConvergedApiTypeItem } from '../../types/ai.js';

export function parseConvergedApiArtifact(content: string, path: string): ConvergedApiArtifact {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(`Converged API artifact at "${path}" is not valid JSON: ${String(err)}`);
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Converged API artifact at "${path}" is not valid JSON: not an object`);
  }

  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj['files'])) {
    throw new Error(`Converged API artifact at "${path}": files must be an array`);
  }
  if (!Array.isArray(obj['public_api'])) {
    throw new Error(`Converged API artifact at "${path}": public_api must be an array`);
  }
  if (!Array.isArray(obj['types'])) {
    throw new Error(`Converged API artifact at "${path}": types must be an array`);
  }

  const files: ConvergedApiFile[] = (obj['files'] as unknown[]).map((f, i) => {
    if (typeof f !== 'object' || f === null || Array.isArray(f)) {
      throw new Error(`Converged API artifact at "${path}": files[${i}] must be an object`);
    }
    const fe = f as Record<string, unknown>;
    const fp = fe['path'];
    if (typeof fp !== 'string' || fp === '') {
      throw new Error(`Converged API artifact at "${path}": file path must be a relative POSIX path: "${fp}"`);
    }
    if (fp.startsWith('/') || fp.includes('\\') || fp.split('/').some((seg) => seg === '..')) {
      throw new Error(`Converged API artifact at "${path}": file path must be a relative POSIX path: "${fp}"`);
    }
    const purpose = typeof fe['purpose'] === 'string' ? fe['purpose'] : '';
    const exports = Array.isArray(fe['exports']) ? (fe['exports'] as unknown[]).map(String) : [];
    return { path: fp, purpose, exports };
  });

  const public_api: ConvergedApiPublicItem[] = (obj['public_api'] as unknown[]).map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`Converged API artifact at "${path}": public_api[${i}] must be an object`);
    }
    const pe = item as Record<string, unknown>;
    const symbol = typeof pe['symbol'] === 'string' && pe['symbol'] !== '' ? pe['symbol'] : '';
    const signature = typeof pe['signature'] === 'string' && pe['signature'] !== '' ? pe['signature'] : '';
    const returns = typeof pe['returns'] === 'string' ? pe['returns'] : '';
    const errors = Array.isArray(pe['errors']) ? (pe['errors'] as unknown[]).map(String) : [];
    const notes = typeof pe['notes'] === 'string' ? pe['notes'] : '';
    const parameters = Array.isArray(pe['parameters'])
      ? (pe['parameters'] as unknown[]).map((p) => {
          if (typeof p !== 'object' || p === null || Array.isArray(p)) {
            return { name: '', type: '', description: '' };
          }
          const pr = p as Record<string, unknown>;
          return {
            name: typeof pr['name'] === 'string' ? pr['name'] : '',
            type: typeof pr['type'] === 'string' ? pr['type'] : '',
            description: typeof pr['description'] === 'string' ? pr['description'] : '',
          };
        })
      : [];
    void notes; // notes field not in ConvergedApiPublicItem
    return { symbol, signature, parameters, returns, errors };
  });

  const types: ConvergedApiTypeItem[] = (obj['types'] as unknown[]).map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`Converged API artifact at "${path}": types[${i}] must be an object`);
    }
    const te = item as Record<string, unknown>;
    const name = typeof te['name'] === 'string' ? te['name'] : '';
    const shape = typeof te['shape'] === 'string' ? te['shape'] : '';
    const description = typeof te['description'] === 'string' ? te['description'] : '';
    return { name, shape, description };
  });

  const notes = typeof obj['notes'] === 'string' ? obj['notes'] : '';

  return { files, public_api, types, notes };
}

export function renderConvergedApiMarkdown(artifact: ConvergedApiArtifact): string {
  const lines: string[] = [];

  lines.push('## Converged API');
  lines.push('');

  // Files table
  lines.push('### Files');
  lines.push('');
  lines.push('| Path | Purpose | Exports |');
  lines.push('|---|---|---|');
  for (const file of artifact.files) {
    const exportsStr = file.exports.map((e) => `\`${e}\``).join(', ');
    lines.push(`| \`${file.path}\` | ${file.purpose} | ${exportsStr} |`);
  }
  lines.push('');

  // Public API
  if (artifact.public_api.length === 0) {
    lines.push('### Public API');
    lines.push('');
    lines.push('_No public API changes._');
    lines.push('');
  } else {
    lines.push('### Public API');
    lines.push('');
    for (const item of artifact.public_api) {
      lines.push(`#### \`${item.symbol}\``);
      lines.push('');
      lines.push('```ts');
      lines.push(item.signature);
      lines.push('```');
      lines.push('');
      if (item.parameters.length > 0) {
        lines.push('- Parameters:');
        for (const param of item.parameters) {
          lines.push(`  - \`${param.name}: ${param.type}\` — ${param.description}`);
        }
      }
      lines.push(`- Returns: \`${item.returns}\``);
      if (item.errors.length > 0) {
        lines.push('- Errors:');
        for (const err of item.errors) {
          lines.push(`  - \`${err}\``);
        }
      }
      lines.push('');
    }
  }

  // Types
  if (artifact.types.length === 0) {
    lines.push('### Types');
    lines.push('');
    lines.push('_No type changes._');
    lines.push('');
  } else {
    lines.push('### Types');
    lines.push('');
    for (const type of artifact.types) {
      lines.push(`#### \`${type.name}\``);
      lines.push('');
      lines.push('```ts');
      lines.push(type.shape);
      lines.push('```');
      lines.push('');
    }
  }

  // Notes
  lines.push('### Notes');
  lines.push('');
  lines.push(artifact.notes);

  return lines.join('\n');
}

interface ParsedHeading {
  lineIndex: number;
  level: number;
  text: string;
  normalizedText: string;
}

function parseTopLevelHeadings(markdown: string): ParsedHeading[] {
  const sourceLines = markdown.split('\n');
  const headings: ParsedHeading[] = [];
  let inFence = false;

  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i]!;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) {
      const level = match[1]!.length;
      const text = match[2]!;
      const normalizedText = text.trim().replace(/\s+/g, ' ').toLowerCase();
      headings.push({ lineIndex: i, level, text, normalizedText });
    }
  }

  return headings;
}

export function insertConvergedApiSection(specMarkdown: string, apiMarkdown: string): string {
  // Remove existing Converged API section first
  const working = removeConvergedApiSection(specMarkdown);

  const sourceLines = working.split('\n');

  // Find the first line matching ## Task list (literal scan, not fence-aware)
  // so that the rendered section is inserted before the first occurrence of the heading
  let insertionLineIndex = -1;
  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i] ?? '';
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match && match[1]!.length === 2) {
      const normalizedText = match[2]!.trim().replace(/\s+/g, ' ').toLowerCase();
      if (normalizedText === 'task list') {
        insertionLineIndex = i;
        break;
      }
    }
  }

  if (insertionLineIndex === -1) {
    throw new Error(
      'Spec is missing the required `## Task list` insertion point. Cannot safely insert `## Converged API` section.',
    );
  }

  const before = sourceLines.slice(0, insertionLineIndex).join('\n');
  const after = sourceLines.slice(insertionLineIndex).join('\n');

  // Ensure a clean join: trim trailing whitespace from before, add double newline separator
  const beforeTrimmed = before.trimEnd();
  return `${beforeTrimmed}\n\n${apiMarkdown}\n\n${after}`;
}

export function removeConvergedApiSection(specMarkdown: string): string {
  const sourceLines = specMarkdown.split('\n');
  const headings = parseTopLevelHeadings(specMarkdown);

  const convergedApiIdx = headings.findIndex((h) => h.level === 2 && h.normalizedText === 'converged api');
  if (convergedApiIdx === -1) {
    return specMarkdown;
  }

  const convergedHeading = headings[convergedApiIdx]!;
  const startLine = convergedHeading.lineIndex;

  // Find the next top-level (##) heading after the converged api section
  const nextTopLevelHeading = headings.slice(convergedApiIdx + 1).find((h) => h.level === 2);

  let endLine: number;
  if (nextTopLevelHeading) {
    endLine = nextTopLevelHeading.lineIndex;
  } else {
    endLine = sourceLines.length;
  }

  // Build the result: lines before the section + lines from the next heading onward
  const before = sourceLines.slice(0, startLine);
  const after = endLine < sourceLines.length ? sourceLines.slice(endLine) : [];

  // Remove trailing blank lines from before and leading blank lines from after
  // to avoid double blank lines at the splice point
  while (before.length > 0 && before[before.length - 1]!.trim() === '') {
    before.pop();
  }
  let afterStart = 0;
  while (afterStart < after.length && after[afterStart]!.trim() === '') {
    afterStart++;
  }
  const afterTrimmed = after.slice(afterStart);

  if (before.length === 0 && afterTrimmed.length === 0) {
    return '';
  }
  if (before.length === 0) {
    return afterTrimmed.join('\n');
  }
  if (afterTrimmed.length === 0) {
    return before.join('\n');
  }

  return `${before.join('\n')}\n\n${afterTrimmed.join('\n')}`;
}
