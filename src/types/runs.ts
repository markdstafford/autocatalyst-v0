// src/types/runs.ts
import type { ChannelRef, ConversationRef, MessageRef } from './channel.js';
import type { Artifact } from './artifact.js';
import type { ImplementationReviewExchange } from './ai.js';

export type RunStage =
  | 'intake'
  | 'speccing'
  | 'reviewing_spec'
  | 'planning'
  | 'awaiting_planning_input'
  | 'implementing'
  | 'awaiting_impl_input'
  | 'reviewing_implementation'
  | 'pr_open'              // new: PR created, awaiting merge signal
  | 'done'
  | 'failed';

export const VALID_RUN_STAGES: RunStage[] = [
  'intake',
  'speccing',
  'reviewing_spec',
  'planning',
  'awaiting_planning_input',
  'implementing',
  'awaiting_impl_input',
  'reviewing_implementation',
  'pr_open',
  'done',
  'failed',
];

export type RequestIntent = 'idea' | 'bug' | 'chore' | 'file_issues' | 'question';

export interface ImplementationReviewSummary {
  changes: string[];
  confirm: string[];
}

export interface LastImplementationResult {
  summary: string;
  testing_instructions: string;
  review_summary?: ImplementationReviewSummary;
  testing_steps?: string[];
}

export interface Run {
  id: string;
  request_id: string;
  intent: RequestIntent;
  stage: RunStage;
  workspace_path: string;
  branch: string;
  artifact?: Artifact;
  implementation_plan_path?: string;
  impl_feedback_ref: string | undefined;
  issue: number | undefined;
  attempt: number;
  channel?: ChannelRef;
  conversation?: ConversationRef;
  origin?: MessageRef;
  pr_url: string | undefined;
  last_impl_result: LastImplementationResult | undefined;
  review_exchanges?: ImplementationReviewExchange[];
  created_at: string;
  updated_at: string;
}
