import type { ClassificationContext, Intent, IntentClassifier } from './intent.js';
import type { Request, ThreadMessage } from './events.js';
import type { ArtifactKind } from './artifact.js';
import type { RunStage } from './runs.js';
import type { TelemetryContext } from '../core/ai/telemetry-context.js';
import type { NormalizedTokenUsage } from './journal.js';

export type AgentSessionCaptureFn = (data: {
  phase: string | null;
  step: AgentTaskKind | string;
  ts_start: string;
  ts_end: string;
  model: { provider: string; name: string | null };
  inference: { effort: AgentEffort | null; thinking: AgentThinking | null };
  tokens: NormalizedTokenUsage | null;
  assistant_turns: number | null;
  tool_calls: number | null;
  tool_results: number | null;
  outcome: 'ok' | 'failed' | 'incomplete';
  runner: 'anthropic_agent' | 'openai_agent';
  role?: AgentRole | string | null;
  round?: number;
  gate?: 'initial' | 'final' | string | null;
}) => void;

export type AgentTaskKind =
  | 'intent.classify'
  | 'artifact.create'
  | 'artifact.revise'
  | 'spec.review'
  | 'implementation.plan'
  | 'implementation.run'
  | 'implementation.review.initial'
  | 'implementation.review.final'
  | 'question.answer'
  | 'issue.triage'
  | 'pr.title_generate';

export type AgentRole = 'proposer' | 'critic';

export interface AgentRoute {
  task: AgentTaskKind;
  role?: AgentRole | string;
  stage?: RunStage | 'new_thread' | string;
  intent?: Intent;
  artifact_kind?: ArtifactKind;
}

export interface AgentInvocationMetadata {
  model: string;
  requested_at: string;
  route: AgentRoute;
  is_heartbeat?: boolean;
}

export interface AgentServiceTelemetry {
  run_id?: string;
  request_id?: string;
  phase?: string;
  captureSession?: AgentSessionCaptureFn;
  onAgentRequest?: (metadata: AgentInvocationMetadata) => void;
  route?: AgentRoute;
  role?: AgentRole | string;
  round?: number;
  gate?: 'initial' | 'final' | string;
}

export type AgentEffort = 'low' | 'medium' | 'high' | 'max';
export type AgentSettingSource = 'user' | 'project' | 'local';

export type AgentThinking =
  | 'adaptive'
  | 'disabled'
  | { type: 'enabled'; budget_tokens?: number };

export interface AgentPluginConfig {
  type: 'local';
  path: string;
}

export type AgentSkillNamespace = 'mm' | 'superpowers';
export type AgentSkillRef = `${AgentSkillNamespace}:${string}`;

export interface AgentProfile {
  id: string;
  provider: string;
  model?: string;
  effort?: AgentEffort;
  thinking?: AgentThinking;
  setting_sources?: AgentSettingSource[];
  load_user_settings?: boolean;
  required_skills?: AgentSkillRef[];
  plugins?: AgentPluginConfig[];
  api_key?: string;
  base_url?: string;
  anthropic_beta_header_filter?: {
    strip: string[];
  };
}

export interface AgentProfileSummary {
  profile: string;
  provider: string;
  model?: string;
}

export type ImplementationReviewFindingSeverity = 'blocker' | 'warning' | 'info';
export type ImplementationReviewFindingCategory =
  | 'correctness'
  | 'test'
  | 'security'
  | 'maintainability'
  | 'docs'
  | 'pr_readiness';

export interface ImplementationReviewFinding {
  id: string;
  severity: ImplementationReviewFindingSeverity;
  category: ImplementationReviewFindingCategory;
  finding: string;
  suggested_action?: string;
}

export interface ImplementationReviewResult {
  status: 'no_findings' | 'findings' | 'failed';
  summary: string;
  findings: ImplementationReviewFinding[];
  requires_human_retest?: boolean;
  error?: string;
}

export interface ImplementationReviewResponseItem {
  id: string;
  disposition: 'fixed' | 'declined' | 'needs_input';
  response: string;
}

export type ImplementationReviewExchangeStatus =
  | 'no_findings'
  | 'addressed'
  | 'degraded'
  | 'needs_input'
  | 'failed';

export interface ImplementationReviewExchange {
  id: string;
  phase: 'initial' | 'final';
  created_at: string;
  implementation_profile: AgentProfileSummary;
  review_profile: AgentProfileSummary;
  review_status: ImplementationReviewExchangeStatus;
  review_summary: string;
  findings: ImplementationReviewFinding[];
  responses: ImplementationReviewResponseItem[];
  requires_human_retest: boolean;
}

export type GateReviewName = 'initial' | 'final' | string;
export type GateNonConvergenceReason = 'max_rounds' | 'oscillation';

export interface GateReviewExchange {
  id: string;
  gate: GateReviewName;
  round: number;
  created_at: string;
  proposer_profile: AgentProfileSummary;
  critic_profile: AgentProfileSummary;
  review_status: ImplementationReviewExchangeStatus | 'non_converged' | 'converged';
  review_summary: string;
  findings: ImplementationReviewFinding[];
  responses: ImplementationReviewResponseItem[];
  converged: boolean;
  non_convergence_reason?: GateNonConvergenceReason;
  requires_human_retest: boolean;
}

export interface AgentRoutingPolicy {
  resolve(route: AgentRoute): AgentProfile;
  resolveOptional(route: AgentRoute): AgentProfile | null;
}

export interface DirectModelMessage {
  role: 'user';
  content: string;
}

export interface DirectModelRunRequest {
  route: AgentRoute;
  profile?: AgentProfile;
  model?: string;
  max_tokens?: number;
  messages: DirectModelMessage[];
}

