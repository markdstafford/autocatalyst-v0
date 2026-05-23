import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { App } from '@slack/bolt';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { ChannelAdapter } from '../channel-adapter.js';
import type { ChannelRegistry, ConversationRef, MessageRef } from '../../types/channel.js';
import type { InboundEvent, Request, ThreadMessage } from '../../types/events.js';
import { classifyMessage, EMOJI_COMMAND_TABLE, MESSAGE_ONLY_COMMANDS } from './classifier.js';
import type { CommandEvent } from '../../types/commands.js';
import { ThreadRegistry } from './thread-registry.js';
import type { RepoEntry, ChannelRepoMap, PreRepoEntry } from '../../types/config.js';

type SlackAdapterConfig =
  | { channelName: string; repo_url?: string; workspace_root?: string }
  | { repoEntries: PreRepoEntry[] };

interface SlackAdapterOptions {
  registry?: ThreadRegistry;
  logDestination?: pino.DestinationStream;
  ackEmoji?: string;
}

export class SlackAdapter implements ChannelAdapter {
  private readonly app: App;
  private readonly config: SlackAdapterConfig;
  private readonly registry: ThreadRegistry;
  private readonly logger: pino.Logger;
  private readonly ackEmoji: string;

  private botUserId: string | undefined;
  private _resolvedChannelId: string | undefined;
  private _resolvedChannelRepoMap: ChannelRepoMap | null = null;
  private readonly _resolvedChannelNames = new Map<string, string>();
  private _channelsResolved = false;

