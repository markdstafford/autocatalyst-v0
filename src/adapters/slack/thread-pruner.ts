import { performance } from 'node:perf_hooks';
import type { App } from '@slack/bolt';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { ConversationRef } from '../../types/channel.js';
import type { ThreadPruner, ThreadPruneResult, ThreadPruneFailure } from '../../types/thread-pruner.js';

export class SlackThreadPruner implements ThreadPruner {
  private readonly logger: pino.Logger;

  constructor(
    private readonly app: App,
    options?: { logDestination?: pino.DestinationStream },
  ) {
    this.logger = createLogger('slack-thread-pruner', { destination: options?.logDestination });
  }

  async pruneThread(ref: ConversationRef): Promise<ThreadPruneResult> {
    if (ref.provider !== 'slack') {
      return { status: 'unsupported', deleted_messages: 0, failed_messages: [], errors: ['unsupported provider'] };
    }

    const startMs = performance.now();
    this.logger.info(
      { event: 'slack.thread_prune_started', channel_id: ref.channel_id, conversation_id: ref.conversation_id },
      'Slack thread prune started',
    );

    // Fetch all messages in the thread via pagination
    const allMessages: Array<{ ts: string; user?: string }> = [];
    let cursor: string | undefined;
    try {
      do {
        const result = await this.app.client.conversations.replies({
          channel: ref.channel_id,
          ts: ref.conversation_id,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        const messages = (result.messages ?? []) as Array<{ ts: string; user?: string }>;
        allMessages.push(...messages);
        cursor = (result.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
      } while (cursor);
    } catch (err) {
      const duration_ms = Math.round(performance.now() - startMs);
      this.logger.warn(
        { event: 'slack.thread_prune_failed', channel_id: ref.channel_id, conversation_id: ref.conversation_id, duration_ms, error: String(err) },
        'Failed to list thread messages',
      );
      return { status: 'failed', deleted_messages: 0, failed_messages: [], errors: [String(err)] };
    }

    // Separate replies (non-root) from the root message
    const replies = allMessages.filter(m => m.ts !== ref.conversation_id);
    const rootPresent = allMessages.some(m => m.ts === ref.conversation_id);

    const failedMessages: ThreadPruneFailure[] = [];
    let deletedCount = 0;

    // Delete replies first
    for (const msg of replies) {
      try {
        await this.app.client.chat.delete({ channel: ref.channel_id, ts: msg.ts });
        deletedCount++;
      } catch (err) {
        failedMessages.push({ message_id: msg.ts, error: String(err) });
        this.logger.warn(
          { event: 'slack.thread_prune_partial', channel_id: ref.channel_id, message_ts: msg.ts, error: String(err) },
          'Failed to delete reply message',
        );
      }
    }

    // Delete root message last (whether or not it appeared in the replies list)
    void rootPresent; // root is always attempted
    try {
      await this.app.client.chat.delete({ channel: ref.channel_id, ts: ref.conversation_id });
      deletedCount++;
    } catch (err) {
      failedMessages.push({ message_id: ref.conversation_id, error: String(err) });
      this.logger.warn(
        { event: 'slack.thread_prune_partial', channel_id: ref.channel_id, message_ts: ref.conversation_id, error: String(err) },
        'Failed to delete root message',
      );
    }

    const duration_ms = Math.round(performance.now() - startMs);
    const status = failedMessages.length === 0 ? 'ok' : 'partial';

    if (status === 'ok') {
      this.logger.info(
        { event: 'slack.thread_pruned', channel_id: ref.channel_id, conversation_id: ref.conversation_id, deleted_messages: deletedCount, duration_ms },
        'Slack thread pruned',
      );
    } else {
      this.logger.warn(
        { event: 'slack.thread_prune_partial', channel_id: ref.channel_id, conversation_id: ref.conversation_id, deleted_messages: deletedCount, failed_count: failedMessages.length, duration_ms },
        'Slack thread partially pruned',
      );
    }

    return { status, deleted_messages: deletedCount, failed_messages: failedMessages, errors: failedMessages.map(f => f.error) };
  }
}
