import { PassThrough } from 'node:stream';
import { describe, it, expect, test, vi } from 'vitest';
import { ClaudeAgentSdkAgentRunner, claudeSdkMessageDiagnostic, redactSecrets } from '../../../src/adapters/anthropic/claude-agent-sdk-agent-runner.js';
import type { AgentRunEvent } from '../../../src/types/ai.js';
import type { AgentProfile } from '../../../src/types/ai.js';
import type { Counter, Histogram, Meter } from '@opentelemetry/api';
import type { RequestLogOptions, AnthropicBetaHeaderFilterProxy } from '../../../src/adapters/anthropic/anthropic-beta-header-filter-proxy.js';

async function collect(events: AsyncIterable<AgentRunEvent>): Promise<AgentRunEvent[]> {
  const collected: AgentRunEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function makeLogCapture(): { dest: import('pino').DestinationStream; getLogs: () => Record<string, unknown>[] } {
  const stream = new PassThrough();
  const logs: Record<string, unknown>[] = [];
  stream.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        try { logs.push(JSON.parse(trimmed)); } catch { /* skip non-JSON */ }
      }
    }
  });
  return { dest: stream as unknown as import('pino').DestinationStream, getLogs: () => logs };
}

/** Build a stub Meter that records all metric calls for assertion. */
function makeMockMeter() {
  const counterAdds: { name: string; value: number; attrs: Record<string, string> }[] = [];
  const histogramRecords: { name: string; value: number; attrs: Record<string, string> }[] = [];

  function makeCounter(name: string): Counter {
    return {
      add(value: number, attrs?: Record<string, string>) {
        counterAdds.push({ name, value, attrs: attrs ?? {} });
      },
    } as unknown as Counter;
  }

  function makeHistogram(name: string): Histogram {
    return {
      record(value: number, attrs?: Record<string, string>) {
        histogramRecords.push({ name, value, attrs: attrs ?? {} });
      },
    } as unknown as Histogram;
  }

  const meter: Meter = {
    createCounter: (name: string) => makeCounter(name),
    createHistogram: (name: string) => makeHistogram(name),
    createObservableCounter: vi.fn(),
    createObservableGauge: vi.fn(),
    createObservableUpDownCounter: vi.fn(),
    createUpDownCounter: vi.fn(),
    createGauge: vi.fn(),
    addBatchObservableCallback: vi.fn(),
    removeBatchObservableCallback: vi.fn(),
  } as unknown as Meter;

  return { meter, counterAdds, histogramRecords };
}

