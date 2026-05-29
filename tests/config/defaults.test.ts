import { describe, it, expect } from 'vitest';
import { generateDefaultConfig } from '../../src/config/defaults.js';
import { parseAutocatalystConfig } from '../../src/core/config.js';

describe('generateDefaultConfig', () => {
  it('generates valid YAML that parseAutocatalystConfig can parse without error', () => {
    const content = generateDefaultConfig('my-repo');
    expect(() => parseAutocatalystConfig(content)).not.toThrow();
  });

  it('substitutes repo name in workspace root', () => {
    const content = generateDefaultConfig('amp-cli');
    const result = parseAutocatalystConfig(content);
    expect(result.workspace?.root).toContain('amp-cli');
  });

  it('includes default polling interval', () => {
    const content = generateDefaultConfig('my-repo');
    const result = parseAutocatalystConfig(content);
    expect(result.polling?.interval_ms).toBe(30000);
  });

  it('includes all four ai: sections', () => {
    const content = generateDefaultConfig('my-repo');
    const result = parseAutocatalystConfig(content);
    expect(result.ai?.credentials).toBeDefined();
    expect(result.ai?.endpoints).toBeDefined();
    expect(result.ai?.profiles).toBeDefined();
    expect(result.ai?.routing).toBeDefined();
  });

  it('includes placeholder entries for workspace, channels, and publishers', () => {
    const content = generateDefaultConfig('my-repo');
    const result = parseAutocatalystConfig(content);
    expect(result.workspace).toBeDefined();
    expect(result.channels).toBeDefined();
    expect(result.publishers).toBeDefined();
  });

  it('includes at least one credential, endpoint, and profile', () => {
    const content = generateDefaultConfig('my-repo');
    const result = parseAutocatalystConfig(content);
    expect(result.ai?.credentials?.length).toBeGreaterThan(0);
    expect(result.ai?.endpoints?.length).toBeGreaterThan(0);
    expect(result.ai?.profiles?.length).toBeGreaterThan(0);
  });

  it('includes workspace.auto_prune: true', () => {
    const content = generateDefaultConfig('my-repo');
    const result = parseAutocatalystConfig(content);
    expect(result.workspace?.auto_prune).toBe(true);
  });
});
