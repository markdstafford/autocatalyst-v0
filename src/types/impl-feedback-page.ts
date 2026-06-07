import type { GateReviewExchange, ImplementationReviewExchange } from './ai.js';

export type ImplementationReviewStatus =
  | 'not_started'
  | 'in_progress'
  | 'waiting_on_feedback'
  | 'approved';

export interface FeedbackItem {
  id: string;
  text: string;
  resolved: boolean;
  conversation: string[];
}

export interface PublishedImplementationReview {
  id: string;
  url?: string;
  label?: string;
}

export interface ImplementationReviewInput {
  artifact_ref: string;
  artifact_url?: string;
  title: string;
  workspace_path: string;
  branch: string;
  summary: string;
  testing_instructions: string;
  review_summary?: {
    changes: string[];
    confirm: string[];
  };
  testing_steps?: string[];
  review_exchanges?: ImplementationReviewExchange[];
  gate_exchanges?: GateReviewExchange[];
}

export interface ImplementationReviewPublisher {
  create(input: ImplementationReviewInput): Promise<PublishedImplementationReview>;

  readFeedback(review_ref: string): Promise<FeedbackItem[]>;

  update(
    review_ref: string,
    options: {
      summary?: string;
      review_summary?: {
        changes: string[];
        confirm: string[];
      };
      testing_steps?: string[];
      resolved_items?: Array<{
        id: string;
        resolution_comment: string;
      }>;
      review_exchanges?: ImplementationReviewExchange[];
      gate_exchanges?: GateReviewExchange[];
    },
  ): Promise<void>;

  updateStatus?(review_ref: string, status: ImplementationReviewStatus): Promise<void>;
  setPRLink?(review_ref: string, pr_url: string): Promise<void>;
}
