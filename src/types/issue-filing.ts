import type { Request } from './events.js';
import type { AgentServiceTelemetry } from './ai.js';

export interface FiledIssue {
  number: number;
  title: string;
  action: 'filed' | 'duplicate';
}

export interface FilingResult {
  status: 'complete' | 'failed';
  summary: string;
  filed_issues: FiledIssue[];
  error?: string;
}

export interface IssueFiler {
  file(
    request: Request,
    workspace_path: string,
    onProgress?: (message: string) => Promise<void>,
    telemetry?: AgentServiceTelemetry,
  ): Promise<FilingResult>;
}
