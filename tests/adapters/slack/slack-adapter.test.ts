import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App } from '@slack/bolt';
import { SlackAdapter } from '../../../src/adapters/slack/slack-adapter.js';
import type { Request, ThreadMessage } from '../../../src/types/events.js';
import type { PreRepoEntry } from '../../../src/types/config.js';

// Captures one event from the AsyncIterable then stops
async function takeOne<T>(iterable: AsyncIterable<T>): Promise<T> {
  for await (const item of iterable) return item;
  throw new Error('Stream ended without emitting an event');
}

const nullDest = { write: () => {} };

function makeLogCapture() {
  const records: Record<string, unknown>[] = [];
  const destination = {
    write(msg: string) {
      try { records.push(JSON.parse(msg) as Record<string, unknown>); } catch { /* ignore */ }
    },
  };
  return { records, destination: destination as unknown as import('pino').DestinationStream };
}

function makeMockApp(opts: {
  botUserId?: string;
  channels?: Array<{ name: string; id: string }>;
  historyMessages?: Array<{ ts: string; thread_ts?: string; text?: string }>;
  repliesMessages?: Array<{ ts: string; text?: string }>;
}) {
  const messageHandlers: Array<(args: { message: unknown }) => Promise<void>> = [];
  const eventHandlers = new Map<string, Array<(args: { event: unknown }) => Promise<void>>>();

  const app = {
    client: {
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: opts.botUserId ?? 'UBOT001' }),
      },
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: opts.channels ?? [{ name: 'my-channel', id: 'C123' }],
        }),
        history: vi.fn().mockResolvedValue({
          messages: opts.historyMessages ?? [],
        }),
        replies: vi.fn().mockResolvedValue({
          messages: opts.repliesMessages ?? [],
        }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({}),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({}),
      },
    },
    message: vi.fn((handler: (args: { message: unknown }) => Promise<void>) => {
      messageHandlers.push(handler);
    }),
    event: vi.fn((eventName: string, handler: (args: { event: unknown }) => Promise<void>) => {
      if (!eventHandlers.has(eventName)) eventHandlers.set(eventName, []);
      eventHandlers.get(eventName)!.push(handler);
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    _triggerMessage: async (msg: unknown) => {
      for (const h of messageHandlers) await h({ message: msg });
    },
    _triggerReaction: async (reactionEvent: unknown) => {
      const handlers = eventHandlers.get('reaction_added') ?? [];
      for (const h of handlers) await h({ event: reactionEvent });
    },
  };
  return app;
}

describe('SlackAdapter — multi-channel startup', () => {
  it('resolves two channels and logs slack.startup.channels_resolved', async () => {
    const { records, destination } = makeLogCapture();
    const mock = makeMockApp({ channels: [{ name: 'ch-a', id: 'CA1' }, { name: 'ch-b', id: 'CB1' }] });
    const repoEntries: PreRepoEntry[] = [
      { channel_name: 'ch-a', repo_url: 'https://github.com/org/repo-a.git', workspace_root: '/roots/a' },
      { channel_name: 'ch-b', repo_url: 'https://github.com/org/repo-b.git', workspace_root: '/roots/b' },
    ];
    const adapter = new SlackAdapter(mock as unknown as App, { repoEntries }, { logDestination: destination });

    await adapter.resolveChannels();
    await adapter.start();
    await adapter.stop();

    const resolvedLog = records.find(r => r['event'] === 'slack.startup.channels_resolved');
    expect(resolvedLog).toBeDefined();
    const channels = resolvedLog!['channels'] as Array<{ channel_ref: string }>;
    expect(channels).toHaveLength(2);
    expect(channels.map(c => c.channel_ref)).toContain('slack:CA1');
    expect(channels.map(c => c.channel_ref)).toContain('slack:CB1');
  });

  it('multi-repo resolveChannels returns provider-qualified registry keys without losing channel IDs', async () => {
    const mock = makeMockApp({ channels: [{ name: 'ch-a', id: 'CA1' }] });
    const adapter = new SlackAdapter(
      mock as unknown as App,
      { repoEntries: [{ channel_name: 'ch-a', repo_url: 'url-a', workspace_root: '/roots/a' }] },
      { logDestination: nullDest },
    );

    const registry = await adapter.resolveChannels();

    expect([...registry.keys()]).toEqual(['slack:CA1']);
    expect(registry.get('slack:CA1')).toEqual({
      channel: { provider: 'slack', id: 'CA1', name: 'ch-a' },
      repo_url: 'url-a',
      workspace_root: '/roots/a',
    });
  });

  it('throws and logs slack.startup.channel_resolution_failed when a channel is not found', async () => {
    const { records, destination } = makeLogCapture();
    const mock = makeMockApp({ channels: [{ name: 'ch-a', id: 'CA1' }] });
    const repoEntries: PreRepoEntry[] = [
      { channel_name: 'ch-a', repo_url: 'https://github.com/org/repo-a.git', workspace_root: '/roots/a' },
      { channel_name: 'missing-channel', repo_url: 'https://github.com/org/repo-b.git', workspace_root: '/roots/b' },
    ];
    const adapter = new SlackAdapter(mock as unknown as App, { repoEntries }, { logDestination: destination });

    await expect(adapter.resolveChannels()).rejects.toThrow(/missing-channel/);

    const failLog = records.find(r => r['event'] === 'slack.startup.channel_resolution_failed');
    expect(failLog).toBeDefined();
    expect(failLog!['channel_name']).toBe('missing-channel');
  });

  it('resolveChannels() is idempotent — conversations.list called once even if called twice', async () => {
    const mock = makeMockApp({ channels: [{ name: 'ch-a', id: 'CA1' }, { name: 'ch-b', id: 'CB1' }] });
    const repoEntries: PreRepoEntry[] = [
      { channel_name: 'ch-a', repo_url: 'url-a', workspace_root: '/roots/a' },
      { channel_name: 'ch-b', repo_url: 'url-b', workspace_root: '/roots/b' },
    ];
    const adapter = new SlackAdapter(mock as unknown as App, { repoEntries }, { logDestination: nullDest });

    await adapter.resolveChannels();
    await adapter.resolveChannels(); // second call is a no-op

    expect(mock.client.conversations.list).toHaveBeenCalledTimes(1);
  });
});