describe('ClaudeAgentSdkAgentRunner', () => {
  test('passes route profile values to Claude Agent SDK options with adaptive thinking', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } };
    });
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn });

    const events = await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: {
        id: 'impl',
        provider: 'claude_agent_sdk',
        model: 'claude-sonnet-4-5',
        effort: 'medium',
        thinking: 'adaptive',
        setting_sources: ['project'],
      },
    }));

    expect(events).toEqual([{ type: 'assistant', content: [{ type: 'text', text: 'done' }] }]);
    expect(queryFn).toHaveBeenCalledWith({
      prompt: 'implement',
      options: expect.objectContaining({
        cwd: '/tmp/workspace',
        model: 'claude-sonnet-4-5',
        effort: 'medium',
        thinking: { type: 'adaptive' },
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        allowedTools: expect.arrayContaining(['Bash', 'Write', 'Read', 'Edit']),
        settings: expect.objectContaining({
          permissions: expect.objectContaining({
            defaultMode: 'bypassPermissions',
            allow: expect.arrayContaining(['Bash(*)', 'Write(*)', 'Read(*)', 'Edit(*)']),
            additionalDirectories: ['/tmp/workspace'],
          }),
        }),
      }),
    });
  });

  test('materializes required skills as explicit plugins without user settings', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 5 } };
    });
    const materializeRuntimeSkills = vi.fn().mockResolvedValue([{ type: 'local' as const, path: '/plugins/mm-runtime' }]);
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, materializeRuntimeSkills });

    await collect(runner.run({
      route: { task: 'artifact.create', stage: 'new_thread', intent: 'idea', artifact_kind: 'feature_spec' },
      working_directory: '/tmp/workspace',
      prompt: '/mm:planning',
      profile: {
        id: 'artifact',
        provider: 'claude_agent_sdk',
        model: 'claude-sonnet-4-5',
        effort: 'high',
        required_skills: ['mm:planning'],
      },
    }));

    expect(materializeRuntimeSkills).toHaveBeenCalledWith(['mm:planning']);
    expect(queryFn).toHaveBeenCalledWith({
      prompt: '/mm:planning',
      options: expect.objectContaining({
        settingSources: ['project'],
        plugins: [{ type: 'local', path: '/plugins/mm-runtime' }],
        thinking: { type: 'adaptive' },
        effort: 'high',
        settings: expect.objectContaining({
          permissions: expect.objectContaining({
            allow: expect.arrayContaining(['Bash(*)', 'Write(*)']),
          }),
        }),
      }),
    });
  });

  test('does not pass plugins or load user settings when no skills are required', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 5 } };
    });
    const materializeRuntimeSkills = vi.fn();
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, materializeRuntimeSkills });

    await collect(runner.run({
      route: { task: 'question.answer' },
      working_directory: '/tmp/workspace',
      prompt: 'answer',
      profile: {
        id: 'question',
        provider: 'claude_agent_sdk',
        model: 'claude-sonnet-4-5',
        effort: 'low',
        required_skills: [],
      },
    }));

    expect(materializeRuntimeSkills).not.toHaveBeenCalled();
    const call = queryFn.mock.calls[0][0];
    expect(call.options.settingSources).toEqual(['project']);
    expect(call.options).not.toHaveProperty('plugins');
  });

  test('includes model attribute in agent turn counter', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } };
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 5 } };
    });
    const { meter, counterAdds } = makeMockMeter();
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, meter });

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: {
        id: 'impl',
        provider: 'claude_agent_sdk',
        model: 'claude-3-5-sonnet-20241022',
        effort: 'high',
      },
    }));

    const turnAdd = counterAdds.find(c => c.name === 'autocatalyst.agent.turns');
    expect(turnAdd).toBeDefined();
    expect(turnAdd!.attrs).toMatchObject({ component: 'claude-agent-sdk', model: 'claude-3-5-sonnet-20241022' });
  });

  test('records outcome:success counter when result message has is_error:false', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 5 } };
    });
    const { meter, counterAdds } = makeMockMeter();
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, meter });

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: { id: 'impl', provider: 'claude_agent_sdk', model: 'claude-3-5-sonnet-20241022', effort: 'high' },
    }));

    const outcomeAdd = counterAdds.find(c => c.name === 'autocatalyst.agent.runs');
    expect(outcomeAdd).toBeDefined();
    expect(outcomeAdd!.value).toBe(1);
    expect(outcomeAdd!.attrs).toMatchObject({ component: 'claude-agent-sdk', model: 'claude-3-5-sonnet-20241022', outcome: 'success' });
  });

  test('records outcome:error counter when result message has is_error:true', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'error_max_turns', is_error: true, usage: { input_tokens: 7, output_tokens: 2 } };
    });
    const { meter, counterAdds } = makeMockMeter();
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, meter });

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: { id: 'impl', provider: 'claude_agent_sdk', model: 'claude-3-5-sonnet-20241022', effort: 'high' },
    }));

    const outcomeAdd = counterAdds.find(c => c.name === 'autocatalyst.agent.runs');
    expect(outcomeAdd).toBeDefined();
    expect(outcomeAdd!.attrs).toMatchObject({ outcome: 'error' });
  });

  test('records token usage histogram twice (input and output) from result message', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 42, output_tokens: 17 } };
    });
    const { meter, histogramRecords } = makeMockMeter();
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, meter });

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: { id: 'impl', provider: 'claude_agent_sdk', model: 'claude-3-5-sonnet-20241022', effort: 'high' },
    }));

    const tokenRecords = histogramRecords.filter(h => h.name === 'autocatalyst.agent.token_usage');
    expect(tokenRecords).toHaveLength(2);
    const inputRecord = tokenRecords.find(r => r.attrs['token_type'] === 'input');
    const outputRecord = tokenRecords.find(r => r.attrs['token_type'] === 'output');
    expect(inputRecord!.value).toBe(42);
    expect(outputRecord!.value).toBe(17);
  });

  test('uses model:"unknown" in metric attributes when profile has no model', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const { meter, counterAdds } = makeMockMeter();
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, meter });

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: { id: 'impl', provider: 'claude_agent_sdk', effort: 'high' },
    }));

    const outcomeAdd = counterAdds.find(c => c.name === 'autocatalyst.agent.runs');
    expect(outcomeAdd).toBeDefined();
    expect(outcomeAdd!.attrs).toMatchObject({ model: 'unknown' });
  });

  test('injects CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000 by default when not set in process.env', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn });

    const originalEnv = process.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'];
    delete process.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'];

    try {
      await collect(runner.run({
        route: { task: 'implementation.run' },
        working_directory: '/tmp/workspace',
        prompt: 'implement',
        profile: { id: 'impl', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-5', effort: 'high' },
      }));
    } finally {
      if (originalEnv !== undefined) {
        process.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'] = originalEnv;
      }
    }

    const call = queryFn.mock.calls[0][0];
    expect(call.options.env).toBeDefined();
    expect(call.options.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS']).toBe('128000');
  });

  test('respects caller-provided CLAUDE_CODE_MAX_OUTPUT_TOKENS in process.env', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn });

    const originalEnv = process.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'];
    process.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'] = '64000';

    try {
      await collect(runner.run({
        route: { task: 'implementation.run' },
        working_directory: '/tmp/workspace',
        prompt: 'implement',
        profile: { id: 'impl', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-5', effort: 'high' },
      }));
    } finally {
      if (originalEnv !== undefined) {
        process.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'] = originalEnv;
      } else {
        delete process.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'];
      }
    }

    const call = queryFn.mock.calls[0][0];
    expect(call.options.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS']).toBe('64000');
  });

  test('passes config-declared AC_GH_TOKEN as GH_TOKEN in sandbox env', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, sandboxEnvTokens: ['AC_GH_TOKEN'] });

    const originalToken = process.env['AC_GH_TOKEN'];
    process.env['AC_GH_TOKEN'] = 'ghp_claude_test_token';
    try {
      await collect(runner.run({
        route: { task: 'implementation.run' },
        working_directory: '/tmp/workspace',
        prompt: 'implement',
        profile: { id: 'impl', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-5', effort: 'high' },
      }));
    } finally {
      if (originalToken !== undefined) {
        process.env['AC_GH_TOKEN'] = originalToken;
      } else {
        delete process.env['AC_GH_TOKEN'];
      }
    }

    const call = queryFn.mock.calls[0][0];
    expect(call.options.env['GH_TOKEN']).toBe('ghp_claude_test_token');
  });

  test('passes HOME in sandbox env so Claude Code CLI can locate its config', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn });

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: { id: 'impl', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-5', effort: 'high' },
    }));

    const call = queryFn.mock.calls[0][0];
    // HOME is an explicit documented exception: Claude Code CLI requires it to find ~/.claude config
    expect(call.options.env).toHaveProperty('HOME');
  });

  test('does not forward unrelated process env vars to sandbox', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, sandboxEnvTokens: ['AC_GH_TOKEN'] });

    const originalToken = process.env['AC_GH_TOKEN'];
    const originalUnrelated = process.env['UNRELATED_SECRET'];
    process.env['AC_GH_TOKEN'] = 'ghp_some_token';
    process.env['UNRELATED_SECRET'] = 'should-not-appear';
    try {
      await collect(runner.run({
        route: { task: 'implementation.run' },
        working_directory: '/tmp/workspace',
        prompt: 'implement',
        profile: { id: 'impl', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-5', effort: 'high' },
      }));
    } finally {
      if (originalToken !== undefined) {
        process.env['AC_GH_TOKEN'] = originalToken;
      } else {
        delete process.env['AC_GH_TOKEN'];
      }
      if (originalUnrelated !== undefined) {
        process.env['UNRELATED_SECRET'] = originalUnrelated;
      } else {
        delete process.env['UNRELATED_SECRET'];
      }
    }

    const call = queryFn.mock.calls[0][0];
    expect(call.options.env).not.toHaveProperty('UNRELATED_SECRET');
    expect(call.options.env).not.toHaveProperty('AC_GH_TOKEN');
  });

  test('injects ANTHROPIC_API_KEY and custom headers from profile credentials', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn });

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: {
        id: 'impl',
        provider: 'claude_agent_sdk',
        model: 'claude-sonnet-4-6',
        effort: 'high',
        api_key: 'sk-grove-test-key',
        base_url: 'https://grove-gateway-prod.azure-api.net/grove-foundry-prod/anthropic',
      },
    }));

    const call = queryFn.mock.calls[0][0];
    expect(call.options.env['ANTHROPIC_API_KEY']).toBe('sk-grove-test-key');
    expect(call.options.env['ANTHROPIC_BASE_URL']).toBeDefined();
    expect(call.options.env['ANTHROPIC_CUSTOM_HEADERS']).toBe('api-key: sk-grove-test-key');
  });

  test('routes custom Anthropic base URLs through a loopback proxy even without configured beta values to strip', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn });
    const groveBaseUrl = 'https://grove-gateway-prod.azure-api.net/grove-foundry-prod/anthropic';

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: {
        id: 'impl',
        provider: 'claude_agent_sdk',
        model: 'claude-sonnet-4-6',
        effort: 'high',
        api_key: 'sk-grove-test-key',
        base_url: groveBaseUrl,
      },
    }));

    await runner.close();

    const call = queryFn.mock.calls[0][0];
    expect(call.options.env['ANTHROPIC_API_KEY']).toBe('sk-grove-test-key');
    expect(call.options.env['ANTHROPIC_CUSTOM_HEADERS']).toBe('api-key: sk-grove-test-key');
    expect(call.options.env['ANTHROPIC_BASE_URL']).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('routes custom Anthropic base URLs through a loopback beta-header filter when beta values are configured to strip', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn });
    const groveBaseUrl = 'https://grove-gateway-prod.azure-api.net/grove-foundry-prod/anthropic';

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: {
        id: 'impl',
        provider: 'claude_agent_sdk',
        model: 'claude-sonnet-4-6',
        effort: 'high',
        api_key: 'sk-grove-test-key',
        base_url: groveBaseUrl,
        anthropic_beta_header_filter: {
          strip: ['advisor-tool-2026-03-01'],
        },
      },
    }));

    const call = queryFn.mock.calls[0][0];
    expect(call.options.env['ANTHROPIC_API_KEY']).toBe('sk-grove-test-key');
    expect(call.options.env['ANTHROPIC_CUSTOM_HEADERS']).toBe('api-key: sk-grove-test-key');
    expect(call.options.env['ANTHROPIC_BASE_URL']).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(call.options.env['ANTHROPIC_BASE_URL']).not.toBe(groveBaseUrl);
  });

  test('omits ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL when profile has no credentials', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn });

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: {
        id: 'impl',
        provider: 'claude_agent_sdk',
        model: 'claude-sonnet-4-6',
        effort: 'high',
      },
    }));

    const call = queryFn.mock.calls[0][0];
    expect(call.options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(call.options.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(call.options.env).not.toHaveProperty('ANTHROPIC_CUSTOM_HEADERS');
  });

  test('logs a warning for issue.triage when no GitHub token is in the sandbox environment', async () => {
    const { dest, getLogs } = makeLogCapture();
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, logDestination: dest });

    await collect(runner.run({
      route: { task: 'issue.triage' },
      working_directory: '/tmp/workspace',
      prompt: 'triage issue',
      profile: { id: 'triage', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-5', effort: 'high' },
    }));

    const warning = getLogs().find(
      log => log['level'] === 'warn' && log['event'] === 'sandbox.no_github_token',
    );
    expect(warning).toBeDefined();
    expect(warning?.['route_task']).toBe('issue.triage');
  });

  test('does not log a GitHub token warning when GH_TOKEN is present in sandbox environment', async () => {
    const { dest, getLogs } = makeLogCapture();
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
    });

    const originalToken = process.env['AC_GH_TOKEN'];
    process.env['AC_GH_TOKEN'] = 'ghp_present_token';
    try {
      const runner = new ClaudeAgentSdkAgentRunner({
        queryFn,
        logDestination: dest,
        sandboxEnvTokens: ['AC_GH_TOKEN'],
      });

      await collect(runner.run({
        route: { task: 'issue.triage' },
        working_directory: '/tmp/workspace',
        prompt: 'triage issue',
        profile: { id: 'triage', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-5', effort: 'high' },
      }));
    } finally {
      if (originalToken !== undefined) {
        process.env['AC_GH_TOKEN'] = originalToken;
      } else {
        delete process.env['AC_GH_TOKEN'];
      }
    }

    const warning = getLogs().find(
      log => log['level'] === 'warn' && log['event'] === 'sandbox.no_github_token',
    );
    expect(warning).toBeUndefined();
  });

  test('captures stderr and logs it when SDK exits with error', async () => {
    const { dest, getLogs } = makeLogCapture();
    const queryFn = vi.fn().mockImplementation(function ({ options }: { options: { stderr?: (data: string) => void } }) {
      options.stderr?.('Unable to verify organization\n');
      options.stderr?.('Token may lack user:profile scope\n');
      return (async function* () {
        yield { type: 'result', subtype: 'error_max_turns', is_error: true, usage: { input_tokens: 5, output_tokens: 2 } };
      })();
    });
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, logDestination: dest });

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: { id: 'impl', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-6', effort: 'high' },
    }));

    const stderrLog = getLogs().find(
      log => log['event'] === 'sdk.stderr_on_error',
    );
    expect(stderrLog).toBeDefined();
    expect(stderrLog!['stderr_excerpt']).toContain('Unable to verify organization');
    expect(stderrLog!['stderr_excerpt']).toContain('Token may lack user:profile scope');
    expect(stderrLog!['route_task']).toBe('implementation.run');
  });

  test('redacts secrets from stderr output', async () => {
    const { dest, getLogs } = makeLogCapture();
    const queryFn = vi.fn().mockImplementation(function ({ options }: { options: { stderr?: (data: string) => void } }) {
      options.stderr?.('Error: api_key=sk-ant-secret123 is invalid\n');
      options.stderr?.('Token ghp_R862tsYUn7O33OQqABC leaked\n');
      return (async function* () {
        yield { type: 'result', subtype: 'error_max_turns', is_error: true, usage: { input_tokens: 5, output_tokens: 2 } };
      })();
    });
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, logDestination: dest });

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: { id: 'impl', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-6', effort: 'high' },
    }));

    const stderrLog = getLogs().find(
      log => log['event'] === 'sdk.stderr_on_error',
    );
    expect(stderrLog).toBeDefined();
    expect(stderrLog!['stderr_excerpt']).not.toContain('sk-ant-secret123');
    expect(stderrLog!['stderr_excerpt']).not.toContain('ghp_R862tsYUn7O33OQq');
    expect(stderrLog!['stderr_excerpt']).toContain('[REDACTED]');
  });

  test('does not log stderr when SDK exits successfully', async () => {
    const { dest, getLogs } = makeLogCapture();
    const queryFn = vi.fn().mockImplementation(function ({ options }: { options: { stderr?: (data: string) => void } }) {
      options.stderr?.('some debug noise\n');
      return (async function* () {
        yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 5, output_tokens: 2 } };
      })();
    });
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, logDestination: dest });

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: { id: 'impl', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-6', effort: 'high' },
    }));

    const errorLog = getLogs().find(
      log => log['event'] === 'sdk.stderr_on_error',
    );
    expect(errorLog).toBeUndefined();
  });
});

