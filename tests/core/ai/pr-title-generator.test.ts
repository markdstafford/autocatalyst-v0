import { describe, expect, test } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelPRTitleGenerator } from '../../../src/core/ai/pr-title-generator.js';
import type { DirectModelRunner, DirectModelRunRequest } from '../../../src/types/ai.js';

function fakeRunner(
  textOrFn: string | ((req: DirectModelRunRequest) => string),
): { runner: DirectModelRunner; requests: DirectModelRunRequest[] } {
  const requests: DirectModelRunRequest[] = [];
  const runner: DirectModelRunner = {
    async run(request) {
      requests.push(request);
      return { text: typeof textOrFn === 'function' ? textOrFn(request) : textOrFn };
    },
  };
  return { runner, requests };
}

function extractArtifactSection(prompt: string): string {
  const marker = 'Artifact:\n<<<\n';
  const start = prompt.indexOf(marker) + marker.length;
  const end = prompt.indexOf('\n>>>', start);
  return prompt.slice(start, end);
}

async function withSpec(content: string, run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pr-title-'));
  const path = join(dir, 'spec.md');
  await writeFile(path, content, 'utf8');
  try {
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('ModelPRTitleGenerator', () => {
  test('returns the model-provided title verbatim on happy path', async () => {
    const { runner, requests } = fakeRunner('replace databases.query with dataSources.query');
    const gen = new ModelPRTitleGenerator(runner);
    await withSpec('# Bug: login crash\n\nsome details', async (path) => {
      const title = await gen.generate({
        intent: 'bug',
        spec_path: path,
        impl_summary: 'switched to dataSources.query',
      });
      expect(title).toBe('replace databases.query with dataSources.query');
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].route).toEqual({ task: 'pr.title_generate', intent: 'bug' });
    expect(requests[0].messages[0].content).toContain('Bug: login crash');
    expect(requests[0].messages[0].content).toContain('switched to dataSources.query');
  });

  test('emits direct-call token usage and resolved profile via onResult', async () => {
    const usage = { input: 900, output: 12, cache_read: 0, cache_write: 0 };
    const resolvedProfile = { id: 'pr-title', provider: 'anthropic_direct', model: 'claude-haiku-4-5' };
    const requests: DirectModelRunRequest[] = [];
    const runner: DirectModelRunner = {
      async run(request) {
        requests.push(request);
        return { text: 'add a setup wizard', usage };
      },
    };
    const routingPolicy = {
      resolve: () => resolvedProfile as never,
      resolveOptional: () => resolvedProfile as never,
    };
    const gen = new ModelPRTitleGenerator(runner, { routingPolicy });
    const seen: Array<{ usage?: unknown; profile?: unknown }> = [];
    await withSpec('# Idea: setup wizard\n\ndetails', async (path) => {
      const title = await gen.generate({ intent: 'idea', spec_path: path, impl_summary: 'added wizard' }, (r) => { seen.push(r); });
      expect(title).toBe('add a setup wizard');
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].usage).toEqual(usage);
    expect(seen[0].profile).toEqual(resolvedProfile);
  });

  test('truncates the artifact at the first implementation-heavy heading', async () => {
    const { runner, requests } = fakeRunner('title ok');
    const gen = new ModelPRTitleGenerator(runner);
    const body = [
      '# Enhancement: @-reference files',
      '',
      '## What',
      'allow @foo references',
      '',
      '## Design changes',
      'INCLUDE-NOTHING-AFTER-THIS',
    ].join('\n');
    await withSpec(body, async (path) => {
      await gen.generate({ intent: 'idea', spec_path: path, impl_summary: undefined });
    });
    const promptContent = requests[0].messages[0].content;
    expect(promptContent).toContain('## What');
    expect(promptContent).not.toContain('INCLUDE-NOTHING-AFTER-THIS');
  });

  test('falls back to a character cap when no implementation heading is present', async () => {
    const { runner, requests } = fakeRunner('title ok');
    const gen = new ModelPRTitleGenerator(runner);
    const long = 'x'.repeat(5000);
    await withSpec(long, async (path) => {
      await gen.generate({ intent: 'bug', spec_path: path, impl_summary: undefined });
    });
    const artifactSection = extractArtifactSection(requests[0].messages[0].content);
    expect(artifactSection.length).toBeLessThanOrEqual(3000);
  });

  test('strips surrounding quotes, backticks, and trailing period', async () => {
    for (const raw of ['"fix the thing"', "'fix the thing'", '`fix the thing`', 'fix the thing.', '   fix the thing   ']) {
      const { runner } = fakeRunner(raw);
      const gen = new ModelPRTitleGenerator(runner);
      await withSpec('# x', async (path) => {
        const title = await gen.generate({ intent: 'bug', spec_path: path, impl_summary: undefined });
        expect(title).toBe('fix the thing');
      });
    }
  });

  test('takes only the first line if model returns multiple lines', async () => {
    const { runner } = fakeRunner('fix the thing\nextra commentary');
    const gen = new ModelPRTitleGenerator(runner);
    await withSpec('# x', async (path) => {
      const title = await gen.generate({ intent: 'bug', spec_path: path, impl_summary: undefined });
      expect(title).toBe('fix the thing');
    });
  });

  test('rejects empty, whitespace-only, or over-length titles', async () => {
    for (const raw of ['', '   ', 'x'.repeat(101)]) {
      const { runner } = fakeRunner(raw);
      const gen = new ModelPRTitleGenerator(runner);
      await withSpec('# x', async (path) => {
        const title = await gen.generate({ intent: 'bug', spec_path: path, impl_summary: undefined });
        expect(title).toBeNull();
      });
    }
  });

  test('returns null when the spec file cannot be read', async () => {
    const { runner } = fakeRunner('unused');
    const gen = new ModelPRTitleGenerator(runner);
    const title = await gen.generate({ intent: 'bug', spec_path: '/nonexistent/spec.md', impl_summary: undefined });
    expect(title).toBeNull();
  });

  test('retries once on runner failure then returns null', async () => {
    let calls = 0;
    const runner: DirectModelRunner = {
      async run() {
        calls += 1;
        throw new Error('upstream down');
      },
    };
    const gen = new ModelPRTitleGenerator(runner);
    await withSpec('# x', async (path) => {
      const title = await gen.generate({ intent: 'bug', spec_path: path, impl_summary: undefined });
      expect(title).toBeNull();
    });
    expect(calls).toBe(2);
  });

  test('retries once on runner failure and returns success from the second call', async () => {
    let calls = 0;
    const runner: DirectModelRunner = {
      async run() {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return { text: 'recovered title' };
      },
    };
    const gen = new ModelPRTitleGenerator(runner);
    await withSpec('# x', async (path) => {
      const title = await gen.generate({ intent: 'bug', spec_path: path, impl_summary: undefined });
      expect(title).toBe('recovered title');
    });
    expect(calls).toBe(2);
  });
});
