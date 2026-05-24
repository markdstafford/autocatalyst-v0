import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, test, vi } from 'vitest';
import {
  AgentRunnerArtifactAuthoringAgent,
  AgentRunnerImplementationAgent,
  AgentRunnerImplementationPlanningAgent,
  AgentRunnerIssueTriageAgent,
  AgentRunnerQuestionAnsweringAgent,
  IssueFilingService,
  buildInitialReviewPrompt,
  buildFinalReviewPrompt,
  buildImplementerResponsePrompt,
  parseImplementationReviewResult,
  drainAgentRunner,
  validateRequiredResultFile,
} from '../../../src/core/ai/agent-services.js';
import { DefaultAgentRoutingPolicy } from '../../../src/core/ai/routing-policy.js';
import { createLogger } from '../../../src/core/logger.js';
import type { AgentDrainSummary, AgentRunEvent, AgentRunRequest, AgentRunner, ImplementationResult } from '../../../src/types/ai.js';
import type { Request, ThreadMessage } from '../../../src/types/events.js';
import type { IssueManager } from '../../../src/types/issue-tracker.js';
import type { ArtifactCommentAnchorCodec } from '../../../src/types/publisher.js';

const conversation = { provider: 'slack', channel_id: 'C123', conversation_id: 'T123' };
const channel = { provider: 'slack', id: 'C123' };
const origin = { provider: 'slack', channel_id: 'C123', conversation_id: 'T123', message_id: 'M123' };

function makeRequest(content = 'Please build this'): Request {
  return {
    id: 'req-1',
    channel,
    conversation,
    origin,
    content,
    author: 'U123',
    received_at: '2026-04-25T00:00:00.000Z',
  };
}

function makeFeedback(content = 'Please revise this'): ThreadMessage {
  return {
    request_id: 'req-1',
    channel,
    conversation,
    origin,
    content,
    author: 'U123',
    received_at: '2026-04-25T00:00:00.000Z',
  };
}

function makePolicy(): DefaultAgentRoutingPolicy {
  return new DefaultAgentRoutingPolicy({
    credentials: [
      { name: 'api-key', type: 'api_key', value: 'test-key' },
    ],
    endpoints: [
      { name: 'direct-ep', protocol: 'anthropic', credential: 'api-key' },
      { name: 'agent-ep', protocol: 'anthropic', credential: 'api-key' },
    ],
    profiles: [
      { name: 'direct', endpoint: 'direct-ep', model: 'claude-haiku-4-5', runner: 'anthropic_direct' },
      { name: 'agent', endpoint: 'agent-ep', model: 'claude-sonnet-4-5', runner: 'claude_agent_sdk' },
    ],
    routing: {
      'artifact.create': 'agent',
      'artifact.revise': 'agent',
      'question.answer': 'agent',
      'implementation.plan': 'agent',
      'implementation.run': 'agent',
      'issue.triage': 'agent',
    },
  });
}

function fakeAgentRunner(onRun: (request: AgentRunRequest) => Promise<void>): AgentRunner {
  return {
    async *run(request: AgentRunRequest): AsyncIterable<AgentRunEvent> {
      await onRun(request);
      yield {
        type: 'assistant',
        content: [{ type: 'text', text: '[Relay] working' }],
      };
    },
  };
}