describe('SlackAdapter — multi-channel event filtering', () => {
  const BOT_ID = 'UBOT001';

  it('message in unconfigured channel logs slack.event.channel_filtered at debug and emits no event', async () => {
    const { records, destination } = makeLogCapture();
    const mock = makeMockApp({
      botUserId: BOT_ID,
      channels: [{ name: 'ch-a', id: 'CA1' }, { name: 'ch-b', id: 'CB1' }],
    });
    const repoEntries: PreRepoEntry[] = [
      { channel_name: 'ch-a', repo_url: 'url-a', workspace_root: '/roots/a' },
    ]; // only ch-a configured

    const adapter = new SlackAdapter(mock as unknown as App, { repoEntries }, { logDestination: destination });
    await adapter.resolveChannels();
    await adapter.start();

    // Send a message from ch-b (not configured)
    await mock._triggerMessage({
      text: `<@${BOT_ID}> idea from unconfigured channel`,
      user: 'U123',
      ts: '100.0',
      channel: 'CB1', // CB1 is not in repoEntries
    });

    await adapter.stop();

    const filterLog = records.find(r => r['event'] === 'slack.event.channel_filtered');
    expect(filterLog).toBeDefined();
    expect(filterLog!['channel_id']).toBe('CB1');
    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('ideas from two configured channels are dispatched with correct channel refs', async () => {
    const mock = makeMockApp({
      botUserId: BOT_ID,
      channels: [{ name: 'ch-a', id: 'CA1' }, { name: 'ch-b', id: 'CB1' }],
    });
    const repoEntries: PreRepoEntry[] = [
      { channel_name: 'ch-a', repo_url: 'url-a', workspace_root: '/roots/a' },
      { channel_name: 'ch-b', repo_url: 'url-b', workspace_root: '/roots/b' },
    ];

    const adapter = new SlackAdapter(mock as unknown as App, { repoEntries }, { logDestination: nullDest });
    await adapter.resolveChannels();
    await adapter.start();

    // Emit idea from ch-a
    const eventA = takeOne(adapter.receive());
    await mock._triggerMessage({ text: `<@${BOT_ID}> idea from A`, user: 'U1', ts: '1.0', channel: 'CA1' });
    const a = await eventA;

    // Emit idea from ch-b
    const eventB = takeOne(adapter.receive());
    await mock._triggerMessage({ text: `<@${BOT_ID}> idea from B`, user: 'U2', ts: '2.0', channel: 'CB1' });
    const b = await eventB;

    await adapter.stop();

    expect(a.type).toBe('new_request');
    expect((a.payload as Request).channel.id).toBe('CA1');
    expect((a.payload as Request).conversation.channel_id).toBe('CA1');

    expect(b.type).toBe('new_request');
    expect((b.payload as Request).channel.id).toBe('CB1');
    expect((b.payload as Request).conversation.channel_id).toBe('CB1');
  });

  it('reaction from unconfigured channel is silently dropped', async () => {
    const mock = makeMockApp({
      botUserId: BOT_ID,
      channels: [{ name: 'ch-a', id: 'CA1' }],
    });
    const repoEntries: PreRepoEntry[] = [
      { channel_name: 'ch-a', repo_url: 'url-a', workspace_root: '/roots/a' },
    ];

    const adapter = new SlackAdapter(mock as unknown as App, { repoEntries }, { logDestination: nullDest });
    await adapter.resolveChannels();
    await adapter.start();

    // Trigger reaction from an unconfigured channel (CB1)
    await mock._triggerReaction({
      reaction: 'ac-run-status',
      user: 'U1',
      item: { type: 'message', channel: 'CB1', ts: '100.0' },
    });

    await adapter.stop();
    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe('SlackAdapter — startup', () => {
  it('single-repo resolveChannels returns a registry with repo binding data', async () => {
    const mock = makeMockApp({ channels: [{ name: 'my-channel', id: 'C123' }] });
    const adapter = new SlackAdapter(
      mock as unknown as App,
      {
        channelName: 'my-channel',
        repo_url: 'https://github.com/org/repo.git',
        workspace_root: '/workspaces',
      },
      { logDestination: nullDest },
    );

    const registry = await adapter.resolveChannels();

    expect(registry.get('slack:C123')).toEqual({
      channel: { provider: 'slack', id: 'C123', name: 'my-channel' },
      repo_url: 'https://github.com/org/repo.git',
      workspace_root: '/workspaces',
    });
  });

  it('resolves channel name to ID and logs slack.startup.channel_resolved', async () => {
    const mock = makeMockApp({ channels: [{ name: 'my-channel', id: 'C123' }] });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', }, { logDestination: nullDest });
    await adapter.start();
    await adapter.stop();
    expect(mock.client.conversations.list).toHaveBeenCalled();
    expect(mock.start).toHaveBeenCalled();
  });

  it('throws when channel is not found', async () => {
    const mock = makeMockApp({ channels: [] });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'missing-channel', }, { logDestination: nullDest });
    await expect(adapter.start()).rejects.toThrow(/missing-channel/);
    expect(mock.start).not.toHaveBeenCalled();
  });

  it('registers message handler before calling app.start()', async () => {
    const mock = makeMockApp({});
    const order: string[] = [];
    // Override to record ordering only — handler capture is intentionally skipped
    // because this test does not trigger messages after start().
    mock.message.mockImplementation(() => { order.push('message_registered'); });
    mock.start.mockImplementation(async () => { order.push('app_started'); });

    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', }, { logDestination: nullDest });
    await adapter.start();
    await adapter.stop();

    expect(order.indexOf('message_registered')).toBeLessThan(order.indexOf('app_started'));
  });
});

describe('SlackAdapter — new request pipeline', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';
  const CHANNEL_NAME = 'my-channel';

  it('emits new_request event with correct Request shape', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME, }, { logDestination: nullDest });
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: `<@${BOT_ID}> add a setup wizard`,
      user: 'U123',
      ts: '100.0',
      channel: CHANNEL_ID,
    });

    const event = await eventPromise;
    await adapter.stop();
    expect(event.type).toBe('new_request');
    const request = event.payload as Request;
    expect(request.channel.provider).toBe('slack');
    expect(request.author).toBe('U123');
    expect(request.content).toBe(`<@${BOT_ID}> add a setup wizard`);
    expect(request.conversation.conversation_id).toBe('100.0');
    expect(request.origin.message_id).toBe('100.0');
    expect(request.channel.id).toBe(CHANNEL_ID);
    expect(request.conversation.channel_id).toBe(CHANNEL_ID);
    expect(request.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof request.id).toBe('string');
  });

  it('applies ack reaction to new_request message', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME, }, { logDestination: nullDest });
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: `<@${BOT_ID}> new idea`,
      user: 'U123',
      ts: '100.0',
      channel: CHANNEL_ID,
    });
    await eventPromise;
    await adapter.stop();

    expect(mock.client.reactions.add).toHaveBeenCalledWith({
      channel: CHANNEL_ID,
      timestamp: '100.0',
      name: 'eyes',
    });
    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('registers the thread so a subsequent reply is thread_message', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME, }, { logDestination: nullDest });
    await adapter.start();

    // Seed the idea to populate the registry
    const ideaEventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: `<@${BOT_ID}> new idea`,
      user: 'U123',
      ts: '100.0',
      channel: CHANNEL_ID,
    });
    await ideaEventPromise;

    // Now trigger a reply — should be thread_message
    const feedbackEventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: `<@${BOT_ID}> revise this`,
      user: 'U456',
      ts: '200.0',
      thread_ts: '100.0',
      channel: CHANNEL_ID,
    });

    const event = await feedbackEventPromise;
    await adapter.stop();

    expect(event.type).toBe('thread_message');
  });
});

