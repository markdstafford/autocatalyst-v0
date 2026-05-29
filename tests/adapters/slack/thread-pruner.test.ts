import { describe, it, expect, vi } from 'vitest';
import { SlackThreadPruner } from '../../../src/adapters/slack/thread-pruner.js';
import type { ConversationRef } from '../../../src/types/channel.js';

const nullDest = { write: () => {} } as unknown as import('pino').DestinationStream;

function makeConversationRef(overrides: Partial<ConversationRef> = {}): ConversationRef {
  return {
    provider: 'slack',
    channel_id: 'C123',
    conversation_id: '1000.000',
    ...overrides,
  };
}

function makeMockApp(options: {
  repliesPages?: Array<{ messages: Array<{ ts: string }>; next_cursor?: string }>;
  deleteError?: Error | null;
  repliesError?: Error | null;
}) {
  const deleteOrder: string[] = [];

  let pageIndex = 0;
  const pages = options.repliesPages ?? [{ messages: [{ ts: '1000.000' }, { ts: '1001.000' }, { ts: '1002.000' }] }];

  const app = {
    client: {
      conversations: {
        replies: vi.fn().mockImplementation(() => {
          if (options.repliesError) throw options.repliesError;
          const page = pages[pageIndex] ?? pages[pages.length - 1];
          pageIndex++;
          return Promise.resolve({
            messages: page.messages,
            response_metadata: page.next_cursor ? { next_cursor: page.next_cursor } : undefined,
          });
        }),
      },
      chat: {
        delete: vi.fn().mockImplementation(({ ts }: { ts: string }) => {
          deleteOrder.push(ts);
          if (options.deleteError) throw options.deleteError;
          return Promise.resolve({});
        }),
      },
    },
    _deleteOrder: deleteOrder,
  };
  return app;
}

describe('SlackThreadPruner', () => {
  it('returns unsupported for non-slack provider', async () => {
    const mock = makeMockApp({});
    const pruner = new SlackThreadPruner(mock as any, { logDestination: nullDest });
    const result = await pruner.pruneThread({ provider: 'github', channel_id: 'C123', conversation_id: '1000' });
    expect(result.status).toBe('unsupported');
    expect(result.deleted_messages).toBe(0);
    expect(mock.client.conversations.replies).not.toHaveBeenCalled();
  });

  it('deletes replies before root message', async () => {
    const mock = makeMockApp({
      repliesPages: [{ messages: [{ ts: '1000.000' }, { ts: '1001.000' }, { ts: '1002.000' }] }],
    });
    // 1000.000 is the root (conversation_id), 1001 and 1002 are replies
    const ref = makeConversationRef({ conversation_id: '1000.000' });
    const pruner = new SlackThreadPruner(mock as any, { logDestination: nullDest });
    const result = await pruner.pruneThread(ref);
    expect(result.status).toBe('ok');
    // Root should be deleted LAST
    expect(mock._deleteOrder[mock._deleteOrder.length - 1]).toBe('1000.000');
    expect(mock._deleteOrder.slice(0, -1)).toContain('1001.000');
    expect(mock._deleteOrder.slice(0, -1)).toContain('1002.000');
  });

  it('follows conversations.replies pagination', async () => {
    const mock = makeMockApp({
      repliesPages: [
        { messages: [{ ts: '1000.000' }, { ts: '1001.000' }], next_cursor: 'cursor1' },
        { messages: [{ ts: '1002.000' }, { ts: '1003.000' }] },
      ],
    });
    const ref = makeConversationRef({ conversation_id: '1000.000' });
    const pruner = new SlackThreadPruner(mock as any, { logDestination: nullDest });
    await pruner.pruneThread(ref);
    expect(mock.client.conversations.replies).toHaveBeenCalledTimes(2);
    // Second call should include cursor
    expect(mock.client.conversations.replies).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'cursor1' }));
    // Should have deleted all 4 messages (1001, 1002, 1003 as replies + 1000 as root)
    expect(mock._deleteOrder).toHaveLength(4);
  });

  it('returns partial when some deletes fail', async () => {
    // Make only specific deletes fail
    let deleteCount = 0;
    const mock = {
      client: {
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [{ ts: '1000.000' }, { ts: '1001.000' }],
          }),
        },
        chat: {
          delete: vi.fn().mockImplementation(() => {
            deleteCount++;
            if (deleteCount === 1) throw new Error('cant_delete_message');
            return Promise.resolve({});
          }),
        },
      },
    };
    const ref = makeConversationRef({ conversation_id: '1000.000' });
    const pruner = new SlackThreadPruner(mock as any, { logDestination: nullDest });
    const result = await pruner.pruneThread(ref);
    expect(result.status).toBe('partial');
    expect(result.failed_messages).toHaveLength(1);
    // Should continue and delete the remaining messages
    expect(mock.client.chat.delete).toHaveBeenCalledTimes(2);
  });

  it('returns failed when conversations.replies throws', async () => {
    const mock = makeMockApp({ repliesError: new Error('channel_not_found') });
    const pruner = new SlackThreadPruner(mock as any, { logDestination: nullDest });
    const result = await pruner.pruneThread(makeConversationRef());
    expect(result.status).toBe('failed');
    expect(result.deleted_messages).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('channel_not_found');
  });

  it('deletes only root when thread has no replies', async () => {
    const mock = makeMockApp({
      repliesPages: [{ messages: [{ ts: '1000.000' }] }],
    });
    const ref = makeConversationRef({ conversation_id: '1000.000' });
    const pruner = new SlackThreadPruner(mock as any, { logDestination: nullDest });
    const result = await pruner.pruneThread(ref);
    expect(result.status).toBe('ok');
    expect(result.deleted_messages).toBe(1);
    expect(mock._deleteOrder).toEqual(['1000.000']);
  });

  it('reports all failed messages in failed_messages array', async () => {
    const mock = {
      client: {
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [{ ts: '1000.000' }, { ts: '1001.000' }, { ts: '1002.000' }],
          }),
        },
        chat: {
          delete: vi.fn().mockRejectedValue(new Error('not_allowed')),
        },
      },
    };
    const pruner = new SlackThreadPruner(mock as any, { logDestination: nullDest });
    const result = await pruner.pruneThread(makeConversationRef({ conversation_id: '1000.000' }));
    expect(result.status).toBe('partial');
    expect(result.failed_messages).toHaveLength(3);
    expect(result.deleted_messages).toBe(0);
  });

  it('counts deleted messages correctly on success', async () => {
    const mock = makeMockApp({
      repliesPages: [{ messages: [{ ts: '1000.000' }, { ts: '1001.000' }, { ts: '1002.000' }] }],
    });
    const pruner = new SlackThreadPruner(mock as any, { logDestination: nullDest });
    const result = await pruner.pruneThread(makeConversationRef({ conversation_id: '1000.000' }));
    expect(result.status).toBe('ok');
    expect(result.deleted_messages).toBe(3);
    expect(result.failed_messages).toHaveLength(0);
  });
});
