import { describe, expect, it } from 'vitest';
import {
  insertConvergedApiSection,
  parseConvergedApiArtifact,
  removeConvergedApiSection,
  renderConvergedApiMarkdown,
} from '../../../src/core/ai/authoring-api-artifact.js';

const artifact = {
  files: [{ path: 'src/example.ts', purpose: 'Expose setup wizard orchestration', exports: ['createWizard'] }],
  public_api: [{
    symbol: 'createWizard',
    signature: 'export function createWizard(input: WizardInput): WizardResult',
    parameters: [{ name: 'input', type: 'WizardInput', description: 'Wizard configuration' }],
    returns: 'WizardResult',
    errors: ['ConfigError when required fields are missing'],
  }],
  types: [{ name: 'WizardInput', shape: 'interface WizardInput { repo: string }', description: 'Wizard configuration input' }],
  notes: 'The API is intentionally small.',
};

describe('authoring API artifact helpers', () => {
  it('parses valid JSON and ignores unknown fields', () => {
    expect(parseConvergedApiArtifact(JSON.stringify({ ...artifact, extra: true }), 'api.json')).toEqual(artifact);
  });

  it('rejects invalid JSON shape with actionable paths', () => {
    expect(() => parseConvergedApiArtifact('{"files":"bad"}', 'api.json')).toThrow(/files must be an array/);
  });

  it('renders canonical Converged API markdown', () => {
    const markdown = renderConvergedApiMarkdown(artifact);
    expect(markdown).toContain('## Converged API');
    expect(markdown).toContain('| `src/example.ts` | Expose setup wizard orchestration | `createWizard` |');
    expect(markdown).toContain('#### `createWizard`');
    expect(markdown).toContain('- `input: WizardInput` — Wizard configuration');
  });

  it('inserts before top-level Task list and ignores headings inside fences', () => {
    const source = '# Spec\n\n## Tech spec\n\n```md\n## Task list\n```\n\n## Task list\n';
    const result = insertConvergedApiSection(source, renderConvergedApiMarkdown(artifact));
    expect(result.indexOf('## Converged API')).toBeLessThan(result.indexOf('## Task list', result.indexOf('```') + 3));
  });

  it('removes an existing top-level generated section before replacement', () => {
    const source = '# Spec\n\n## Tech spec\n\n## Converged API\nold\n\n## Task list\n';
    const result = insertConvergedApiSection(source, renderConvergedApiMarkdown(artifact));
    expect(result).not.toContain('old');
    expect((result.match(/## Converged API/g) ?? []).length).toBe(1);
  });

  it('fails clearly when Task list insertion point is missing', () => {
    expect(() => insertConvergedApiSection('# Spec\n\n## Tech spec\n', renderConvergedApiMarkdown(artifact))).toThrow(/missing the required `## Task list` insertion point/);
  });

  it('removes only the generated top-level section during feedback cleanup', () => {
    const source = '# Spec\n\n## Converged API\nold\n\n## Task list\n- keep\n';
    expect(removeConvergedApiSection(source)).toBe('# Spec\n\n## Task list\n- keep\n');
  });
});