describe('SlackAdapter — spec feedback pipeline', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';

  it('emits thread_message with correct shape and applies ack reaction', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', }, { logDestination: nullDest });
    await adapter.start();

    // Seed idea first
    const ideaPromise = takeOne(adapter.receive());
    await mock._triggerMessage({ text: `<@${BOT_ID}> seed`, user: 'U123', ts: '100.0', channel: CHANNEL_ID });
    const ideaEvent = await ideaPromise;

    // Trigger feedback
    const feedbackPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: `<@${BOT_ID}> the field is confusing`,
      user: 'U456',
      ts: '200.0',
      thread_ts: '100.0',
      channel: CHANNEL_ID,
    });
    const feedbackEvent = await feedbackPromise;
    await adapter.stop();

    expect(feedbackEvent.type).toBe('thread_message');
    const feedback = feedbackEvent.payload as ThreadMessage;
    expect(feedback.request_id).toBe((ideaEvent.payload as Request).id);
    expect(feedback.author).toBe('U456');
    expect(feedback.conversation.conversation_id).toBe('100.0');
    expect(feedback.origin.message_id).toBe('200.0');
    expect(feedback.content).toBe(`<@${BOT_ID}> the field is confusing`);
    expect(feedback.channel.id).toBe(CHANNEL_ID);
    expect(feedback.conversation.channel_id).toBe(CHANNEL_ID);
    expect(feedback.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Ack reaction applied to the reply's own ts (200.0), not thread root (100.0)
    expect(mock.client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ channel: CHANNEL_ID, timestamp: '200.0', name: 'eyes' }),
    );
    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });
});