describe('AgentRunner-backed core AI services', () => {
  test('creates artifacts through AgentRunner using artifact route metadata', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-artifact-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ artifact_path: join(workspace, 'context-human', 'specs', 'feature-test.md') }), 'utf8');
      });
      const service = new AgentRunnerArtifactAuthoringAgent(runner, makePolicy());
      const progress = vi.fn();

      const result = await service.create(makeRequest(), workspace, progress);

      expect(result.artifact_path).toContain('feature-test.md');
      expect(calls[0].route).toMatchObject({
        task: 'artifact.create',
        stage: 'new_thread',
        intent: 'idea',
        artifact_kind: 'feature_spec',
      });
      expect(calls[0].working_directory).toBe(workspace);
      expect(progress).toHaveBeenCalledWith('working');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('artifact creation prompt uses provider-neutral skill wording', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-artifact-prompt-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ artifact_path: join(workspace, 'context-human', 'specs', 'feature-test.md') }), 'utf8');
      });
      const service = new AgentRunnerArtifactAuthoringAgent(runner, makePolicy());

      await service.create(makeRequest(), workspace);

      expect(calls[0].prompt).toContain('Use the `mm:planning` skill');
      expect(calls[0].prompt).not.toContain('/mm:planning');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('artifact creation prompt for idea includes Autocatalyst branch ownership policy and mm:planning override', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-branch-policy-idea-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ artifact_path: join(workspace, 'context-human', 'specs', 'feature-test.md') }), 'utf8');
      });
      const service = new AgentRunnerArtifactAuthoringAgent(runner, makePolicy());

      await service.create(makeRequest(), workspace);

      expect(calls[0].prompt).toContain('Autocatalyst owns git branch and PR management for this run.');
      expect(calls[0].prompt).toContain('Do not create branches, switch branches, or create worktrees.');
      expect(calls[0].prompt).toContain('When using mm:planning, treat its Branch setup section as already complete.');
      expect(calls[0].prompt).toContain('Do not run git checkout -b feat/..., enhancement/..., or fix/...');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('artifact creation prompt for bug intent includes branch ownership policy', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-branch-policy-bug-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ artifact_path: join(workspace, '.autocatalyst', 'triage', 'triage-bug-test.md') }), 'utf8');
      });
      const service = new AgentRunnerArtifactAuthoringAgent(runner, makePolicy());

      await service.create(makeRequest(), workspace, undefined, 'bug');

      expect(calls[0].prompt).toContain('Autocatalyst owns git branch and PR management for this run.');
      expect(calls[0].prompt).toContain('Do not create branches, switch branches, or create worktrees.');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('artifact creation prompt for chore intent includes branch ownership policy', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-branch-policy-chore-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ artifact_path: join(workspace, '.autocatalyst', 'triage', 'triage-chore-test.md') }), 'utf8');
      });
      const service = new AgentRunnerArtifactAuthoringAgent(runner, makePolicy());

      await service.create(makeRequest(), workspace, undefined, 'chore');

      expect(calls[0].prompt).toContain('Autocatalyst owns git branch and PR management for this run.');
      expect(calls[0].prompt).toContain('Do not create branches, switch branches, or create worktrees.');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('artifact revision prompt includes branch ownership policy', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-branch-policy-revise-'));
    try {
      const artifactFilePath = join(workspace, 'context-human', 'specs', 'feature-test.md');
      await mkdir(dirname(artifactFilePath), { recursive: true });
      await writeFile(artifactFilePath, 'original content', 'utf8');
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(artifactFilePath, 'revised content', 'utf8');
        await writeFile(resultPath, JSON.stringify({ comment_responses: [] }), 'utf8');
      });
      const service = new AgentRunnerArtifactAuthoringAgent(runner, makePolicy());

      await service.revise(makeFeedback(), [], artifactFilePath, workspace);

      expect(calls[0].prompt).toContain('Autocatalyst owns git branch and PR management for this run.');
      expect(calls[0].prompt).toContain('Do not create branches, switch branches, or create worktrees.');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });


  test('runs implementation planning through AgentRunner and parses plan_path', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-plan-'));
    try {
      const specPath = join(workspace, 'context-human', 'specs', 'feature-test.md');
      const planPath = join(workspace, 'docs', 'superpowers', 'plans', '2026-05-23-feature-test.md');
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ status: 'complete', plan_path: planPath }), 'utf8');
      });
      const service = new AgentRunnerImplementationPlanningAgent(runner, makePolicy());
      const progress = vi.fn();

      await expect(service.plan(specPath, workspace, progress, { run_id: 'run-1', request_id: 'req-1' })).resolves.toEqual({
        status: 'complete',
        plan_path: planPath,
        question: undefined,
        error: undefined,
      });

      expect(calls[0].route).toEqual({ task: 'implementation.plan', stage: 'planning' });
      expect(calls[0].telemetry).toMatchObject({ phase: 'planning', route_task: 'implementation.plan', run_id: 'run-1', request_id: 'req-1' });
      expect(calls[0].prompt).toContain('superpowers:writing-plans');
      expect(calls[0].prompt).toContain('Do not execute the plan in this session');
      expect(progress).toHaveBeenCalledWith('working');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('implementation planning prompt includes follow-up context when planning is resumed', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-plan-context-'));
    try {
      const specPath = join(workspace, 'context-human', 'specs', 'feature-test.md');
      const planPath = join(workspace, 'docs', 'superpowers', 'plans', '2026-05-23-feature-test.md');
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ status: 'complete', plan_path: planPath }), 'utf8');
      });
      const service = new AgentRunnerImplementationPlanningAgent(runner, makePolicy());

      await service.plan(specPath, workspace, undefined, { run_id: 'run-1', request_id: 'req-1' }, 'Limit scope to the adapter path.');

      expect(calls[0].prompt).toContain('Additional planning context from the human:');
      expect(calls[0].prompt).toContain('Limit scope to the adapter path.');
      expect(calls[0].prompt).toContain('Use this context to answer the previous planning question before writing the plan.');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('implementation prompt with a plan path skips writing-plans and reads the saved plan', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-existing-plan-'));
    try {
      const calls: AgentRunRequest[] = [];
      const planPath = join(workspace, 'docs', 'superpowers', 'plans', 'implementation-plan.md');
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ status: 'complete', summary: 'Done', testing_instructions: 'Run tests' }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      await service.implement('/tmp/spec.md', workspace, undefined, undefined, undefined, planPath);

      expect(calls[0].prompt).toContain(`Read the existing implementation plan at: ${planPath}`);
      expect(calls[0].prompt).toContain('Do not create a new implementation plan');
      expect(calls[0].prompt).not.toContain('superpowers:writing-plans');
      expect(calls[0].prompt).toContain('superpowers:subagent-driven-development');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('implementation prompt includes branch ownership policy', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-branch-policy-impl-'));
    try {
      const specPath = join(workspace, 'context-human', 'specs', 'feature-test.md');
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({
          status: 'complete',
          summary: 'done',
          review_summary: { changes: ['a'], confirm: ['b'] },
          testing_steps: [`cd ${workspace}`],
          resolved_feedback_items: [],
        }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      await service.implement(specPath, workspace);

      expect(calls[0].prompt).toContain('Autocatalyst owns git branch and PR management for this run.');
      expect(calls[0].prompt).toContain('Do not create branches, switch branches, or create worktrees.');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('answers questions in the provided repo directory without creating a cloned workspace', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ac-question-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/write it to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await access(dirname(resultPath));
        await writeFile(resultPath, JSON.stringify({ answer: 'There are 3 open issues.' }), 'utf8');
      });
      const service = new AgentRunnerQuestionAnsweringAgent(runner, makePolicy(), repo);

      await expect(service.answer('How many issues are there?')).resolves.toBe('There are 3 open issues.');
      expect(calls[0].route).toEqual({ task: 'question.answer' });
      expect(calls[0].working_directory).toBe(repo);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('delegates artifact comment anchor preservation to the configured publisher codec', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-artifact-revise-'));
    try {
      const artifactPath = join(workspace, 'context-human', 'specs', 'feature-test.md');
      const resultPathRegex = /Write the result to:\s*(.+)/i;
      const calls: AgentRunRequest[] = [];
      const codec: ArtifactCommentAnchorCodec = {
        extract: vi.fn().mockReturnValue([{ id: 'anchor-1', text: 'anchored text' }]),
        promptInstructions: vi.fn().mockReturnValue(['KEEP TEST ANCHORS']),
        preserve: vi.fn().mockReturnValue('PUBLISHED CONTENT WITH ANCHOR'),
        strip: vi.fn().mockReturnValue('LOCAL CONTENT WITHOUT ANCHOR'),
      };
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const resultPath = request.prompt.match(resultPathRegex)?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await mkdir(dirname(artifactPath), { recursive: true });
        await writeFile(artifactPath, 'agent revised content', 'utf8');
        await writeFile(resultPath, JSON.stringify({ comment_responses: [] }), 'utf8');
      });
      const service = new AgentRunnerArtifactAuthoringAgent(runner, makePolicy(), { commentAnchorCodec: codec });

      const result = await service.revise(makeFeedback(), [], artifactPath, workspace, 'published content with anchors');

      expect(codec.extract).toHaveBeenCalledWith('published content with anchors');
      expect(codec.promptInstructions).toHaveBeenCalledWith([{ id: 'anchor-1', text: 'anchored text' }]);
      expect(calls[0].prompt).toContain('KEEP TEST ANCHORS');
      expect(codec.preserve).toHaveBeenCalledWith('agent revised content', [{ id: 'anchor-1', text: 'anchored text' }]);
      expect(result.page_content).toBe('PUBLISHED CONTENT WITH ANCHOR');
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe('LOCAL CONTENT WITHOUT ANCHOR');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('requires question answering to write the result file', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ac-question-'));
    try {
      const runner: AgentRunner = {
        async *run(): AsyncIterable<AgentRunEvent> {
          yield { type: 'assistant', content: [{ type: 'text', text: 'There are 4 open issues.' }] };
        },
      };
      const service = new AgentRunnerQuestionAnsweringAgent(runner, makePolicy(), repo);

      await expect(service.answer('How many issues are there?')).rejects.toThrow('result file not found');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('runs implementation through AgentRunner and parses canonical status', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ status: 'complete', summary: 'Built it', testing_instructions: 'Run tests' }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      await expect(service.implement('/tmp/spec.md', workspace)).resolves.toMatchObject({
        status: 'complete',
        summary: 'Built it',
      });
      expect(calls[0].route).toEqual({ task: 'implementation.run' });
      expect(calls[0].working_directory).toBe(workspace);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('implementation prompt names skills without slash commands', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-provider-neutral-prompt-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ status: 'complete', summary: 'Done', testing_instructions: 'Run tests' }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      await service.implement('/tmp/spec.md', workspace);

      expect(calls[0].prompt).toContain('superpowers:writing-plans');
      expect(calls[0].prompt).toContain('superpowers:subagent-driven-development');
      expect(calls[0].prompt).not.toContain('/superpowers:');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('implementation prompt forbids force-adding and staging .autocatalyst files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-prompt-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ status: 'complete', summary: 'Done', testing_instructions: 'Run tests' }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      await service.implement('/tmp/spec.md', workspace);

      expect(calls[0].prompt).not.toMatch(/commit anything uncommitted/i);
      expect(calls[0].prompt).toMatch(/never use `git add --force`|never.*git add.*--force/i);
      expect(calls[0].prompt).toMatch(/never stage.*\.autocatalyst|do not stage.*\.autocatalyst/i);
      expect(calls[0].prompt).toContain('.autocatalyst/');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('parseImplementationResult accepts structured review_summary, testing_steps, and resolved_feedback_items', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-structured-'));
    try {
      const runner = fakeAgentRunner(async request => {
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({
          status: 'complete',
          summary: 'short fallback',
          review_summary: {
            changes: ['Added provider config', 'Wired runtime loader'],
            confirm: ['Provider is used for new runs', 'Old runs unaffected'],
          },
          testing_steps: ['cd /workspace', 'npm install', 'npm test'],
          resolved_feedback_items: [
            { id: 'block-abc', resolution_comment: 'Fixed via config loader' },
          ],
        }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      const result = await service.implement('/tmp/spec.md', workspace);

      expect(result.review_summary).toEqual({
        changes: ['Added provider config', 'Wired runtime loader'],
        confirm: ['Provider is used for new runs', 'Old runs unaffected'],
      });
      expect(result.testing_steps).toEqual(['cd /workspace', 'npm install', 'npm test']);
      expect(result.resolved_feedback_items).toEqual([
        { id: 'block-abc', resolution_comment: 'Fixed via config loader' },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('parseImplementationResult tolerates omitted structured fields for backward compatibility', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-legacy-'));
    try {
      const runner = fakeAgentRunner(async request => {
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({
          status: 'complete',
          summary: 'Done',
          testing_instructions: 'npm test',
        }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      const result = await service.implement('/tmp/spec.md', workspace);

      expect(result.review_summary).toBeUndefined();
      expect(result.testing_steps).toBeUndefined();
      expect(result.resolved_feedback_items).toBeUndefined();
      expect(result.summary).toBe('Done');
      expect(result.testing_instructions).toBe('npm test');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('parseImplementationResult rejects resolved_feedback_items entries missing id or resolution_comment', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-invalid-resolved-'));
    try {
      const runner = fakeAgentRunner(async request => {
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({
          status: 'complete',
          resolved_feedback_items: [{ id: 'block-1' }], // missing resolution_comment
        }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      await expect(service.implement('/tmp/spec.md', workspace)).rejects.toThrow(
        /resolved_feedback_items.*resolution_comment/i,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('parseImplementationResult rejects review_summary that is not an object', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-invalid-summary-'));
    try {
      const runner = fakeAgentRunner(async request => {
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({
          status: 'complete',
          review_summary: 'not an object',
        }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      await expect(service.implement('/tmp/spec.md', workspace)).rejects.toThrow(
        /review_summary must be an object/i,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('implementation prompt requests review_summary, testing_steps, and resolved_feedback_items', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-prompt-structured-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ status: 'complete', summary: 'Done' }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      await service.implement('/tmp/spec.md', workspace);

      expect(calls[0].prompt).toContain('review_summary');
      expect(calls[0].prompt).toContain('testing_steps');
      expect(calls[0].prompt).toContain('resolved_feedback_items');
      expect(calls[0].prompt).toContain('changes');
      expect(calls[0].prompt).toContain('confirm');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('feedback implementation prompt instructs agent to preserve feedback IDs exactly', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-feedback-prompt-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ status: 'complete', summary: 'Done' }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());
      const feedbackContext = '[FEEDBACK_ID: block-1]\nFix the crash\n[FEEDBACK_ID: block-2]\nUpdate config example';

      await service.implement('/tmp/spec.md', workspace, feedbackContext);

      // The prompt should instruct the agent to use IDs exactly as given
      expect(calls[0].prompt).toContain('FEEDBACK_ID');
      expect(calls[0].prompt).toContain('resolved_feedback_items');
      expect(calls[0].prompt).toMatch(/id.*exactly|use.*id.*as.*provided|preserve.*id/i);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('feedback implementation prompt tells agent to include only net-new testing steps', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-feedback-delta-steps-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ status: 'complete', summary: 'Done' }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());
      const feedbackContext = '[FEEDBACK_ID: block-1]\nFix the crash';

      await service.implement('/tmp/spec.md', workspace, feedbackContext);

      const prompt = calls[0].prompt;
      // Feedback-pass prompt should NOT say testing_steps must start with cd
      expect(prompt).not.toMatch(/testing_steps must start with a `cd `/);
      // Instead it should say to include only net-new steps
      expect(prompt).toMatch(/net.new|only.*new.*step|omit.*setup|setup.*already/i);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('initial implementation prompt still instructs testing_steps to start with cd step', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-initial-cd-step-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ status: 'complete', summary: 'Done' }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      await service.implement('/tmp/spec.md', workspace);

      expect(calls[0].prompt).toContain('testing_steps must start with a `cd `');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('uses issue triage agent output before creating issues through IssueManager', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-issue-'));
    try {
      const runner = fakeAgentRunner(async request => {
        const match = request.prompt.match(/write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({
          status: 'complete',
          items: [
            {
              proposed_title: 'Crash on login',
              proposed_body: 'The app crashes on login.',
              proposed_labels: ['bug'],
              duplicate_of: null,
            },
          ],
        }), 'utf8');
      });
      const triageAgent = new AgentRunnerIssueTriageAgent(runner, makePolicy());
      const issueManager: Pick<IssueManager, 'create'> = {
        create: vi.fn().mockResolvedValue({ number: 42, url: 'https://example.test/42' }),
      };
      const service = new IssueFilingService(issueManager, triageAgent);

      await expect(service.file(makeRequest('Crash on login'), workspace)).resolves.toMatchObject({
        status: 'complete',
        filed_issues: [{ number: 42, title: 'Crash on login', action: 'filed' }],
      });
      expect(issueManager.create).toHaveBeenCalledWith(workspace, 'Crash on login', 'The app crashes on login.', ['bug']);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function makeCompleteResult(overrides: Partial<ImplementationResult> = {}): ImplementationResult {
  return {
    status: 'complete',
    summary: 'Added X feature.',
    testing_instructions: 'npm test',
    review_summary: {
      changes: ['Added X', 'Wired Y'],
      confirm: ['X works', 'Y loads'],
    },
    testing_steps: ['cd /ws', 'npm test'],
    ...overrides,
  };
}

describe('buildInitialReviewPrompt', () => {
  it('includes artifact path', () => {
    const prompt = buildInitialReviewPrompt('/ws/spec.md', '/ws', makeCompleteResult(), 'diff-content', ['src/foo.ts']);
    expect(prompt).toContain('/ws/spec.md');
  });

  it('includes implementation summary from result fields', () => {
    const prompt = buildInitialReviewPrompt('/ws/spec.md', '/ws', makeCompleteResult(), 'diff-content', ['src/foo.ts']);
    expect(prompt).toContain('Added X feature.');
  });

  it('includes changed file list', () => {
    const prompt = buildInitialReviewPrompt('/ws/spec.md', '/ws', makeCompleteResult(), 'diff-content', ['src/foo.ts', 'src/bar.ts']);
    expect(prompt).toContain('src/foo.ts');
    expect(prompt).toContain('src/bar.ts');
  });

  it('includes diff context', () => {
    const prompt = buildInitialReviewPrompt('/ws/spec.md', '/ws', makeCompleteResult(), 'my-special-diff', ['src/foo.ts']);
    expect(prompt).toContain('my-special-diff');
  });

  it('instructs to write result to the review result path', () => {
    const prompt = buildInitialReviewPrompt('/ws/spec.md', '/ws', makeCompleteResult(), '', []);
    expect(prompt).toContain('impl-review-result.json');
  });
});

describe('buildFinalReviewPrompt', () => {
  it('emphasizes security and pr_readiness categories', () => {
    const prompt = buildFinalReviewPrompt('/ws/spec.md', '/ws', makeCompleteResult(), 'diff', []);
    expect(prompt).toContain('security');
    expect(prompt).toContain('pr_readiness');
  });

  it('includes implementation summary', () => {
    const prompt = buildFinalReviewPrompt('/ws/spec.md', '/ws', makeCompleteResult(), 'diff', []);
    expect(prompt).toContain('Added X feature.');
  });
});

describe('buildImplementerResponsePrompt', () => {
  it('lists every finding ID from the review result', () => {
    const findings = [
      { id: 'INIT-1', severity: 'blocker' as const, category: 'test' as const, finding: 'Missing test.' },
      { id: 'INIT-2', severity: 'warning' as const, category: 'security' as const, finding: 'Log may include creds.' },
    ];
    const prompt = buildImplementerResponsePrompt('/ws/spec.md', '/ws', makeCompleteResult(), findings);
    expect(prompt).toContain('[REVIEW_ID: INIT-1]');
    expect(prompt).toContain('[REVIEW_ID: INIT-2]');
  });

  it('requires one response per finding ID', () => {
    const findings = [{ id: 'INIT-1', severity: 'blocker' as const, category: 'correctness' as const, finding: 'Bug.' }];
    const prompt = buildImplementerResponsePrompt('/ws/spec.md', '/ws', makeCompleteResult(), findings);
    expect(prompt).toContain('review_responses');
  });
});

describe('drainAgentRunner summary', () => {
  it('returns counts and elapsed time', async () => {
    const dest = new PassThrough();
    const lines: string[] = [];
    dest.on('data', (c: Buffer) => c.toString().split('\n').filter(Boolean).forEach(l => lines.push(l)));

    async function* fakeEvents(): AsyncIterable<AgentRunEvent> {
      yield { type: 'assistant', content: [{ type: 'text', text: '[Relay] Planning started.' }] };
      yield { type: 'assistant', content: [{ type: 'text', text: 'No relay here' }] };
      yield { type: 'other' } as AgentRunEvent;
    }

    const logger = createLogger('test', { destination: dest });
    const summary = await drainAgentRunner(fakeEvents(), undefined, logger, 'test-phase');
    dest.end();
    await new Promise(r => dest.on('finish', r));

    expect(summary.event_count).toBe(3);
    expect(summary.assistant_turn_count).toBe(2);
    expect(summary.relay_count).toBe(1);
    expect(summary.elapsed_ms).toBeGreaterThanOrEqual(0);

    const parsed = lines.map(l => JSON.parse(l));
    expect(parsed.find(l => l.event === 'agent.drain_started')).toBeDefined();
    expect(parsed.find(l => l.event === 'agent.drain_completed')).toBeDefined();
  });

  it('logs agent.drain_failed and rethrows on iterator error', async () => {
    const dest = new PassThrough();
    const lines: string[] = [];
    dest.on('data', (c: Buffer) => c.toString().split('\n').filter(Boolean).forEach(l => lines.push(l)));

    async function* failingEvents(): AsyncIterable<AgentRunEvent> {
      yield { type: 'other' } as AgentRunEvent;
      throw new Error('runner exploded');
    }

    const logger = createLogger('test', { destination: dest });
    await expect(drainAgentRunner(failingEvents(), undefined, logger, 'test-phase')).rejects.toThrow('runner exploded');
    dest.end();
    await new Promise(r => dest.on('finish', r));

    const parsed = lines.map(l => JSON.parse(l));
    expect(parsed.find(l => l.event === 'agent.drain_failed')).toBeDefined();
  });
});

describe('validateRequiredResultFile', () => {
  it('logs agent.result_file_found and returns content on success', async () => {
    const dest = new PassThrough();
    const lines: string[] = [];
    dest.on('data', (c: Buffer) => c.toString().split('\n').filter(Boolean).forEach(l => lines.push(l)));
    const logger = createLogger('test', { destination: dest });

    const fakeRead = async (path: string, _enc: string) => {
      if (path === '/workspace/.autocatalyst/result.json') return '{"status":"complete"}';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };

    const content = await validateRequiredResultFile({
      readFileFn: fakeRead,
      path: '/workspace/.autocatalyst/result.json',
      label: 'Implementation',
      logger,
      phase: 'implementation',
      route_task: 'implementation.run',
    });
    dest.end();
    await new Promise(r => dest.on('finish', r));

    expect(content).toBe('{"status":"complete"}');
    const parsed = lines.map(l => JSON.parse(l));
    expect(parsed.find(l => l.event === 'agent.result_file_found')).toBeDefined();
  });

  it('logs agent.result_file_missing with stderr excerpt and throws on ENOENT', async () => {
    const dest = new PassThrough();
    const lines: string[] = [];
    dest.on('data', (c: Buffer) => c.toString().split('\n').filter(Boolean).forEach(l => lines.push(l)));
    const logger = createLogger('test', { destination: dest });

    const fakeRead = async (_path: string, _enc: string): Promise<string> => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };

    const drainSummary: AgentDrainSummary = {
      event_count: 2,
      assistant_turn_count: 1,
      relay_count: 0,
      tool_call_count: 0,
      tool_result_count: 0,
      elapsed_ms: 100,
      diagnostics: { stderr_excerpt_redacted: 'auth failed' },
    };

    await expect(validateRequiredResultFile({
      readFileFn: fakeRead,
      path: '/workspace/.autocatalyst/result.json',
      label: 'Implementation',
      logger,
      phase: 'implementation',
      route_task: 'implementation.run',
      drainSummary,
    })).rejects.toThrow('result file not found');
    dest.end();
    await new Promise(r => dest.on('finish', r));

    const parsed = lines.map(l => JSON.parse(l));
    const missing = parsed.find(l => l.event === 'agent.result_file_missing');
    expect(missing).toBeDefined();
    // Check stderr excerpt is surfaced
    expect(JSON.stringify(missing)).toContain('auth failed');
  });
});

describe('parseImplementationReviewResult', () => {
  it('parses a no_findings result', () => {
    const content = JSON.stringify({ status: 'no_findings', summary: 'All good.', findings: [] });
    const result = parseImplementationReviewResult(content, '/path/result.json');
    expect(result.status).toBe('no_findings');
    expect(result.findings).toHaveLength(0);
    expect(result.requires_human_retest).toBe(false);
  });

  it('parses a findings result with all severity and category values', () => {
    const content = JSON.stringify({
      status: 'findings',
      summary: 'Found issues.',
      findings: [
        { id: 'INIT-1', severity: 'blocker', category: 'correctness', finding: 'Missing null check.' },
        { id: 'INIT-2', severity: 'warning', category: 'test', finding: 'No coverage.' },
        { id: 'INIT-3', severity: 'info', category: 'security', finding: 'Log includes name.' },
        { id: 'INIT-4', severity: 'info', category: 'maintainability', finding: 'Long function.' },
        { id: 'INIT-5', severity: 'info', category: 'docs', finding: 'Missing doc.' },
        { id: 'INIT-6', severity: 'info', category: 'pr_readiness', finding: 'PR size.' },
      ],
    });
    const result = parseImplementationReviewResult(content, '/path/result.json');
    expect(result.status).toBe('findings');
    expect(result.findings).toHaveLength(6);
  });

  it('returns status: failed when content is not valid JSON', () => {
    const result = parseImplementationReviewResult('not-json', '/path/result.json');
    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
  });

  it('propagates requires_human_retest: true when set', () => {
    const content = JSON.stringify({ status: 'findings', summary: 's', findings: [], requires_human_retest: true });
    const result = parseImplementationReviewResult(content, '/path/result.json');
    expect(result.requires_human_retest).toBe(true);
  });
});

describe('AgentServiceTelemetry onAgentRequest callback', () => {
  test('artifact.create calls onAgentRequest before drain completes with resolved model', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-callback-create-'));
    try {
      const events: string[] = [];
      const callbacks: Array<{ model: string; route: { task: string } }> = [];
      const calls: AgentRunRequest[] = [];

      const runner = fakeAgentRunner(async request => {
        events.push('runner');
        calls.push(request);
        const match = request.prompt.match(/write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ artifact_path: join(workspace, 'context-human', 'specs', 'feature-test.md') }), 'utf8');
      });

      const onAgentRequest = vi.fn((metadata: { model: string; route: { task: string } }) => {
        events.push('callback');
        callbacks.push(metadata);
      });

      const service = new AgentRunnerArtifactAuthoringAgent(runner, makePolicy());
      await service.create(makeRequest(), workspace, undefined, 'idea', { run_id: 'run-001', request_id: 'req-001', onAgentRequest });

      expect(onAgentRequest).toHaveBeenCalledOnce();
      expect(callbacks[0].model).toBe('claude-sonnet-4-5');
      expect(callbacks[0].route).toMatchObject({ task: 'artifact.create' });
      expect(events.slice(0, 2)).toEqual(['callback', 'runner']);
      expect(calls[0].profile?.model).toBe('claude-sonnet-4-5');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('artifact.revise calls onAgentRequest before drain completes with resolved model', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-callback-revise-'));
    try {
      const events: string[] = [];
      const callbacks: Array<{ model: string; route: { task: string } }> = [];

      const artifactFilePath = join(workspace, 'context-human', 'specs', 'feature-test.md');
      await mkdir(dirname(artifactFilePath), { recursive: true });
      await writeFile(artifactFilePath, 'original content', 'utf8');

      const runner = fakeAgentRunner(async request => {
        events.push('runner');
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(artifactFilePath, 'revised content', 'utf8');
        await writeFile(resultPath, JSON.stringify({ comment_responses: [] }), 'utf8');
      });

      const onAgentRequest = vi.fn((metadata: { model: string; route: { task: string } }) => {
        events.push('callback');
        callbacks.push(metadata);
      });

      const service = new AgentRunnerArtifactAuthoringAgent(runner, makePolicy());
      await service.revise(makeFeedback(), [], artifactFilePath, workspace, undefined, undefined, { run_id: 'run-001', request_id: 'req-001', onAgentRequest });

      expect(onAgentRequest).toHaveBeenCalledOnce();
      expect(callbacks[0].model).toBe('claude-sonnet-4-5');
      expect(callbacks[0].route).toMatchObject({ task: 'artifact.revise' });
      expect(events.slice(0, 2)).toEqual(['callback', 'runner']);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('implementation.plan calls onAgentRequest before drain completes with resolved model', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-callback-plan-'));
    try {
      const events: string[] = [];
      const callbacks: Array<{ model: string; route: { task: string } }> = [];
      const calls: AgentRunRequest[] = [];

      const specPath = join(workspace, 'context-human', 'specs', 'feature-test.md');
      const planPath = join(workspace, 'docs', 'superpowers', 'plans', '2026-05-24-feature-test.md');
      await mkdir(dirname(specPath), { recursive: true });
      await writeFile(specPath, '# Feature', 'utf8');

      const runner = fakeAgentRunner(async request => {
        events.push('runner');
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await mkdir(dirname(planPath), { recursive: true });
        await writeFile(planPath, '# Plan', 'utf8');
        await writeFile(resultPath, JSON.stringify({ status: 'complete', plan_path: planPath }), 'utf8');
      });

      const onAgentRequest = vi.fn((metadata: { model: string; route: { task: string } }) => {
        events.push('callback');
        callbacks.push(metadata);
      });

      const service = new AgentRunnerImplementationPlanningAgent(runner, makePolicy());
      await service.plan(specPath, workspace, undefined, { run_id: 'run-001', request_id: 'req-001', onAgentRequest });

      expect(onAgentRequest).toHaveBeenCalledOnce();
      expect(callbacks[0].model).toBe('claude-sonnet-4-5');
      expect(callbacks[0].route).toMatchObject({ task: 'implementation.plan' });
      expect(events.slice(0, 2)).toEqual(['callback', 'runner']);
      expect(calls[0].profile?.model).toBe('claude-sonnet-4-5');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('implementation.run calls onAgentRequest before drain completes with resolved model', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-callback-impl-'));
    try {
      const events: string[] = [];
      const callbacks: Array<{ model: string; route: { task: string } }> = [];
      const calls: AgentRunRequest[] = [];

      const specPath = join(workspace, 'context-human', 'specs', 'feature-test.md');
      await mkdir(dirname(specPath), { recursive: true });
      await writeFile(specPath, '# Feature', 'utf8');

      const runner = fakeAgentRunner(async request => {
        events.push('runner');
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ status: 'complete', summary: 'done' }), 'utf8');
      });

      const onAgentRequest = vi.fn((metadata: { model: string; route: { task: string } }) => {
        events.push('callback');
        callbacks.push(metadata);
      });

      const service = new AgentRunnerImplementationAgent(runner, makePolicy());
      await service.implement(specPath, workspace, undefined, undefined, { run_id: 'run-001', request_id: 'req-001', onAgentRequest });

      expect(onAgentRequest).toHaveBeenCalledOnce();
      expect(callbacks[0].model).toBe('claude-sonnet-4-5');
      expect(callbacks[0].route).toMatchObject({ task: 'implementation.run' });
      expect(events.slice(0, 2)).toEqual(['callback', 'runner']);
      expect(calls[0].profile?.model).toBe('claude-sonnet-4-5');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('missing profile.model is reported as unknown', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-callback-unknown-'));
    try {
      const callbacks: Array<{ model: string }> = [];

      const policyWithoutModel = new DefaultAgentRoutingPolicy({
        credentials: [{ name: 'api-key', type: 'api_key', value: 'test-key' }],
        endpoints: [{ name: 'agent-ep', protocol: 'anthropic', credential: 'api-key' }],
        profiles: [{ name: 'agent', endpoint: 'agent-ep', runner: 'claude_agent_sdk' }],
        routing: { 'artifact.create': 'agent', 'artifact.revise': 'agent', 'implementation.plan': 'agent', 'implementation.run': 'agent', 'question.answer': 'agent', 'issue.triage': 'agent' },
      });

      const runner = fakeAgentRunner(async request => {
        const match = request.prompt.match(/write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ artifact_path: join(workspace, 'context-human', 'specs', 'feature-test.md') }), 'utf8');
      });

      const onAgentRequest = vi.fn((metadata: { model: string }) => { callbacks.push(metadata); });
      const service = new AgentRunnerArtifactAuthoringAgent(runner, policyWithoutModel);
      await service.create(makeRequest(), workspace, undefined, 'idea', { onAgentRequest });

      expect(callbacks[0].model).toBe('unknown');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('question.answer calls onAgentRequest before drain completes with resolved model', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ac-callback-question-'));
    try {
      const events: string[] = [];
      const callbacks: Array<{ model: string; route: { task: string } }> = [];

      const runner = fakeAgentRunner(async request => {
        events.push('runner');
        const match = request.prompt.match(/write it to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ answer: 'Yes.' }), 'utf8');
      });

      const onAgentRequest = vi.fn((metadata: { model: string; route: { task: string } }) => {
        events.push('callback');
        callbacks.push(metadata);
      });

      const service = new AgentRunnerQuestionAnsweringAgent(runner, makePolicy(), repo);
      await service.answer('Is it working?', { run_id: 'run-001', request_id: 'req-001', onAgentRequest });

      expect(onAgentRequest).toHaveBeenCalledOnce();
      expect(callbacks[0].model).toBe('claude-sonnet-4-5');
      expect(callbacks[0].route).toMatchObject({ task: 'question.answer' });
      expect(events.slice(0, 2)).toEqual(['callback', 'runner']);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('issue.triage calls onAgentRequest before drain completes with resolved model', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-callback-triage-'));
    try {
      const events: string[] = [];
      const callbacks: Array<{ model: string; route: { task: string } }> = [];

      const runner = fakeAgentRunner(async request => {
        events.push('runner');
        const match = request.prompt.match(/write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ status: 'complete', items: [] }), 'utf8');
      });

      const onAgentRequest = vi.fn((metadata: { model: string; route: { task: string } }) => {
        events.push('callback');
        callbacks.push(metadata);
      });

      const service = new AgentRunnerIssueTriageAgent(runner, makePolicy());
      const request: Request = {
        id: 'req-001',
        channel,
        conversation,
        origin,
        content: 'Bug: login broken',
        author: 'U123',
        received_at: new Date().toISOString(),
      };
      await service.triage(request, workspace, undefined, { run_id: 'run-001', request_id: 'req-001', onAgentRequest });

      expect(onAgentRequest).toHaveBeenCalledOnce();
      expect(callbacks[0].model).toBe('claude-sonnet-4-5');
      expect(callbacks[0].route).toMatchObject({ task: 'issue.triage' });
      expect(events.slice(0, 2)).toEqual(['callback', 'runner']);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