  // AsyncIterable queue
  private readonly eventQueue: InboundEvent[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  constructor(app: App, config: SlackAdapterConfig, options?: SlackAdapterOptions) {
    this.app = app;
    this.config = config;
    this.registry = options?.registry ?? new ThreadRegistry();
    this.logger = createLogger('slack-adapter', { destination: options?.logDestination });
    this.ackEmoji = options?.ackEmoji ?? 'eyes';
  }

  /**
   * Resolves configured channel name(s) to IDs using conversations.list.
   * Idempotent — skips re-resolution on subsequent calls.
   * Single-repo: caches channel_id; logs slack.startup.channel_resolved.
   * Multi-repo: builds ChannelRepoMap; logs slack.startup.channels_resolved.
   * Throws (logging slack.startup.channel_resolution_failed) if any channel can't be resolved.
   */
  async resolveChannels(): Promise<ChannelRegistry> {
    if (this._channelsResolved) return this.toChannelRegistry();

    const listResult = await this.app.client.conversations.list({
      types: 'public_channel',
      limit: 1000,
    });

    if ((listResult as { response_metadata?: { next_cursor?: string } }).response_metadata?.next_cursor) {
      this.logger.warn(
        { event: 'slack.error', error: 'conversations.list result truncated — channel may not be found if workspace has >1000 channels' },
        'Channel list truncated; consider paginating if channel is not found',
      );
    }

    if ('channelName' in this.config) {
      const channelName = this.config.channelName;
      const channel = listResult.channels?.find(
        (c: { name?: string }) => c.name === channelName,
      );
      if (!channel || !('id' in channel) || typeof channel.id !== 'string') {
        this.logger.error(
          { event: 'slack.startup.channel_resolution_failed', channel_name: channelName, error: `channel not found: ${channelName}` },
          'Slack channel not found — adapter cannot start',
        );
        throw new Error(`Slack channel not found: ${channelName}`);
      }
      this._resolvedChannelId = channel.id;
      this._resolvedChannelNames.set(channel.id, channelName);
      this.logger.info(
        { event: 'slack.startup.channel_resolved', channel_name: channelName, channel_id: this._resolvedChannelId },
        'Channel resolved',
      );
    } else {
      const repoEntries = this.config.repoEntries;
      const channelRepoMap: ChannelRepoMap = new Map();
      for (const entry of repoEntries) {
        const channel = listResult.channels?.find(
          (c: { name?: string }) => c.name === entry.channel_name,
        );
        if (!channel || !('id' in channel) || typeof channel.id !== 'string') {
          this.logger.error(
            { event: 'slack.startup.channel_resolution_failed', channel_name: entry.channel_name, error: `channel not found: ${entry.channel_name}` },
            'Slack channel not found — adapter cannot start',
          );
          throw new Error(`Slack channel not found: ${entry.channel_name}`);
        }
        channelRepoMap.set(channel.id, {
          channel_ref: `slack:${channel.id}`,
          repo_url: entry.repo_url,
          workspace_root: entry.workspace_root,
        });
        this._resolvedChannelNames.set(channel.id, entry.channel_name);
      }
      this._resolvedChannelRepoMap = channelRepoMap;
      this.logger.info(
        {
          event: 'slack.startup.channels_resolved',
          channels: [...channelRepoMap.values()].map(e => ({
            channel_ref: e.channel_ref,
            repo_url: e.repo_url,
          })),
        },
        'All channels resolved',
      );
    }

    this._channelsResolved = true;
    return this.toChannelRegistry();
  }

  /** Returns the resolved channel ID for single-repo mode. Valid after resolveChannels() or start(). */
  getChannelId(): string {
    if (this._resolvedChannelId === undefined) {
      throw new Error('resolveChannels() has not been called or channel is not yet resolved');
    }
    return this._resolvedChannelId;
  }

  /** Returns the resolved ChannelRepoMap for multi-repo mode. Valid after resolveChannels() in multi-repo mode. */
  getChannelRepoMap(): ChannelRepoMap {
    if (this._resolvedChannelRepoMap === null) {
      throw new Error('resolveChannels() has not been called or this adapter is not in multi-repo mode');
    }
    return this._resolvedChannelRepoMap;
  }

  async start(): Promise<void> {
    // Resolve bot user ID
    const authResult = await this.app.client.auth.test();
    if (typeof authResult.user_id !== 'string') {
      throw new Error('auth.test() did not return a user_id');
    }
    this.botUserId = authResult.user_id;

    // Resolve channel name(s) → channel ID(s) (idempotent)
    await this.resolveChannels();

    // Build set of allowed channel IDs for filtering
    const allowedChannelIds = new Set<string>(
      'channelName' in this.config
        ? [this._resolvedChannelId!]
        : [...this._resolvedChannelRepoMap!.keys()],
    );

    // Register message handler (must happen before app.start())
    this.app.message(async ({ message }) => {
      // Skip non-regular messages (bot_message, message_changed, etc.)
      if ('subtype' in message && (message as { subtype?: string }).subtype !== undefined) return;
      // Filter to target channel(s)
      const msgChannel = ('channel' in message) ? (message as { channel?: string }).channel : undefined;
      if (!msgChannel || !allowedChannelIds.has(msgChannel)) {
        this.logger.debug(
          { event: 'slack.event.channel_filtered', channel_id: msgChannel },
          'Message filtered — not in allowed channels',
        );
        return;
      }

      const channelId = msgChannel;

      const msg = message as {
        text?: string;
        user?: string;
        ts: string;
        thread_ts?: string;
        channel: string;
      };

      if (!msg.user) return; // no user field means it's a system/bot message

      const result = classifyMessage(
        { text: msg.text, user: msg.user, ts: msg.ts, thread_ts: msg.thread_ts },
        this.botUserId!,
        this.registry,
      );

      if (result.intent === 'ignore') {
        this.logger.debug(
          { event: 'slack.message.ignored', author: msg.user, channel_id: channelId },
          'Message ignored',
        );
        await this.reactToMessage(channelId, msg.ts, 'ac-message-ignored');
        return;
      }

      if (result.intent === 'command') {
        const commandEvent: CommandEvent = {
          command: result.command,
          args: result.args,
          channel: { provider: 'slack', id: channelId },
          conversation: { provider: 'slack', channel_id: channelId, conversation_id: msg.thread_ts ?? msg.ts },
          origin: {
            provider: 'slack',
            channel_id: channelId,
            conversation_id: msg.thread_ts ?? msg.ts,
            message_id: msg.ts,
          },
          author: msg.user,
          received_at: new Date().toISOString(),
          inferred_context: {
            request_id: this.registry.resolve(msg.thread_ts ?? msg.ts),
          },
        };
        this.logger.info(
          { event: 'slack.command.received', author: msg.user, channel_id: channelId, command: result.command, thread_ts: msg.thread_ts ?? msg.ts },
          'Command received',
        );
        this.emit({ type: 'command', payload: commandEvent });
        return;
      }

      this.logger.info(
        { event: 'slack.message.classified', author: msg.user, channel_id: channelId, intent: result.intent, thread_ts: msg.thread_ts ?? msg.ts, message_ts: msg.ts },
        'Message classified',
      );

      if (result.intent === 'new_request') {
        const request: Request = {
          id: randomUUID(),
          channel: { provider: 'slack', id: channelId },
          conversation: { provider: 'slack', channel_id: channelId, conversation_id: msg.ts },
          origin: {
            provider: 'slack',
            channel_id: channelId,
            conversation_id: msg.ts,
            message_id: msg.ts,
          },
          content: msg.text ?? '',
          author: msg.user,
          received_at: new Date().toISOString(),
        };

        // Apply ack reaction and register thread before emitting
        this.registry.register(msg.ts, request.id);
        await this.reactToMessage(channelId, msg.ts, this.ackEmoji);
        this.emit({ type: 'new_request', payload: request });

      } else if (result.intent === 'thread_message') {
        const message: ThreadMessage = {
          request_id: result.request_id,
          channel: { provider: 'slack', id: channelId },
          conversation: { provider: 'slack', channel_id: channelId, conversation_id: msg.thread_ts! },
          origin: {
            provider: 'slack',
            channel_id: channelId,
            conversation_id: msg.thread_ts!,
            message_id: msg.ts,
          },
          content: msg.text ?? '',
          author: msg.user,
          received_at: new Date().toISOString(),
        };

        await this.reactToMessage(channelId, msg.ts, this.ackEmoji);
        this.emit({ type: 'thread_message', payload: message });
      }
    });

    // Register reaction_added handler for command-via-reaction
    this.app.event('reaction_added', async ({ event: reactionEvent }) => {
      const reaction = reactionEvent as {
        reaction: string;
        user: string;
        item: { type: string; channel?: string; ts: string };
      };
      if (reaction.item.type !== 'message') return;
      if (!reaction.item.channel || !allowedChannelIds.has(reaction.item.channel)) {
        this.logger.debug(
          { event: 'slack.event.channel_filtered', channel_id: reaction.item.channel },
          'Reaction filtered — not in allowed channels',
        );
        return;
      }

      const commandName = EMOJI_COMMAND_TABLE[reaction.reaction];
      if (!commandName) {
        this.logger.debug({ event: 'slack.reaction.ignored', emoji: reaction.reaction }, 'Reaction ignored');
        return;
      }
      if (MESSAGE_ONLY_COMMANDS.has(commandName)) {
        this.logger.debug(
          { event: 'slack.reaction.ignored', emoji: reaction.reaction, reason: 'message_only_command' },
          'Reaction ignored — command requires explicit thread message',
        );
        return;
      }

      let reactedThreadTs: string = reaction.item.ts;
      let reactedMessageText: string | undefined;
      try {
        const historyResult = await this.app.client.conversations.history({
          channel: reaction.item.channel!,
          latest: reaction.item.ts,
          limit: 1,
          inclusive: true,
        });
        const reactedMessage = historyResult.messages?.[0];

        if (reactedMessage?.ts === reaction.item.ts) {
          // Exact match: the reacted message is a top-level channel message.
          if (reactedMessage.thread_ts) {
            reactedThreadTs = reactedMessage.thread_ts as string;
          }
          reactedMessageText = typeof reactedMessage.text === 'string' ? reactedMessage.text : undefined;
        } else {
          // conversations.history only returns top-level messages. The reacted message
          // is a thread reply — search each registered thread for the exact reply.
          const reactionTs = parseFloat(reaction.item.ts);
          const candidates = this.registry.rootTimestamps()
            .filter(rootTs => parseFloat(rootTs) < reactionTs)
            .sort((a, b) => parseFloat(b) - parseFloat(a)); // most recent first

          for (const rootTs of candidates) {
            try {
              const repliesResult = await this.app.client.conversations.replies({
                channel: reaction.item.channel!,
                ts: rootTs,
                latest: reaction.item.ts,
                limit: 1,
                inclusive: true,
              });
              const replyMsg = (repliesResult.messages ?? []).find(
                (m: { ts?: string }) => m.ts === reaction.item.ts,
              );
              if (replyMsg) {
                reactedThreadTs = rootTs;
                reactedMessageText = typeof (replyMsg as { text?: string }).text === 'string'
                  ? (replyMsg as { text?: string }).text
                  : undefined;
                break;
              }
            } catch (replyErr) {
              this.logger.debug(
                { event: 'slack.error', error: String(replyErr) },
                'Failed to fetch replies for thread root during reaction lookup',
              );
            }
          }
        }
      } catch (err) {
        this.logger.warn(
          { event: 'slack.error', error: String(err) },
          'Failed to fetch reacted-to message; using item.ts as thread_ts',
        );
      }

      const commandEvent: CommandEvent = {
        command: commandName,
        args: [],
        channel: { provider: 'slack', id: reaction.item.channel! },
        conversation: { provider: 'slack', channel_id: reaction.item.channel!, conversation_id: reactedThreadTs },
        origin: {
          provider: 'slack',
          channel_id: reaction.item.channel!,
          conversation_id: reactedThreadTs,
          message_id: reaction.item.ts,
        },
        author: reaction.user,
        received_at: new Date().toISOString(),
        messageText: reactedMessageText,
        inferred_context: {
          request_id: this.registry.resolve(reactedThreadTs),
        },
      };
      this.logger.info(
        { event: 'slack.command.received', author: reaction.user, channel_id: reaction.item.channel, command: commandName, thread_ts: reactedThreadTs },
        'Reaction command received',
      );
      this.emit({ type: 'command', payload: commandEvent });
    });

    // Start Bolt (opens Socket Mode WebSocket)
    await this.app.start();
    this.logger.info(
      { event: 'slack.connected', channel_count: allowedChannelIds.size },
      'Connected to Slack',
    );
  }

  async stop(): Promise<void> {
    await this.app.stop();
    // Events that arrive during app.stop() teardown are discarded intentionally —
    // stop() signals end-of-stream, remaining queued events will still be drained by receive().
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve();
    }
    this.logger.warn(
      { event: 'slack.disconnected', reason: 'stop() called' },
      'Disconnected from Slack',
    );
  }