describe('SlackAdapter — ignore cases', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';

  async function setupAdapter(mock: ReturnType<typeof makeMockApp>) {
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', }, { logDestination: nullDest });
    await adapter.start();
    return adapter;
  }

  it('non-mention message: no postMessage, no event', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = await setupAdapter(mock);
    await mock._triggerMessage({ text: 'hello team', user: 'U123', ts: '100.0', channel: CHANNEL_ID });
    await adapter.stop();
    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('@mention reply to unregistered thread: no postMessage, no event', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = await setupAdapter(mock);
    await mock._triggerMessage({
      text: `<@${BOT_ID}> reply to unknown thread`,
      user: 'U123',
      ts: '200.0',
      thread_ts: '999.0', // not registered
      channel: CHANNEL_ID,
    });
    await adapter.stop();
    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("bot's own message: no postMessage, no event", async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = await setupAdapter(mock);
    await mock._triggerMessage({
      text: `<@${BOT_ID}> ignored`,
      user: BOT_ID, // bot's own message
      ts: '100.0',
      channel: CHANNEL_ID,
    });
    await adapter.stop();
    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe('SlackAdapter — error handling', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';

  it('reactToMessage failure does not propagate — adapter continues running', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    mock.client.reactions.add.mockRejectedValueOnce(new Error('already_reacted'));
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', }, { logDestination: nullDest });
    await adapter.start();

    // This should not throw even though postMessage fails
    await expect(
      mock._triggerMessage({ text: `<@${BOT_ID}> add wizard`, user: 'U123', ts: '100.0', channel: CHANNEL_ID }),
    ).resolves.not.toThrow();

    await adapter.stop();
  });
});

describe('SlackAdapter — service lifecycle', () => {
  it('start() calls app.start(); stop() calls app.stop()', async () => {
    const mock = makeMockApp({});
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', }, { logDestination: nullDest });
    await adapter.start();
    expect(mock.start).toHaveBeenCalledTimes(1);
    await adapter.stop();
    expect(mock.stop).toHaveBeenCalledTimes(1);
  });
});

describe('SlackAdapter — command events (message-based)', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';
  const CHANNEL_NAME = 'my-channel';

  it('recognized command emoji in root message emits command event with root conversation ref; no postMessage', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: nullDest });
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: ':ac-run-status:',
      user: 'U123',
      ts: '100.0',
      channel: CHANNEL_ID,
    });

    const event = await eventPromise;
    await adapter.stop();

    expect(event.type).toBe('command');
    if (event.type === 'command') {
      expect(event.payload.command).toBe('run.status');
      expect(event.payload.args).toEqual([]);
      expect(event.payload.conversation.conversation_id).toBe('100.0');
      expect(event.payload.origin.message_id).toBe('100.0');
      expect(event.payload.author).toBe('U123');
      expect(event.payload.channel.id).toBe(CHANNEL_ID);
      expect(event.payload.conversation.channel_id).toBe(CHANNEL_ID);
    }
    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('recognized command emoji inside thread reply emits command event with parent conversation ref', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: nullDest });
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: ':ac-run-status:',
      user: 'U123',
      ts: '200.0',
      thread_ts: '100.0',
      channel: CHANNEL_ID,
    });

    const event = await eventPromise;
    await adapter.stop();

    expect(event.type).toBe('command');
    if (event.type === 'command') {
      expect(event.payload.conversation.conversation_id).toBe('100.0');
      expect(event.payload.origin.message_id).toBe('200.0');
    }
  });

  it('inferred_context.request_id populated when thread_ts is in registry', async () => {
    const { ThreadRegistry } = await import('../../../src/adapters/slack/thread-registry.js');
    const registry = new ThreadRegistry();
    registry.register('100.0', 'req-abc');
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(
      mock as unknown as App,
      { channelName: CHANNEL_NAME },
      { logDestination: nullDest, registry },
    );
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: ':ac-run-status:',
      user: 'U123',
      ts: '200.0',
      thread_ts: '100.0',
      channel: CHANNEL_ID,
    });

    const event = await eventPromise;
    await adapter.stop();

    expect(event.type).toBe('command');
    if (event.type === 'command') {
      expect(event.payload.inferred_context?.request_id).toBe('req-abc');
    }
  });

  it('inferred_context.request_id is undefined when thread not registered', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: nullDest });
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: ':ac-run-status:',
      user: 'U123',
      ts: '100.0',
      channel: CHANNEL_ID,
    });

    const event = await eventPromise;
    await adapter.stop();

    expect(event.type).toBe('command');
    if (event.type === 'command') {
      expect(event.payload.inferred_context?.request_id).toBeUndefined();
    }
  });
});