export interface DirectModelRunResult {
  text: string;
  raw?: unknown;
  usage?: NormalizedTokenUsage | null;
  runner?: 'anthropic_direct' | 'openai_direct';
}

export interface DirectModelRunner {
  run(request: DirectModelRunRequest): Promise<DirectModelRunResult>;
}

export interface AgentRunContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export type AgentRunEvent =
  | { type: 'assistant'; content: AgentRunContentBlock[] }
  | { type: string; [key: string]: unknown };

export interface AgentDrainSummary {
  event_count: number;
  assistant_turn_count: number;
  relay_count: number;
  tool_call_count: number;
  tool_result_count: number;
  elapsed_ms: number;
  terminal_usage?: NormalizedTokenUsage | null;
  diagnostics?: {
    stderr_excerpt_redacted?: string;
  };
}

export interface AgentRunRequest {
  route: AgentRoute;
  profile?: AgentProfile;
  working_directory: string;
  prompt: string;
  telemetry?: TelemetryContext;
}

export interface AgentRunner {
  run(request: AgentRunRequest): AsyncIterable<AgentRunEvent>;
  close?(): Promise<void>;
}

export interface ArtifactComment {
  id: string;
  body: string;
}

export interface ArtifactCommentResponse {
  comment_id: string;
  response: string;
}

export interface ArtifactCreateResult {
  artifact_path: string;
  existing_issue?: number;
}

export interface ArtifactRevisionResult {
  comment_responses: ArtifactCommentResponse[];
  page_content?: string;
}

export interface ArtifactAuthoringAgent {
  create(
    request: Request,
    workspace_path: string,
    onProgress?: (message: string) => Promise<void>,
    intent?: 'idea' | 'bug' | 'chore',
    telemetry?: AgentServiceTelemetry,
  ): Promise<ArtifactCreateResult>;
  revise(
    feedback: ThreadMessage,
    artifact_comments: ArtifactComment[],
    artifact_path: string,
    workspace_path: string,
    current_page_markdown?: string,
    onProgress?: (message: string) => Promise<void>,
    telemetry?: AgentServiceTelemetry,
  ): Promise<ArtifactRevisionResult>;
  respondToSpecReview(
    artifact_path: string,
    workspace_path: string,
    review_prompt: string,
    current_page_markdown?: string,
    onProgress?: (message: string) => Promise<void>,
    telemetry?: AgentServiceTelemetry,
  ): Promise<SpecReviewAuthorResponseResult>;
}

export type ImplementationStatus = 'complete' | 'needs_input' | 'failed';

export interface ImplementationPlanResult {
  status: ImplementationStatus;
  plan_path?: string;
  question?: string;
  error?: string;
}

export interface ImplementationPlanningAgent {
  plan(
    artifact_path: string,
    working_directory: string,
    onProgress?: (message: string) => Promise<void>,
    telemetry?: AgentServiceTelemetry,
    additional_context?: string,
  ): Promise<ImplementationPlanResult>;
}

export interface ImplementationResult {
  status: ImplementationStatus;
  summary?: string;
  testing_instructions?: string;
  review_summary?: {
    changes: string[];
    confirm: string[];
  };
  testing_steps?: string[];
  resolved_feedback_items?: Array<{ id: string; resolution_comment: string }>;
  review_responses?: ImplementationReviewResponseItem[];
  requires_human_retest?: boolean;
  question?: string;
  error?: string;
}

export interface ImplementationAgent {
  implement(
    artifact_path: string,
    working_directory: string,
    additional_context?: string,
    onProgress?: (message: string) => Promise<void>,
    telemetry?: AgentServiceTelemetry,
    plan_path?: string,
  ): Promise<ImplementationResult>;
}

export interface QuestionAnsweringAgent {
  answer(question: string, telemetry?: AgentServiceTelemetry): Promise<string>;
}

export interface IssueTriageAgent {
  triage(
    request: Request,
    working_directory: string,
    onProgress?: (message: string) => Promise<void>,
    telemetry?: AgentServiceTelemetry,
  ): Promise<IssueTriageResult>;
}

export interface IssueTriageDuplicate {
  number: number;
  title: string;
}

export interface IssueTriageItem {
  proposed_title: string;
  proposed_body: string;
  proposed_labels: string[];
  duplicate_of: IssueTriageDuplicate | null;
}

export interface IssueTriageResult {
  status: 'complete' | 'failed';
  items: IssueTriageItem[];
  error?: string;
}

export type SpecReviewFindingSeverity = 'blocker' | 'warning' | 'info';
export type SpecReviewFindingCategory =
  | 'completeness'
  | 'clarity'
  | 'testability'
  | 'feasibility'
  | 'consistency'
  | 'template_conformance';

export interface SpecReviewFinding {
  id: string;
  severity: SpecReviewFindingSeverity;
  category: SpecReviewFindingCategory;
  finding: string;
  suggested_action?: string;
  requires_full_rewrite?: boolean;
}

export interface SpecReviewResult {
  status: 'no_findings' | 'findings' | 'failed';
  summary: string;
  findings: SpecReviewFinding[];
  error?: string;
}

export interface SpecReviewResponseItem {
  id: string;
  disposition: 'fixed' | 'declined' | 'needs_input';
  response: string;
}

export interface SpecReviewAuthorResponseResult {
  status: 'complete' | 'needs_input' | 'failed';
  responses: SpecReviewResponseItem[];
  page_content?: string;
  question?: string;
  error?: string;
}

export type { ClassificationContext, Intent, IntentClassifier };