describe('ClaudeAgentSdkAgentRunner lifecycle logs', () => {
  it('emits agent.run_started and agent.run_completed on success', async () => {
    const dest = new PassThrough();
    const lines: string[] = [];
    dest.on('data', (chunk: Buffer) => {
      chunk.toString().split('\n').filter(Boolean).forEach(l => lines.push(l));
    });

    const mockQueryFn = async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      };
    };

    const runner = new ClaudeAgentSdkAgentRunner({ queryFn: mockQueryFn as any, logDestination: dest as unknown as import('pino').DestinationStream });

    for await (const _ of runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp',
      prompt: 'test',
    })) { /* drain */ }

    dest.end();
    await new Promise(r => dest.on('finish', r));

    const parsed = lines.map(l => JSON.parse(l));
    const started = parsed.find((l: Record<string, unknown>) => l['event'] === 'agent.run_started');
    const completed = parsed.find((l: Record<string, unknown>) => l['event'] === 'agent.run_completed');

    expect(started).toBeDefined();
    expect(started['route_task']).toBe('implementation.run');
    expect(completed).toBeDefined();
    expect(completed['outcome']).toBe('success');
    expect(typeof completed['latency_ms']).toBe('number');
  });

  it('emits agent.run_failed when queryFn throws', async () => {
    const dest = new PassThrough();
    const lines: string[] = [];
    dest.on('data', (chunk: Buffer) => {
      chunk.toString().split('\n').filter(Boolean).forEach(l => lines.push(l));
    });

    const mockQueryFn = async function* (): AsyncGenerator<never> {
      throw new Error('connection refused');
    };

    const runner = new ClaudeAgentSdkAgentRunner({ queryFn: mockQueryFn as any, logDestination: dest as unknown as import('pino').DestinationStream });
    await expect(async () => {
      for await (const _ of runner.run({ route: { task: 'implementation.run' }, working_directory: '/tmp', prompt: 'test' })) {}
    }).rejects.toThrow('connection refused');

    dest.end();
    await new Promise(r => dest.on('finish', r));

    const parsed = lines.map(l => JSON.parse(l));
    const failed = parsed.find((l: Record<string, unknown>) => l['event'] === 'agent.run_failed');
    expect(failed).toBeDefined();
    expect(String(failed['error'])).toContain('connection refused');
  });
});