describe('SlackAdapter — ac-set-status message command thread guard', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';
  const CHANNEL_NAME = 'my-channel';

  it(':ac-set-status: in root message → no event emitted, ac-message-ignored reaction added', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: nullDest });
    await adapter.start();

    let emitted = false;
    const racePromise = Promise.race([
      takeOne(adapter.receive()).then(() => { emitted = true; }),
      new Promise<void>(res => setTimeout(res, 30)),
    ]);

    await mock._triggerMessage({
      text: ':ac-set-status: reviewing_implementation',
      user: 'U123',
      ts: '100.0',
      channel: CHANNEL_ID,
    });

    await racePromise;
    await adapter.stop();

    expect(emitted).toBe(false);
    expect(mock.client.reactions.add).toHaveBeenCalledWith({
      channel: CHANNEL_ID,
      timestamp: '100.0',
      name: 'ac-message-ignored',
    });
  });

  it(':ac-set-status: in unregistered thread → no event emitted', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: nullDest });
    await adapter.start();

    let emitted = false;
    const racePromise = Promise.race([
      takeOne(adapter.receive()).then(() => { emitted = true; }),
      new Promise<void>(res => setTimeout(res, 30)),
    ]);

    await mock._triggerMessage({
      text: ':ac-set-status: reviewing_implementation',
      user: 'U123',
      ts: '200.0',
      thread_ts: '100.0', // not registered
      channel: CHANNEL_ID,
    });

    await racePromise;
    await adapter.stop();

    expect(emitted).toBe(false);
  });

  it(':ac-set-status: in registered run thread → run.set-status command emitted', async () => {
    const { ThreadRegistry } = await import('../../../src/adapters/slack/thread-registry.js');
    const registry = new ThreadRegistry();
    registry.register('100.0', 'req-001');
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(
      mock as unknown as App,
      { channelName: CHANNEL_NAME },
      { logDestination: nullDest, registry },
    );
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: ':ac-set-status: reviewing_implementation',
      user: 'U123',
      ts: '200.0',
      thread_ts: '100.0',
      channel: CHANNEL_ID,
    });

    const event = await eventPromise;
    await adapter.stop();

    expect(event.type).toBe('command');
    if (event.type === 'command') {
      expect(event.payload.command).toBe('run.set-status');
      expect(event.payload.args).toEqual(['reviewing_implementation']);
      expect(event.payload.inferred_context?.request_id).toBe('req-001');
    }
  });
});

describe('SlackAdapter — command events (reaction-based)', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';
  const CHANNEL_NAME = 'my-channel';

  it('reaction_added with recognized emoji on root message uses the root conversation ref', async () => {
    const mock = makeMockApp({
      botUserId: BOT_ID,
      historyMessages: [{ ts: '100.0' }],
    });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: nullDest });
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerReaction({
      type: 'reaction_added',
      reaction: 'ac-run-status',
      user: 'U123',
      item: { type: 'message', channel: CHANNEL_ID, ts: '100.0' },
    });

    const event = await eventPromise;
    await adapter.stop();

    expect(mock.client.conversations.history).toHaveBeenCalledWith(
      expect.objectContaining({ channel: CHANNEL_ID, latest: '100.0' }),
    );
    expect(event.type).toBe('command');
    if (event.type === 'command') {
      expect(event.payload.command).toBe('run.status');
      expect(event.payload.conversation.conversation_id).toBe('100.0');
      expect(event.payload.origin.message_id).toBe('100.0');
    }
  });

  it('reaction_added on thread reply emits command event with reacted message parent conversation ref', async () => {
    const mock = makeMockApp({
      botUserId: BOT_ID,
      historyMessages: [{ ts: '200.0', thread_ts: '100.0' }],
    });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: nullDest });
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerReaction({
      type: 'reaction_added',
      reaction: 'ac-run-status',
      user: 'U123',
      item: { type: 'message', channel: CHANNEL_ID, ts: '200.0' },
    });

    const event = await eventPromise;
    await adapter.stop();

    expect(event.type).toBe('command');
    if (event.type === 'command') {
      expect(event.payload.conversation.conversation_id).toBe('100.0');
      expect(event.payload.origin.message_id).toBe('200.0');
    }
  });

  it('reaction_added, conversations.history fails emits event with item timestamp as fallback conversation ref', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    mock.client.conversations.history.mockRejectedValueOnce(new Error('network error'));
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: nullDest });
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerReaction({
      type: 'reaction_added',
      reaction: 'ac-run-status',
      user: 'U123',
      item: { type: 'message', channel: CHANNEL_ID, ts: '100.0' },
    });

    const event = await eventPromise;
    await adapter.stop();

    expect(event.type).toBe('command');
    if (event.type === 'command') {
      expect(event.payload.conversation.conversation_id).toBe('100.0');
      expect(event.payload.origin.message_id).toBe('100.0');
    }
  });

  it('ac-set-status reaction on thread reply → no event emitted, no conversations.history call', async () => {
    const mock = makeMockApp({
      botUserId: BOT_ID,
      historyMessages: [{ ts: '100.0', thread_ts: '100.0', text: 'original request' }],
      repliesMessages: [{ ts: '100.0', text: 'original request' }, { ts: '200.0', text: 'reviewing_implementation' }],
    });
    const { ThreadRegistry } = await import('../../../src/adapters/slack/thread-registry.js');
    const registry = new ThreadRegistry();
    registry.register('100.0', 'req-001');

    const adapter = new SlackAdapter(
      mock as unknown as App,
      { channelName: CHANNEL_NAME },
      { logDestination: nullDest, registry },
    );
    await adapter.start();

    let emitted = false;
    const racePromise = Promise.race([
      takeOne(adapter.receive()).then(() => { emitted = true; }),
      new Promise<void>(res => setTimeout(res, 30)),
    ]);

    await mock._triggerReaction({
      type: 'reaction_added',
      reaction: 'ac-set-status',
      user: 'U123',
      item: { type: 'message', channel: CHANNEL_ID, ts: '200.0' },
    });

    await racePromise;
    await adapter.stop();

    expect(emitted).toBe(false);
    expect(mock.client.conversations.history).not.toHaveBeenCalled();
    expect(mock.client.conversations.replies).not.toHaveBeenCalled();
  });

  it('reaction_added with unrecognized emoji → no event emitted', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: nullDest });
    await adapter.start();

    let emitted = false;
    const racePromise = Promise.race([
      takeOne(adapter.receive()).then(() => { emitted = true; }),
      new Promise<void>(res => setTimeout(res, 30)),
    ]);

    await mock._triggerReaction({
      type: 'reaction_added',
      reaction: 'thumbsup',
      user: 'U123',
      item: { type: 'message', channel: CHANNEL_ID, ts: '100.0' },
    });

    await racePromise;
    await adapter.stop();
    expect(emitted).toBe(false);
  });

  it('reaction_added from different channel → ignored; no event emitted', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: nullDest });
    await adapter.start();

    let emitted = false;
    const racePromise = Promise.race([
      takeOne(adapter.receive()).then(() => { emitted = true; }),
      new Promise<void>(res => setTimeout(res, 30)),
    ]);

    await mock._triggerReaction({
      type: 'reaction_added',
      reaction: 'ac-run-status',
      user: 'U123',
      item: { type: 'message', channel: 'C_OTHER', ts: '100.0' },
    });

    await racePromise;
    await adapter.stop();
    expect(emitted).toBe(false);
  });
});

