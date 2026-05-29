import { describe, it, expect } from 'vitest';
import { classifyMessage } from '../../../src/adapters/slack/classifier.js';
import { ThreadRegistry } from '../../../src/adapters/slack/thread-registry.js';

const BOT_ID = 'UBOT001';

function makeRegistry(entries: Record<string, string> = {}): ThreadRegistry {
  const r = new ThreadRegistry();
  for (const [ts, id] of Object.entries(entries)) r.register(ts, id);
  return r;
}

describe('classifyMessage', () => {
  it('returns ignore when message has no @mention', () => {
    expect(classifyMessage(
      { text: 'hello world', user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    ).intent).toBe('ignore');
  });

  it('returns ignore when message text is undefined', () => {
    expect(classifyMessage(
      { text: undefined, user: 'U999', ts: '100.0' },
      'UBOT001',
      new ThreadRegistry(),
    ).intent).toBe('ignore');
  });

  it('returns new_request for @mention in root message (no thread_ts)', () => {
    expect(classifyMessage(
      { text: `<@${BOT_ID}> add a setup wizard`, user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    ).intent).toBe('new_request');
  });

  it('returns new_request for @mention when thread_ts equals ts', () => {
    expect(classifyMessage(
      { text: `<@${BOT_ID}> start an idea`, user: 'U999', ts: '100.0', thread_ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    ).intent).toBe('new_request');
  });

  it('returns thread_message for @mention reply to registered thread', () => {
    const result = classifyMessage(
      { text: `<@${BOT_ID}> that field is confusing`, user: 'U999', ts: '200.0', thread_ts: '100.0' },
      BOT_ID,
      makeRegistry({ '100.0': 'request-xyz' }),
    );
    expect(result.intent).toBe('thread_message');
    if (result.intent === 'thread_message') expect(result.request_id).toBe('request-xyz');
  });

  it('returns ignore for @mention reply to unregistered thread', () => {
    expect(classifyMessage(
      { text: `<@${BOT_ID}> something`, user: 'U999', ts: '200.0', thread_ts: '999.0' },
      BOT_ID,
      makeRegistry(),
    ).intent).toBe('ignore');
  });

  it('returns ignore for messages from the bot itself', () => {
    expect(classifyMessage(
      { text: `<@${BOT_ID}> ignored`, user: BOT_ID, ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    ).intent).toBe('ignore');
  });

  it('does not false-positive when botUserId is a substring of another user ID', () => {
    // BOT_ID is UBOT001; message mentions UBOT0011 (longer, different user)
    expect(classifyMessage(
      { text: '<@UBOT0011> hello', user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    ).intent).toBe('ignore');
  });

  it('returns ignore for in-thread message mentioning only another user (not bot)', () => {
    expect(classifyMessage(
      { text: '<@UOTHER> what do you think?', user: 'U999', ts: '200.0', thread_ts: '100.0' },
      BOT_ID,
      makeRegistry({ '100.0': 'request-xyz' }),
    ).intent).toBe('ignore');
  });

  it('returns thread_message for in-thread message mentioning both bot and another user', () => {
    const result = classifyMessage(
      { text: `<@${BOT_ID}> <@UOTHER> please review`, user: 'U999', ts: '200.0', thread_ts: '100.0' },
      BOT_ID,
      makeRegistry({ '100.0': 'request-xyz' }),
    );
    expect(result.intent).toBe('thread_message');
    if (result.intent === 'thread_message') expect(result.request_id).toBe('request-xyz');
  });
});

describe('classifyMessage — command detection', () => {
  it(':ac-run-status: with no other text → command run.status with empty args', () => {
    const result = classifyMessage(
      { text: ':ac-run-status:', user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    );
    expect(result.intent).toBe('command');
    if (result.intent === 'command') {
      expect(result.command).toBe('run.status');
      expect(result.args).toEqual([]);
    }
  });

  it(':ac-run-list: with no other text → command run.list with empty args', () => {
    const result = classifyMessage(
      { text: ':ac-run-list:', user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    );
    expect(result.intent).toBe('command');
    if (result.intent === 'command') {
      expect(result.command).toBe('run.list');
      expect(result.args).toEqual([]);
    }
  });

  it(':ac-help: run.status → command help with args [run.status]', () => {
    const result = classifyMessage(
      { text: ':ac-help: run.status', user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    );
    expect(result.intent).toBe('command');
    if (result.intent === 'command') {
      expect(result.command).toBe('help');
      expect(result.args).toEqual(['run.status']);
    }
  });

  it('emoji followed by multiple whitespace-separated tokens → args split on whitespace', () => {
    const result = classifyMessage(
      { text: ':ac-help: a b c', user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    );
    expect(result.intent).toBe('command');
    if (result.intent === 'command') expect(result.args).toEqual(['a', 'b', 'c']);
  });

  it('emoji followed by leading/trailing whitespace → args trimmed; no empty strings', () => {
    const result = classifyMessage(
      { text: '  :ac-help:   run.status  ', user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    );
    expect(result.intent).toBe('command');
    if (result.intent === 'command') expect(result.args).toEqual(['run.status']);
  });

  it('emoji only → args is []', () => {
    const result = classifyMessage(
      { text: ':ac-health:', user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    );
    expect(result.intent).toBe('command');
    if (result.intent === 'command') expect(result.args).toEqual([]);
  });

  it('emoji followed only by whitespace → args is []', () => {
    const result = classifyMessage(
      { text: ':ac-health:   ', user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    );
    expect(result.intent).toBe('command');
    if (result.intent === 'command') expect(result.args).toEqual([]);
  });

  it('two recognized command emojis → only first dispatched; second appears in args', () => {
    const result = classifyMessage(
      { text: ':ac-run-list: :ac-run-status:', user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    );
    expect(result.intent).toBe('command');
    if (result.intent === 'command') {
      expect(result.command).toBe('run.list');
      expect(result.args).toEqual([':ac-run-status:']);
    }
  });

  it(':ac-* + @mention in same message → command classification wins; @mention ignored', () => {
    const result = classifyMessage(
      { text: `:ac-run-status: <@${BOT_ID}>`, user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    );
    expect(result.intent).toBe('command');
    if (result.intent === 'command') expect(result.command).toBe('run.status');
  });

  it('unrecognized :ac-foo: with @mention → falls through to new_request (command ignored)', () => {
    const result = classifyMessage(
      { text: `:ac-foo: <@${BOT_ID}> some text`, user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    );
    expect(result.intent).toBe('new_request');
  });

  it('unrecognized :ac-foo: with no @mention → falls through to ignore', () => {
    const result = classifyMessage(
      { text: ':ac-foo: some text', user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    );
    expect(result.intent).toBe('ignore');
  });

  it('message with no :ac-*: pattern → falls through to @mention logic unchanged', () => {
    const result = classifyMessage(
      { text: `<@${BOT_ID}> hello`, user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    );
    expect(result.intent).toBe('new_request');
  });

  it('bot own message with command emoji → still ignored', () => {
    const result = classifyMessage(
      { text: ':ac-run-status:', user: BOT_ID, ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    );
    expect(result.intent).toBe('ignore');
  });
});

describe('classifyMessage — MESSAGE_ONLY_COMMANDS thread guard (ac-set-status)', () => {
  it(':ac-set-status: in registered run thread → command run.set-status with stage arg', () => {
    const result = classifyMessage(
      { text: ':ac-set-status: reviewing_implementation', user: 'U999', ts: '200.0', thread_ts: '100.0' },
      BOT_ID,
      makeRegistry({ '100.0': 'req-001' }),
    );
    expect(result.intent).toBe('command');
    if (result.intent === 'command') {
      expect(result.command).toBe('run.set-status');
      expect(result.args).toEqual(['reviewing_implementation']);
    }
  });

  it(':ac-set-status: in root message → ignore', () => {
    const result = classifyMessage(
      { text: ':ac-set-status: reviewing_implementation', user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    );
    expect(result.intent).toBe('ignore');
  });

  it(':ac-set-status: in unregistered thread → ignore', () => {
    const result = classifyMessage(
      { text: ':ac-set-status: reviewing_implementation', user: 'U999', ts: '200.0', thread_ts: '100.0' },
      BOT_ID,
      makeRegistry(), // '100.0' not registered
    );
    expect(result.intent).toBe('ignore');
  });
});

describe('classifyMessage — prune command', () => {
  it('classifies :ac-prune: completed as a prune command', () => {
    const result = classifyMessage(
      { text: ':ac-prune: completed', user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    );
    expect(result.intent).toBe('command');
    if (result.intent === 'command') {
      expect(result.command).toBe('prune');
      expect(result.args).toEqual(['completed']);
    }
  });
});

describe('classifyMessage — classify-intent command', () => {
  it(':ac-classify-intent: hello world → command classify-intent with args [hello, world]', () => {
    const result = classifyMessage(
      { text: ':ac-classify-intent: hello world', user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    );
    expect(result.intent).toBe('command');
    if (result.intent === 'command') {
      expect(result.command).toBe('classify-intent');
      expect(result.args).toEqual(['hello', 'world']);
    }
  });

  it(':ac-classify-intent: with no trailing text → command classify-intent with empty args', () => {
    const result = classifyMessage(
      { text: ':ac-classify-intent:', user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    );
    expect(result.intent).toBe('command');
    if (result.intent === 'command') {
      expect(result.command).toBe('classify-intent');
      expect(result.args).toEqual([]);
    }
  });

  it(':ac-classify-intent: reviewing_spec looks good → args include context and message tokens', () => {
    const result = classifyMessage(
      { text: ':ac-classify-intent: reviewing_spec looks good', user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    );
    expect(result.intent).toBe('command');
    if (result.intent === 'command') {
      expect(result.command).toBe('classify-intent');
      expect(result.args).toEqual(['reviewing_spec', 'looks', 'good']);
    }
  });
});
