import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../../../src/core/journal/redaction.js';

describe('redactSecrets', () => {
  it('redacts sk- API keys', () => {
    expect(redactSecrets('sk-1234567890abcdef')).toBe('[REDACTED]');
  });

  it('redacts github_pat_ tokens', () => {
    expect(redactSecrets('github_pat_1234567890_abcdefghijklmnopqrstuvwxyz')).toBe('[REDACTED]');
  });

  it('redacts gho_ tokens', () => {
    expect(redactSecrets('gho_abcdefghijklmnopqrstuvwxyz123456')).toBe('[REDACTED]');
  });

  it('redacts ghs_ tokens', () => {
    expect(redactSecrets('ghs_abcdefghijklmnopqrstuvwxyz123456')).toBe('[REDACTED]');
  });

  it('redacts xapp- tokens', () => {
    expect(redactSecrets('xapp-1-A0123456789-1234567890-abcdef')).toBe('[REDACTED]');
  });

  it('redacts xoxb- Slack tokens', () => {
    expect(redactSecrets('xoxb-1234567890-abcdef')).toBe('[REDACTED]');
  });

  it('redacts Authorization Bearer token but preserves prefix', () => {
    expect(redactSecrets('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer [REDACTED]');
  });

  it('redacts ANTHROPIC_CUSTOM_HEADERS api-key value', () => {
    const result = redactSecrets('ANTHROPIC_CUSTOM_HEADERS=api-key:secret-value');
    expect(result).not.toContain('secret-value');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts api_key assignment value', () => {
    const result = redactSecrets('api_key = secret-value-123');
    expect(result).not.toContain('secret-value-123');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts password assignment value', () => {
    const result = redactSecrets('password: hunter2');
    expect(result).not.toContain('hunter2');
    expect(result).toContain('[REDACTED]');
  });

  it('leaves ordinary text unchanged', () => {
    expect(redactSecrets('hello world')).toBe('hello world');
  });
});