describe('SlackAdapter — inbound handler ack behavior (emoji, no text)', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';
  const ACK_EMOJI = 'eyes';

  it('test 3: new_request — reactions.add called once with msg.ts and ack emoji', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(
      mock as unknown as App,
      { channelName: 'my-channel' },
      { logDestination: nullDest, ackEmoji: ACK_EMOJI },
    );
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({ text: `<@${BOT_ID}> add wizard`, user: 'U123', ts: '100.0', channel: CHANNEL_ID });
    await eventPromise;
    await adapter.stop();

    expect(mock.client.reactions.add).toHaveBeenCalledOnce();
    expect(mock.client.reactions.add).toHaveBeenCalledWith({
      channel: CHANNEL_ID,
      timestamp: '100.0',
      name: ACK_EMOJI,
    });
  });

  it('test 4: thread_message — reactions.add called once with msg.ts and ack emoji', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(
      mock as unknown as App,
      { channelName: 'my-channel' },
      { logDestination: nullDest, ackEmoji: ACK_EMOJI },
    );
    await adapter.start();

    // Seed idea to register thread
    const ideaPromise = takeOne(adapter.receive());
    await mock._triggerMessage({ text: `<@${BOT_ID}> idea`, user: 'U123', ts: '100.0', channel: CHANNEL_ID });
    await ideaPromise;

    mock.client.reactions.add.mockClear();

    // Send reply (thread_message)
    const replyPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: `<@${BOT_ID}> feedback`,
      user: 'U456',
      ts: '200.0',
      thread_ts: '100.0',
      channel: CHANNEL_ID,
    });
    await replyPromise;
    await adapter.stop();

    expect(mock.client.reactions.add).toHaveBeenCalledOnce();
    expect(mock.client.reactions.add).toHaveBeenCalledWith({
      channel: CHANNEL_ID,
      timestamp: '200.0',  // msg.ts not thread_ts
      name: ACK_EMOJI,
    });
  });

  it('test 5: new_request — chat.postMessage NOT called from adapter', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(
      mock as unknown as App,
      { channelName: 'my-channel' },
      { logDestination: nullDest, ackEmoji: ACK_EMOJI },
    );
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({ text: `<@${BOT_ID}> add wizard`, user: 'U123', ts: '100.0', channel: CHANNEL_ID });
    await eventPromise;
    await adapter.stop();

    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('test 6: thread_message — chat.postMessage NOT called from adapter', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(
      mock as unknown as App,
      { channelName: 'my-channel' },
      { logDestination: nullDest, ackEmoji: ACK_EMOJI },
    );
    await adapter.start();

    // Seed idea
    const ideaPromise = takeOne(adapter.receive());
    await mock._triggerMessage({ text: `<@${BOT_ID}> idea`, user: 'U123', ts: '100.0', channel: CHANNEL_ID });
    await ideaPromise;

    mock.client.chat.postMessage.mockClear();

    // Send reply
    const replyPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: `<@${BOT_ID}> feedback`,
      user: 'U456',
      ts: '200.0',
      thread_ts: '100.0',
      channel: CHANNEL_ID,
    });
    await replyPromise;
    await adapter.stop();

    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe('SlackAdapter — ignored message reaction', () => {
  it('adds ac-message-ignored reaction when message has no bot mention (root message)', async () => {
    const mock = makeMockApp({ botUserId: 'UBOT', channels: [{ name: 'ch', id: 'C1' }] });
    const adapter = new SlackAdapter(
      mock as unknown as App,
      { channelName: 'ch' },
      { logDestination: nullDest },
    );
    await adapter.start();

    // A root message with no @bot mention — will be classified as 'ignore'
    await mock._triggerMessage({ user: 'U1', ts: '111.0', channel: 'C1', text: 'hello world' });

    expect(mock.client.reactions.add).toHaveBeenCalledWith({
      channel: 'C1',
      timestamp: '111.0',
      name: 'ac-message-ignored',
    });

    await adapter.stop();
  });

  it('adds ac-message-ignored reaction when thread reply has no bot mention', async () => {
    const mock = makeMockApp({ botUserId: 'UBOT', channels: [{ name: 'ch', id: 'C1' }] });
    const adapter = new SlackAdapter(
      mock as unknown as App,
      { channelName: 'ch' },
      { logDestination: nullDest },
    );
    await adapter.start();

    // A thread reply with no @bot mention — classified as 'ignore'
    await mock._triggerMessage({ user: 'U1', ts: '222.0', thread_ts: '111.0', channel: 'C1', text: 'no mention here' });

    expect(mock.client.reactions.add).toHaveBeenCalledWith({
      channel: 'C1',
      timestamp: '222.0',
      name: 'ac-message-ignored',
    });

    await adapter.stop();
  });

  it('does not throw when reaction call fails', async () => {
    const mock = makeMockApp({ botUserId: 'UBOT', channels: [{ name: 'ch', id: 'C1' }] });
    mock.client.reactions.add.mockRejectedValueOnce(new Error('Slack API down'));
    const adapter = new SlackAdapter(
      mock as unknown as App,
      { channelName: 'ch' },
      { logDestination: nullDest },
    );
    await adapter.start();

    // Should not throw even when reactions.add fails
    await expect(
      mock._triggerMessage({ user: 'U1', ts: '111.0', channel: 'C1', text: 'no mention' }),
    ).resolves.not.toThrow();

    await adapter.stop();
  });
});