  async *receive(): AsyncIterable<InboundEvent> {
    while (!this.closed || this.eventQueue.length > 0) {
      if (this.eventQueue.length > 0) {
        yield this.eventQueue.shift()!;
      } else {
        await new Promise<void>(resolve => {
          this.waiter = resolve;
        });
      }
    }
  }

  async reply(ref: ConversationRef, text: string): Promise<MessageRef> {
    const callStart = performance.now();
    let result: Awaited<ReturnType<typeof this.app.client.chat.postMessage>>;
    try {
      result = await this.app.client.chat.postMessage({
        channel: ref.channel_id,
        thread_ts: ref.conversation_id,
        text,
      });
      const duration_ms = Math.round(performance.now() - callStart);
      this.logger.info(
        { event: 'slack.message.delivered', channel_id: ref.channel_id, thread_ts: ref.conversation_id, message_ts: result.ts, duration_ms },
        'Slack message delivered',
      );
    } catch (err) {
      const duration_ms = Math.round(performance.now() - callStart);
      this.logger.error(
        { event: 'slack.message.delivery_failed', channel_id: ref.channel_id, thread_ts: ref.conversation_id, duration_ms, error: String(err) },
        'Slack message delivery failed',
      );
      throw err;
    }
    return {
      provider: 'slack',
      channel_id: ref.channel_id,
      conversation_id: ref.conversation_id,
      message_id: typeof result.ts === 'string' ? result.ts : ref.conversation_id,
    };
  }

