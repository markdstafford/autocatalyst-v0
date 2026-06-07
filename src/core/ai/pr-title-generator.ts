import { readFile } from 'node:fs/promises';
import type pino from 'pino';
import { createLogger } from '../logger.js';
import type {
  AgentRoutingPolicy,
  DirectModelRunner,
  IntentClassifyResultListener,
} from '../../types/ai.js';
import type { RequestIntent } from '../../types/runs.js';

export interface PRTitleInput {
  intent: RequestIntent;
  spec_path: string;
  impl_summary: string | undefined;
}

/**
 * Reuses {@link IntentClassifyResultListener}: an optional out-of-band signal
 * carrying the direct-call token usage and resolved profile so the caller can
 * journal the session. Resolves to the title (or null) regardless.
 */
export interface PRTitleGenerator {
  generate(input: PRTitleInput, onResult?: IntentClassifyResultListener): Promise<string | null>;
}

export interface ModelPRTitleGeneratorOptions {
  routingPolicy?: AgentRoutingPolicy;
  model?: string;
  max_tokens?: number;
  logDestination?: pino.DestinationStream;
}

export class ModelPRTitleGenerator implements PRTitleGenerator {
  private readonly logger: pino.Logger;

  constructor(
    private readonly runner: DirectModelRunner,
    private readonly options: ModelPRTitleGeneratorOptions = {},
  ) {
    this.logger = createLogger('pr-title-generator', { destination: options.logDestination });
  }

  async generate(input: PRTitleInput, onResult?: IntentClassifyResultListener): Promise<string | null> {
    let content: string;
    try {
      content = await readFile(input.spec_path, 'utf8');
    } catch (err) {
      this.logger.warn(
        { event: 'pr_title.spec_read_failed', spec_path: input.spec_path, error: String(err) },
        'Failed to read spec for PR title generation',
      );
      return null;
    }

    const truncated = truncateArtifact(content);
    const prompt = buildPrompt(input.intent, truncated, input.impl_summary);
    const route = { task: 'pr.title_generate' as const, intent: input.intent };
    const profile = this.options.routingPolicy?.resolve(route) ?? null;

    let attempt = 0;
    let lastError: unknown;
    while (attempt < 2) {
      try {
        const response = await this.runner.run({
          route,
          profile: profile ?? undefined,
          model: this.options.model,
          max_tokens: this.options.max_tokens ?? 60,
          messages: [{ role: 'user', content: prompt }],
        });
        onResult?.({ usage: response.usage ?? null, profile });
        const title = postProcess(response.text);
        if (title === null) {
          this.logger.warn(
            { event: 'pr_title.invalid_output', raw: response.text },
            'Title post-processing rejected model output',
          );
          return null;
        }
        this.logger.info(
          { event: 'pr_title.generated', intent: input.intent, spec_path: input.spec_path, length: title.length },
          'Generated PR title',
        );
        return title;
      } catch (err) {
        lastError = err;
        attempt += 1;
      }
    }

    this.logger.warn(
      { event: 'pr_title.model_failed', spec_path: input.spec_path, error: String(lastError) },
      'PR title generation failed after retry',
    );
    return null;
  }
}

const MAX_TITLE_LEN = 100;

function postProcess(raw: string): string | null {
  let title = raw.trim();
  if (!title) return null;
  const firstNewline = title.indexOf('\n');
  if (firstNewline !== -1) title = title.slice(0, firstNewline).trim();
  if (
    (title.startsWith('"') && title.endsWith('"')) ||
    (title.startsWith("'") && title.endsWith("'")) ||
    (title.startsWith('`') && title.endsWith('`'))
  ) {
    title = title.slice(1, -1).trim();
  }
  if (title.endsWith('.')) title = title.slice(0, -1).trim();
  if (!title) return null;
  if (title.length > MAX_TITLE_LEN) return null;
  if (title.includes('\n')) return null;
  return title;
}

const IMPL_HEADINGS = [
  '## Design changes',
  '## Technical changes',
  '## Task list',
  '## Implementation',
];
const MAX_ARTIFACT_CHARS = 3000;

function truncateArtifact(content: string): string {
  let earliest = -1;
  for (const heading of IMPL_HEADINGS) {
    const idx = content.indexOf(`\n${heading}`);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
  }
  if (earliest !== -1) return content.slice(0, earliest).trimEnd();
  return content.length > MAX_ARTIFACT_CHARS ? content.slice(0, MAX_ARTIFACT_CHARS) : content;
}

function buildPrompt(intent: RequestIntent, artifact: string, implSummary: string | undefined): string {
  return [
    'You are writing the title for a pull request.',
    '',
    `Intent: ${intent}`,
    'Artifact:',
    '<<<',
    artifact,
    '>>>',
    '',
    'Implementation summary:',
    '<<<',
    implSummary ?? '',
    '>>>',
    '',
    'Rules:',
    '- Output only the title, no prefix, no quotes, no trailing period.',
    '- Max 72 characters. Lowercase except for proper nouns and code identifiers.',
    '- Describe the change concretely (what was done / fixed / added), not the problem.',
    '- Use imperative mood.',
    '',
    'Title:',
  ].join('\n');
}