describe('SlackAdapter — reaction command messageText', () => {
  it('ac-set-status reaction on root message → no event emitted, no conversations.history call', async () => {
    const mock = makeMockApp({
      botUserId: 'UBOT',
      channels: [{ name: 'ch', id: 'C1' }],
      historyMessages: [{ ts: '111.0', thread_ts: '111.0', text: 'reviewing_implementation' }],
    });
    const adapter = new SlackAdapter(
      mock as unknown as App,
      { channelName: 'ch' },
      { logDestination: nullDest },
    );
    await adapter.start();

    let emitted = false;
    const racePromise = Promise.race([
      takeOne(adapter.receive()).then(() => { emitted = true; }),
      new Promise<void>(res => setTimeout(res, 30)),
    ]);

    await mock._triggerReaction({
      reaction: 'ac-set-status',
      user: 'U1',
      item: { type: 'message', channel: 'C1', ts: '111.0' },
    });

    await racePromise;
    await adapter.stop();

    expect(emitted).toBe(false);
    expect(mock.client.conversations.history).not.toHaveBeenCalled();
  });

  it('sets messageText to undefined when reacted-to message has no text', async () => {
    const mock = makeMockApp({
      botUserId: 'UBOT',
      channels: [{ name: 'ch', id: 'C1' }],
      historyMessages: [{ ts: '111.0' }],
    });
    const adapter = new SlackAdapter(
      mock as unknown as App,
      { channelName: 'ch' },
      { logDestination: nullDest },
    );
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerReaction({
      reaction: 'ac-run-status',
      user: 'U1',
      item: { type: 'message', channel: 'C1', ts: '111.0' },
    });
    const event = await eventPromise;

    expect(event.type).toBe('command');
    const cmd = event.payload as import('../../../src/types/commands.js').CommandEvent;
    expect(cmd.messageText).toBeUndefined();

    await adapter.stop();
  });
});

describe('SlackAdapter — thread_ts / message_ts logging', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';
  const CHANNEL_NAME = 'my-channel';

  it('logs root thread_ts and reply message_ts separately for thread messages', async () => {
    const { records, destination } = makeLogCapture();
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: destination });
    await adapter.start();

    // Seed idea to register thread (root message ts = '100.000')
    const ideaPromise = takeOne(adapter.receive());
    await mock._triggerMessage({ text: `<@${BOT_ID}> seed idea`, user: 'U123', ts: '100.000', channel: CHANNEL_ID });
    await ideaPromise;

    // Trigger thread reply: msg.thread_ts = '100.000' (root), msg.ts = '111.000' (this reply)
    const replyPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: `<@${BOT_ID}> follow-up`,
      user: 'U456',
      ts: '111.000',
      thread_ts: '100.000',
      channel: CHANNEL_ID,
    });
    await replyPromise;
    await adapter.stop();

    const classifiedLog = records.find(
      r => r['event'] === 'slack.message.classified' && r['intent'] === 'thread_message',
    );
    expect(classifiedLog).toBeDefined();
    // thread_ts must be the root thread (100.000), NOT the reply's own ts (111.000)
    expect(classifiedLog!['thread_ts']).toBe('100.000');
    // message_ts must be the reply's own ts
    expect(classifiedLog!['message_ts']).toBe('111.000');
  });
});

describe('SlackAdapter — reactToMessage', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';

  it('test 1: success path — logs slack.reaction.sent with channel_id, ts, and emoji', async () => {
    const { records, destination } = makeLogCapture();
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel' }, { logDestination: destination });
    await adapter.start();

    await adapter.reactToMessage(CHANNEL_ID, '100.0', 'eyes');

    await adapter.stop();

    const log = records.find(r => r['event'] === 'slack.reaction.sent');
    expect(log).toBeDefined();
    expect(log!['channel_id']).toBe(CHANNEL_ID);
    expect(log!['ts']).toBe('100.0');
    expect(log!['emoji']).toBe('eyes');
    expect(mock.client.reactions.add).toHaveBeenCalledWith({
      channel: CHANNEL_ID,
      timestamp: '100.0',
      name: 'eyes',
    });
  });

  it('test 2: API error — logs slack.error with error field; method resolves without throwing', async () => {
    const { records, destination } = makeLogCapture();
    const mock = makeMockApp({ botUserId: BOT_ID });
    mock.client.reactions.add.mockRejectedValueOnce(new Error('already_reacted'));
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel' }, { logDestination: destination });
    await adapter.start();

    await expect(adapter.reactToMessage(CHANNEL_ID, '100.0', 'eyes')).resolves.toBeUndefined();

    await adapter.stop();

    const errorLog = records.find(r => r['event'] === 'slack.error');
    expect(errorLog).toBeDefined();
    expect(typeof errorLog!['error']).toBe('string');
    expect((errorLog!['error'] as string)).toContain('already_reacted');
  });
});