  async replyError(ref: ConversationRef, text: string): Promise<MessageRef> {
    return this.reply(ref, text);
  }

  private emit(event: InboundEvent): void {
    this.eventQueue.push(event);
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve();
    }
  }

  async reactToMessage(channel: string, ts: string, emoji: string): Promise<void> {
    const callStart = performance.now();
    try {
      await this.app.client.reactions.add({ channel, timestamp: ts, name: emoji });
      const duration_ms = Math.round(performance.now() - callStart);
      this.logger.info(
        { event: 'slack.reaction.sent', channel_id: channel, ts, emoji, duration_ms },
        'Reaction posted',
      );
    } catch (err) {
      const duration_ms = Math.round(performance.now() - callStart);
      this.logger.error(
        { event: 'slack.error', channel_id: channel, ts, emoji, duration_ms, error: String(err) },
        'Failed to post reaction',
      );
    }
  }

  async react(ref: MessageRef, reaction: string): Promise<void> {
    await this.reactToMessage(ref.channel_id, ref.message_id, reaction);
  }

  registerConversation(ref: ConversationRef, request_id: string): void {
    this.registry.register(ref.conversation_id, request_id);
  }

  isConnected(): boolean {
    return !this.closed;
  }

  private toChannelRegistry(): ChannelRegistry {
    const registry: ChannelRegistry = new Map();
    if (this._resolvedChannelRepoMap) {
      for (const [channelId, entry] of this._resolvedChannelRepoMap) {
        registry.set(entry.channel_ref, {
          channel: { provider: 'slack', id: channelId, name: this._resolvedChannelNames.get(channelId) },
          repo_url: entry.repo_url,
          workspace_root: entry.workspace_root,
        });
      }
      return registry;
    }
    if (this._resolvedChannelId && 'channelName' in this.config && this.config.repo_url && this.config.workspace_root) {
      const channel_ref = `slack:${this._resolvedChannelId}`;
      registry.set(channel_ref, {
        channel: { provider: 'slack', id: this._resolvedChannelId, name: this.config.channelName },
        repo_url: this.config.repo_url,
        workspace_root: this.config.workspace_root,
      });
    }
    return registry;
  }

}