describe('claudeSdkMessageDiagnostic', () => {
  it('returns safe summary for assistant message with tool use', () => {
    const msg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'secret content should not appear' },
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'rm -rf' } },
        ],
      },
    };
    const diag = claudeSdkMessageDiagnostic(msg as any);
    expect(diag.sdk_message_type).toBe('assistant');
    expect(diag.content_block_types).toEqual(['text', 'tool_use']);
    expect(diag.tool_call_count).toBe(1);
    expect(diag.tool_call_names).toEqual(['Bash']);
    expect(JSON.stringify(diag)).not.toContain('secret content');
    expect(JSON.stringify(diag)).not.toContain('rm -rf');
  });

  it('marks usage_available on result message with usage', () => {
    const msg = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
    const diag = claudeSdkMessageDiagnostic(msg as any);
    expect(diag.sdk_message_type).toBe('result');
    expect(diag.usage_available).toBe(true);
    expect(diag.is_error).toBe(false);
  });

  it('redactSecrets covers GitHub PAT and Slack xapp tokens', () => {
    const text = 'github_pat_11ABCDEF and xapp-1-abc-123 and Authorization: Bearer tok123';
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain('github_pat_11ABCDEF');
    expect(redacted).not.toContain('xapp-1-abc-123');
    expect(redacted).not.toContain('tok123');
  });
});

