import type { ConversationRef } from './channel.js';

export interface ThreadPruneFailure {
  message_id?: string;
  error: string;
}

export interface ThreadPruneResult {
  status: 'ok' | 'partial' | 'unsupported' | 'failed';
  deleted_messages: number;
  failed_messages: ThreadPruneFailure[];
  errors: string[];
}

export interface ThreadPruner {
  pruneThread(ref: ConversationRef): Promise<ThreadPruneResult>;
}
