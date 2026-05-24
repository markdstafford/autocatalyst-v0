import type { LastImplementationResult, RequestIntent } from './runs.js';

export interface TrackedIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed' | string;
  url?: string;
}

export interface IssueManager {
  getIssue(repo_url: string, issue_number: number): Promise<TrackedIssue>;
  writeIssue(workspace_path: string, issue_number: number, body: string): Promise<void>;
  create(workspace_path: string, title: string, body: string, labels?: string[]): Promise<{ number: number }>;
}

export interface PRManagerOptions {
  impl_result?: LastImplementationResult;
  run_intent?: RequestIntent;
  issue_number?: number;
  title?: string;
}

export interface PRManager {
  createPR(
    workspace_path: string,
    branch: string,
    artifact_path: string,
    options?: PRManagerOptions,
  ): Promise<string>;

  mergePR(
    workspace_path: string,
    pr_url: string,
  ): Promise<void>;
}
