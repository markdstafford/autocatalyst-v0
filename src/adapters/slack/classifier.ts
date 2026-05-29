import type { ThreadRegistry } from './thread-registry.js';

export interface MessageInput {
  text: string | undefined;
  user: string;
  ts: string;
  thread_ts?: string;
}

export type MessageClassification =
  | { intent: 'new_request' }
  | { intent: 'thread_message'; request_id: string }
  | { intent: 'command'; command: string; args: string[] }
  | { intent: 'ignore' };

export const EMOJI_COMMAND_TABLE: Record<string, string> = {
  'ac-run-status': 'run.status',
  'ac-run-list': 'run.list',
  'ac-run-cancel': 'run.cancel',
  'ac-run-logs': 'run.logs',
  'ac-health': 'health',
  'ac-help': 'help',
  'ac-classify-intent': 'classify-intent',
  'ac-set-status': 'run.set-status',
  'ac-prune': 'prune',
};

/**
 * Commands that may only be dispatched via a Slack message, never via an emoji reaction.
 * The reaction_added handler checks this set and discards the event before fetching
 * message history or emitting a CommandEvent.
 */
export const MESSAGE_ONLY_COMMANDS = new Set<string>(['run.set-status']);

export function classifyMessage(
  message: MessageInput,
  botUserId: string,
  registry: ThreadRegistry,
): MessageClassification {
  // Suppress bot's own messages (prevents response loops)
  if (message.user === botUserId) return { intent: 'ignore' };

  // Command detection: scan for :ac-*: pattern before @mention check (first match only)
  const commandMatch = message.text?.match(/:ac-([a-z0-9_-]+):/);
  if (commandMatch) {
    const emojiKey = `ac-${commandMatch[1]}`;
    const commandName = EMOJI_COMMAND_TABLE[emojiKey];
    if (commandName) {
      // MESSAGE_ONLY_COMMANDS require a registered run thread — reject root and unregistered messages
      if (MESSAGE_ONLY_COMMANDS.has(commandName)) {
        const isReply = message.thread_ts !== undefined && message.thread_ts !== message.ts;
        if (!isReply || registry.resolve(message.thread_ts!) === undefined) {
          return { intent: 'ignore' };
        }
      }
      const stripped = (message.text ?? '').replace(/:ac-[a-z0-9_-]+:/, '').trim();
      const args = stripped ? stripped.split(/\s+/) : [];
      return { intent: 'command', command: commandName, args };
    }
    // Unrecognized :ac-*: emoji — fall through to @mention logic
  }

  // Thread reply: thread_ts exists and differs from ts
  const isReply = message.thread_ts !== undefined && message.thread_ts !== message.ts;
  if (isReply) {
    // Must contain exact @mention token for bot
    const mention = `<@${botUserId}>`;
    if (!message.text || !message.text.includes(mention)) {
      return { intent: 'ignore' };
    }

    const request_id = registry.resolve(message.thread_ts!);
    if (request_id === undefined) return { intent: 'ignore' };
    return { intent: 'thread_message', request_id };
  }

  // Root message: must contain exact @mention token
  const mention = `<@${botUserId}>`;
  if (!message.text || !message.text.includes(mention)) {
    return { intent: 'ignore' };
  }

  return { intent: 'new_request' };
}