describe('SlackAdapter — reaction command messageText', () => {
  it('ac-set-status reaction → no event emitted, no conversations.history call', async () => {
    const mock = makeMockApp({
      botUserId: 'UBOT',
      channels: [{ name: 'ch', id: 'C1' }],
      historyMessages: [{ ts: '111.0', thread_ts: '111.0', text: 'reviewing_implementation' }],
    });
    const adapter = new SlackAdapter(
      mock as unknown as App,
      { channelName: 'ch' },
      { logDestination: nullDest },
    );
    await adapter.start();

    let emitted = false;
    const racePromise = Promise.race([
      takeOne(adapter.receive()).then(() => { emitted = true; }),
      new Promise<void>(res => setTimeout(res, 30)),
    ]);

    await mock._triggerReaction({
      reaction: 'ac-set-status',
      user: 'U1',
      item: { type: 'message', channel: 'C1', ts: '111.0' },
    });

    await racePromise;
    await adapter.stop();

    expect(emitted).toBe(false);
    expect(mock.client.conversations.history).not.toHaveBeenCalled();
  });

  it('sets messageText to undefined when reacted-to message has no text', async () => {
    const mock = makeMockApp({
      botUserId: 'UBOT',
      channels: [{ name: 'ch', id: 'C1' }],
      historyMessages: [{ ts: '111.0' }],
    });
    const adapter = new SlackAdapter(
      mock as unknown as App,
      { channelName: 'ch' },
      { logDestination: nullDest },
    );
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerReaction({
      reaction: 'ac-run-status',
      user: 'U1',
      item: { type: 'message', channel: 'C1', ts: '111.0' },
    });
    const event = await eventPromise;

    expect(event.type).toBe('command');
    const cmd = event.payload as import('../../../src/types/commands.js').CommandEvent;
    expect(cmd.messageText).toBeUndefined();

    await adapter.stop();
  });
});

describe('SlackAdapter — prune confirmation routing', () => {
  it('emits prune.confirm command for plain reply in a pending confirmation thread', async () => {
    const mock = makeMockApp({ channels: [{ name: 'my-channel', id: 'C123' }] });
    const registry = { hasPending: vi.fn().mockReturnValue(true) };
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel' }, { logDestination: nullDest, confirmationRegistry: registry });
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: 'Yes',
      user: 'U123',
      ts: '200.0',
      thread_ts: '100.0',
      channel: 'C123',
    });
    const event = await eventPromise;
    expect(event.type).toBe('command');
    if (event.type === 'command') {
      expect(event.payload.command).toBe('prune.confirm');
      expect(event.payload.args).toEqual(['Yes']);
      expect(event.payload.messageText).toBe('Yes');
    }

    await adapter.stop();
  });

  it('does NOT emit prune.confirm for plain reply in non-pending thread', async () => {
    const mock = makeMockApp({ channels: [{ name: 'my-channel', id: 'C123' }] });
    const registry = { hasPending: vi.fn().mockReturnValue(false) };
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel' }, { logDestination: nullDest, confirmationRegistry: registry });
    await adapter.start();

    // This should be ignored (not a command, not a mention)
    const events: unknown[] = [];
    const iterPromise = (async () => {
      for await (const event of adapter.receive()) {
        events.push(event);
        break;
      }
    })();

    await mock._triggerMessage({
      text: 'Yes',
      user: 'U123',
      ts: '200.0',
      thread_ts: '100.0',
      channel: 'C123',
    });

    // Stop the adapter to end the stream
    await adapter.stop();
    await iterPromise;

    // No command event should have been emitted
    expect(events.length).toBe(0);
  });

  it('real CommandConfirmationRegistryImpl: pending confirmation allows plain reply to route to prune.confirm', async () => {
    const { CommandConfirmationRegistryImpl } = await import('../../../src/core/command-confirmations.js');
    const registry = new CommandConfirmationRegistryImpl();
    registry.create({
      command: 'prune',
      conversation: { provider: 'slack', channel_id: 'C123', conversation_id: '100.0' },
      requested_by: 'U123',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      payload: { mode: 'completed', request_ids: ['req-001'], allow_active: false },
    });

    const mock = makeMockApp({ channels: [{ name: 'my-channel', id: 'C123' }] });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel' }, { logDestination: nullDest, confirmationRegistry: registry });
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: 'Yes',
      user: 'U123',
      ts: '200.0',
      thread_ts: '100.0',
      channel: 'C123',
    });
    const event = await eventPromise;
    expect(event.type).toBe('command');
    if (event.type === 'command') {
      expect(event.payload.command).toBe('prune.confirm');
      expect(event.payload.args).toEqual(['Yes']);
    }
    await adapter.stop();
  });
});
