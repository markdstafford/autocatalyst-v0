import { describe, expect, it } from 'vitest';
import { CommandConfirmationRegistryImpl } from '../../src/core/command-confirmations.js';
import type { ConversationRef } from '../../src/types/channel.js';

const conversation: ConversationRef = { provider: 'slack', channel_id: 'C123', conversation_id: '1710000000.000000' };

describe('CommandConfirmationRegistryImpl', () => {
  it('creates and consumes one pending confirmation for the same conversation and author', () => {
    const registry = new CommandConfirmationRegistryImpl<{ request_ids: string[] }>();
    registry.create({ id: 'confirm-001', command: 'prune', conversation, requested_by: 'U123', expires_at: '2026-05-28T00:10:00.000Z', payload: { request_ids: ['request-001'] } });
    const consumed = registry.consume(conversation, 'U123', 'Yes', new Date('2026-05-28T00:09:00.000Z'));
    expect(consumed?.id).toBe('confirm-001');
    expect(consumed?.response).toBe('Yes');
    expect(registry.hasPending(conversation)).toBe(false);
  });

  it('does not consume a pending confirmation from a different author', () => {
    const registry = new CommandConfirmationRegistryImpl<{}>();
    registry.create({ id: 'confirm-001', command: 'prune', conversation, requested_by: 'U123', expires_at: '2026-05-28T00:10:00.000Z', payload: {} });
    expect(registry.consume(conversation, 'U999', 'Yes', new Date('2026-05-28T00:09:00.000Z'))).toBeUndefined();
    expect(registry.hasPending(conversation, new Date('2026-05-28T00:09:00.000Z'))).toBe(true);
  });

  it('expires old entries on consume and sweep', () => {
    const registry = new CommandConfirmationRegistryImpl<{}>();
    registry.create({ id: 'confirm-001', command: 'prune', conversation, requested_by: 'U123', expires_at: '2026-05-28T00:10:00.000Z', payload: {} });
    expect(registry.consume(conversation, 'U123', 'Yes', new Date('2026-05-28T00:11:00.000Z'))).toBeUndefined();
    expect(registry.hasPending(conversation)).toBe(false);
    registry.create({ id: 'confirm-002', command: 'prune', conversation, requested_by: 'U123', expires_at: '2026-05-28T00:12:00.000Z', payload: {} });
    expect(registry.sweepExpired(new Date('2026-05-28T00:13:00.000Z'))).toBe(1);
  });
});