describe('ClaudeAgentSdkAgentRunner — request log options', () => {
  it('passes requestLog to startProxy when profile has base_url', async () => {
    const requestLog: RequestLogOptions = { logDir: '/tmp/test-request-logs' };
    const capturedOptions: unknown[] = [];

    const mockStartProxy = vi.fn(async (_targetBaseUrl: string, opts: unknown): Promise<AnthropicBetaHeaderFilterProxy> => {
      capturedOptions.push(opts);
      const { createServer } = await import('node:http');
      const server = createServer();
      server.listen(0, '127.0.0.1');
      await new Promise<void>(r => server.once('listening', r));
      const address = server.address() as { port: number };
      return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        server,
        close: async () => {
          server.close();
          await new Promise<void>(r => server.once('close', r));
        },
      };
    });

    const runner = new ClaudeAgentSdkAgentRunner({
      queryFn: async function* () {},
      requestLog,
      startProxy: mockStartProxy,
    });

    const profile: AgentProfile = {
      id: 'test-profile',
      provider: 'anthropic',
      base_url: 'http://127.0.0.1:9999',
      anthropic_beta_header_filter: { strip: ['some-beta-2025-01-01'] },
    };

    try {
      for await (const _ of runner.run({ route: { task: 'test' }, working_directory: '/tmp', prompt: 'test', profile })) {}
    } catch {
      // expected — mock queryFn returns immediately
    }

    await runner.close();

    expect(mockStartProxy).toHaveBeenCalledOnce();
    const passedOpts = capturedOptions[0] as { requestLog?: RequestLogOptions };
    expect(passedOpts.requestLog).toEqual(requestLog);
  });

  it('does not pass requestLog when runner has no requestLog option', async () => {
    const capturedOptions: unknown[] = [];

    const mockStartProxy = vi.fn(async (_targetBaseUrl: string, opts: unknown): Promise<AnthropicBetaHeaderFilterProxy> => {
      capturedOptions.push(opts);
      const { createServer } = await import('node:http');
      const server = createServer();
      server.listen(0, '127.0.0.1');
      await new Promise<void>(r => server.once('listening', r));
      const address = server.address() as { port: number };
      return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        server,
        close: async () => {
          server.close();
          await new Promise<void>(r => server.once('close', r));
        },
      };
    });

    const runner = new ClaudeAgentSdkAgentRunner({
      queryFn: async function* () {},
      startProxy: mockStartProxy,
    });

    const profile: AgentProfile = {
      id: 'test-profile',
      provider: 'anthropic',
      base_url: 'http://127.0.0.1:9999',
    };

    try {
      for await (const _ of runner.run({ route: { task: 'test' }, working_directory: '/tmp', prompt: 'test', profile })) {}
    } catch {}

    await runner.close();

    expect(mockStartProxy).toHaveBeenCalledOnce();
    const passedOpts = capturedOptions[0] as { requestLog?: RequestLogOptions };
    expect(passedOpts.requestLog).toBeUndefined();
  });
});
