const SECRET_REPLACEMENTS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{4,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bgh[opsu]_[A-Za-z0-9_]{4,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bghs_[A-Za-z0-9_]{4,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bxapp-[A-Za-z0-9-]{5,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{5,}\b/g, replacement: '[REDACTED]' },
  { pattern: /(Authorization:\s*Bearer\s+)\S+/gi, replacement: '$1[REDACTED]' },
  { pattern: /(ANTHROPIC_CUSTOM_HEADERS[^=]*=\s*api-key:)\S+/gi, replacement: '$1[REDACTED]' },
  { pattern: /\b(api[_-]?key|secret|credential)\s*[:=]\s*\S+/gi, replacement: '$1=[REDACTED]' },
  { pattern: /\b(password|passwd|pwd)\s*[:=]\s*\S+/gi, replacement: '$1=[REDACTED]' },
];

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const { pattern, replacement } of SECRET_REPLACEMENTS) redacted = redacted.replace(pattern, replacement);
  return redacted;
}
