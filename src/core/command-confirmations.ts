import { randomUUID } from 'node:crypto';
import type { ConversationRef } from '../types/channel.js';

export interface PendingCommandConfirmation<TPayload = unknown> {
  id: string;
  command: string;
  conversation: ConversationRef;
  requested_by: string;
  expires_at: string;
  payload: TPayload;
}

export interface ConsumedCommandConfirmation<TPayload = unknown> extends PendingCommandConfirmation<TPayload> {
  response: string;
}

export interface CommandConfirmationRegistry<TPayload = unknown> {
  create(pending: Omit<PendingCommandConfirmation<TPayload>, 'id'> & { id?: string }): PendingCommandConfirmation<TPayload>;
  consume(conversation: ConversationRef, author: string, response: string, now?: Date): ConsumedCommandConfirmation<TPayload> | undefined;
  hasPending(conversation: ConversationRef, now?: Date): boolean;
  sweepExpired(now?: Date): number;
}

function conversationKey(conversation: ConversationRef): string {
  return `${conversation.provider}:${conversation.channel_id}:${conversation.conversation_id}`;
}

export class CommandConfirmationRegistryImpl<TPayload = unknown> implements CommandConfirmationRegistry<TPayload> {
  private readonly map = new Map<string, PendingCommandConfirmation<TPayload>>();

  create(pending: Omit<PendingCommandConfirmation<TPayload>, 'id'> & { id?: string }): PendingCommandConfirmation<TPayload> {
    const entry: PendingCommandConfirmation<TPayload> = {
      ...pending,
      id: pending.id ?? randomUUID(),
    };
    this.map.set(conversationKey(pending.conversation), entry);
    return entry;
  }

  consume(conversation: ConversationRef, author: string, response: string, now: Date = new Date()): ConsumedCommandConfirmation<TPayload> | undefined {
    const key = conversationKey(conversation);
    const pending = this.map.get(key);
    if (!pending) return undefined;

    if (Date.parse(pending.expires_at) <= now.getTime()) {
      this.map.delete(key);
      return undefined;
    }

    if (pending.requested_by !== author) {
      return undefined;
    }

    this.map.delete(key);
    return { ...pending, response };
  }

  hasPending(conversation: ConversationRef, now: Date = new Date()): boolean {
    const key = conversationKey(conversation);
    const pending = this.map.get(key);
    if (!pending) return false;

    if (Date.parse(pending.expires_at) <= now.getTime()) {
      this.map.delete(key);
      return false;
    }

    return true;
  }

  sweepExpired(now: Date = new Date()): number {
    let count = 0;
    for (const [key, pending] of this.map) {
      if (Date.parse(pending.expires_at) <= now.getTime()) {
        this.map.delete(key);
        count++;
      }
    }
    return count;
  }
}
