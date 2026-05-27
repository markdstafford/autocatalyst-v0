---
created: 2026-05-24
last_updated: 2026-05-27
status: complete
issue: 184
specced_by: autocatalyst
implemented_by: markdstafford
superseded_by: null
---
# Enhancement: Run status workspace and AI context

## Parent features

- `feature-command-mode.md` — provides Slack command parsing and command handler registration
- `enhancement-agent-progress-updates.md` — establishes human-visible progress during long-running agent work
- `enhancement-model-provider-config.md` — defines model routing profiles used by agent calls
- `enhancement-model-runner-telemetry.md` — adds model-level telemetry for agent runner executions
## What

The `ac-run-status` command shows more operational context for a run. Successful replies use this line order: run ID, workspace, intent, stage, time in stage, then AI context when applicable. The workspace appears immediately after the run ID so operators can jump to disk before reading the rest of the run state. When the run is in an AI-active stage, the reply also includes the model selected for the latest agent invocation and the age of the latest agent request.
The workspace line is always present. It is populated directly from `run.workspace_path` as soon as that known run information is available; it does not depend on an agent request or AI metadata having been recorded. If a workspace has not been allocated yet, the command says `not yet allocated` instead of showing an empty string. The AI context block is conditional and appears only for the stages where Autocatalyst may be running or surfacing agent work for the loop: `speccing`, `reviewing_spec`, `planning`, `implementing`, and `reviewing_implementation`.
## Why

Operators use `ac-run-status` while a run is active and need enough context to inspect or recover it without leaving Slack to search logs. Today the command omits the workspace path, even though that path is already stored on the run. This makes it harder to inspect files, run tests, or clean up a stuck run.
The command also gives no signal about which model is handling current agent work or whether an agent request happened recently. When an implementation or spec run appears quiet, the operator has to check logs to distinguish normal long-running agent work from a stalled process. Showing the selected model and last-request age gives quick confidence that the AI layer is active and using the expected route.
## User stories

- Enzo can run `:ac-run-status:` in a run thread and see the exact workspace path to inspect on disk.
- Enzo can run `:ac-run-status: ` outside a thread and get the same workspace and AI context for that run.
- Phoebe can check an active implementation and see which model Autocatalyst invoked without opening logs.
- An operator can see that the last AI request was sent a few minutes ago and decide whether the run is still likely progressing.
- An operator can check a run before workspace allocation and see `Workspace: not yet allocated` instead of a blank or misleading path.
- An operator can check a run in `awaiting_impl_input`, `done`, or `failed` and see no stale model/request block.
## Design changes

This is a Slack command output change only. No new UI surface is introduced.
Current response shape:
```plain text
*Run:* `run-abc123`
*Stage:* `implementing`
*Intent:* `idea`
*Time in stage:* 12m
```
New response shape for an active implementation with agent metadata:
```plain text
*Run:* `run-abc123`
*Workspace:* `/home/runner/workspaces/run-abc123`
*Intent:* `idea`
*Stage:* `implementing`
*Time in stage:* 12m
*Model:* `claude-sonnet-4-5`
*Last request:* 2m ago
```
New response shape before workspace allocation:
```plain text
*Run:* `run-abc123`
*Workspace:* not yet allocated
*Intent:* `idea`
*Stage:* `intake`
*Time in stage:* 8s
```
If a run is in an AI-active stage but metadata has not been recorded yet, the AI lines are still shown with explicit placeholders:
```plain text
*Model:* not yet requested
*Last request:* not yet requested
```
This avoids hiding the block during a stage where AI work is expected and makes startup race conditions visible.
## Technical changes

### Affected files

- `src/types/runs.ts` — add optional `current_model?: string` and `last_agent_request_at?: string` fields to `Run`.
- `src/types/ai.ts` — add a shared optional agent invocation metadata callback to agent-service telemetry types, or a small exported type used by agent services and handlers.
- `src/core/commands/run-commands.ts` — extend `makeRunStatusHandler` output with workspace path and conditional AI context formatting.
- `src/core/ai/agent-services.ts` — when resolving an agent profile for artifact creation, artifact revision, implementation planning, implementation, and other agent-backed loop work, notify the callback with the resolved model and request timestamp before starting to drain the runner.
- `src/core/handlers/artifact-creation-handler.ts` — pass an agent metadata callback that updates the current run during initial spec/triage generation.
- `src/core/handlers/artifact-feedback-handler.ts` — pass the same callback during spec revision.
- `src/core/handlers/planning-handler.ts` — pass the callback during implementation planning.
- `src/core/handlers/implementation-start-handler.ts` — pass the callback during implementation and initial implementation review work.
- `src/core/handlers/implementation-feedback-handler.ts` — pass the callback during implementation feedback runs.
- `src/core/ai/implementation-review-coordinator.ts` — preserve and forward agent metadata callbacks for initial/final review agents if the coordinator invokes agent-backed review or fix-up work.
- `src/core/orchestrator.ts` — clear AI metadata when a run transitions out of the AI-active stage set; also clear it on operator stage override when the target stage is not AI-active.
- `tests/core/commands/run-commands.test.ts` — cover workspace and AI context output.
- `tests/core/ai/agent-services.test.ts` — cover callback invocation when an agent profile is resolved and a run starts.
- `tests/core/orchestrator.test.ts` and/or handler tests — cover run metadata updates and clearing on non-AI stages.
### Changes

#### 1. Prerequisites and assumptions

- Depends on `feature-command-mode.md` and the existing `makeRunStatusHandler` command implementation.
- Depends on the existing `Run.workspace_path` field. No schema migration is needed for workspace display.
- Depends on the existing `AgentRoutingPolicy.resolve(route)` call sites in `src/core/ai/agent-services.ts`; these call sites know the exact profile selected for an agent invocation.
- The low-level `ClaudeAgentSdkAgentRunner` does not own run state and should not mutate `Run` directly. It should continue to emit telemetry and runner events only.
- The run store persists unknown optional fields as JSON without extra schema code. Existing persisted runs that do not have the new fields remain valid.
- No new npm packages are required.
#### 2. Scope

**In scope**
- Add `Workspace` to every successful `ac-run-status` reply, immediately after the `Run` line.
- Populate `Workspace` from `run.workspace_path` independently of AI request metadata.
- Show `not yet allocated` when `run.workspace_path` is empty or whitespace.
- Add optional `current_model` and `last_agent_request_at` to `Run`.
- Record `current_model` and `last_agent_request_at` immediately before each agent invocation starts.
- Update the timestamp on every new agent invocation, not only on stage transition.
- Show `Model` and `Last request` only when `run.stage` is in the AI-active set.
- Format `Last request` as a short relative age with an `ago` suffix, for example `42s ago`, `3m ago`, or `1h 12m ago`.
- Clear AI metadata when a run transitions to a non-AI-active stage so terminal and waiting stages do not show stale model data.
- Preserve current command lookup behavior by inferred thread request ID, explicit request ID, or explicit run ID.
**Out of scope**
- Changing `ac-run-list` output.
- Adding a new health endpoint or dashboard field.
- Showing token usage, request IDs, provider base URLs, or profile IDs in Slack.
- Recording direct model runner calls used outside the run loop, such as intent classification, unless they are already represented as agent-service invocations for a run.
- Guaranteeing that a provider exposes lower-level HTTP request timing. This enhancement records when Autocatalyst starts an agent invocation, not when the provider receives each internal model request.
#### 3. Run data model

Extend `Run` in `src/types/runs.ts`:
```typescript
export interface Run {
  id: string;
  request_id: string;
  intent: RequestIntent;
  stage: RunStage;
  workspace_path: string;
  branch: string;
  current_model?: string;
  last_agent_request_at?: string;
  // existing fields...
}
```
Field semantics:
- `current_model` is the model string from the resolved agent profile for the latest agent invocation in the current AI-active stage.
- `last_agent_request_at` is an ISO timestamp created immediately before invoking `runner.run(...)` or beginning to drain its returned iterable.
- If the profile does not contain a model, store `'unknown'`. This matches existing runner telemetry behavior.
- Both fields are optional for compatibility with persisted runs created before this enhancement.
No migration function is required. `migrateRun()` in `src/core/run-store.ts` can leave missing fields unset.
#### 4. AI-active stages

Define one shared stage set near the command formatter and use the same set for clearing logic:
```typescript
const AI_ACTIVE_STAGES: ReadonlySet = new Set([
  'speccing',
  'reviewing_spec',
  'planning',
  'implementing',
  'reviewing_implementation',
]);
```
This set follows issue #184. It includes stages where AI work is either running or recently produced the artifact/status the human is reviewing. Stages that wait for additional human input (`awaiting_planning_input`, `awaiting_impl_input`) and terminal stages (`done`, `failed`) are not active.
To avoid duplicate constants, place the set in a small module such as `src/core/run-ai-context.ts` if both commands and orchestrator need it:
```typescript
import type { Run, RunStage } from '../types/runs.js';

export const AI_ACTIVE_STAGES: ReadonlySet = new Set([...]);

export function isAiActiveStage(stage: RunStage): boolean {
  return AI_ACTIVE_STAGES.has(stage);
}

export function recordAgentRequest(run: Run, model: string | undefined, now = new Date()): void {
  run.current_model = model?.trim() || 'unknown';
  run.last_agent_request_at = now.toISOString();
}

export function clearAgentRequestContext(run: Run): void {
  delete run.current_model;
  delete run.last_agent_request_at;
}
```
#### 5. Recording model and request time

Prefer recording metadata in the agent-service layer, not in `ClaudeAgentSdkAgentRunner`. The agent-service layer already resolves the `AgentProfile` and receives run telemetry from handlers. The runner only sees an `AgentRunRequest` and should remain reusable outside orchestrator-owned runs.
Add a small callback type:
```typescript
export interface AgentInvocationMetadata {
  model: string;
  requested_at: string;
  route: AgentRoute;
}

export interface AgentServiceTelemetry {
  run_id?: string;
  request_id?: string;
  onAgentRequest?: (metadata: AgentInvocationMetadata) => void;
}
```
Replace repeated inline telemetry types like `{ run_id?: string; request_id?: string }` in agent service interfaces with `AgentServiceTelemetry` where these services already accept telemetry. This preserves backwards compatibility because the new field is optional.
In each agent-service method, resolve the profile once, record metadata, then pass the same profile into the runner:
```typescript
const profile = this.routingPolicy.resolve(route);
telemetry?.onAgentRequest?.({
  model: profile.model ?? 'unknown',
  requested_at: new Date().toISOString(),
  route,
});

await drainAgentRunner(
  this.runner.run({
    route,
    profile,
    working_directory,
    prompt,
    telemetry: { ... },
  }),
  onProgress,
  this.logger,
  'implementation',
  { run_id: telemetry?.run_id, request_id: telemetry?.request_id },
);
```
This pattern must be applied to:
- artifact creation (`artifact.create`)
- artifact revision (`artifact.revise`)
- implementation planning (`implementation.plan`)
- implementation run (`implementation.run`)
- question answering only if the question is part of a run stage that should surface AI context; otherwise leave out of this enhancement
- issue triage only if it flows through the same agent-service abstraction and has a run
- implementation review coordinator calls if they invoke agent work during implementation review
The timestamp is recorded before awaiting the result. This means `ac-run-status` can show a recent request while the agent call is still in progress.
#### 6. Handler callback wiring

Each handler that starts agent work should pass a callback that mutates the in-memory `Run` and persists it immediately:
```typescript
const onAgentRequest = ({ model, requested_at }: AgentInvocationMetadata): void => {
  run.current_model = model || 'unknown';
  run.last_agent_request_at = requested_at;
  this.deps.persist();
};
```
Pass this callback in the existing telemetry argument:
```typescript
await this.deps.implementer.implement(
  refs.local_path,
  run.workspace_path,
  additionalContext,
  onProgress,
  { run_id: run.id, request_id: run.request_id, onAgentRequest },
  planPath,
);
```
Handlers should not derive the model themselves. They should trust the agent-service callback because that callback receives the resolved profile used for the actual invocation.
If a handler transitions into an AI-active stage and the callback has not fired yet, `ac-run-status` may temporarily show `not yet requested`. That is acceptable and makes the short startup window explicit.
#### 7. Command output formatting

Update `src/core/commands/run-commands.ts` with helper functions:
```typescript
function formatWorkspacePath(workspacePath: string): string {
  const trimmed = workspacePath.trim();
  return trimmed ? `\`${trimmed}\`` : 'not yet allocated';
}

function formatLastRequest(isoDate: string | undefined): string {
  if (!isoDate) return 'not yet requested';
  return `${formatTimeSince(isoDate)} ago`;
}
```
Build the response as lines instead of a single template string:
```typescript
const lines = [
  `*Run:* \`${run.id}\``,
  `*Workspace:* ${formatWorkspacePath(run.workspace_path)}`,
  `*Intent:* \`${run.intent}\``,
  `*Stage:* \`${run.stage}\`${stageSuffix}`,
  `*Time in stage:* ${timeInStage}`,
];

if (isAiActiveStage(run.stage)) {
  lines.push(`*Model:* ${run.current_model ? `\`${run.current_model}\`` : 'not yet requested'}`);
  lines.push(`*Last request:* ${formatLastRequest(run.last_agent_request_at)}`);
}

await reply(lines.join('\n'));
```
Keep existing `done` and `failed` stage suffixes. Do not add the AI block to terminal stages even if persisted metadata exists. The final successful reply order is `Run`, `Workspace`, `Intent`, `Stage`, `Time in stage`, then `Model` and `Last request` for AI-active stages.
#### 8. Clearing stale metadata

Update `transition(run, stage)` in `src/core/orchestrator.ts` after `run.stage` is set:
```typescript
run.stage = stage;
if (!isAiActiveStage(stage)) {
  clearAgentRequestContext(run);
}
run.updated_at = new Date().toISOString();
```
Also update `overrideRunStage()` so operator changes to non-AI-active stages clear stale fields. If an operator changes a run into an AI-active stage, do not synthesize metadata; leave fields absent until the next agent request.
Do not clear metadata on every transition between AI-active stages. For example, `speccing → reviewing_spec` may still usefully show the model that generated the spec while the human reviews it. A later `reviewing_spec → planning` or `planning → implementing` callback updates the fields with the new actual model.
#### 9. Persistence

The existing orchestrator persistence path should save the new optional fields whenever handlers call `persist()` after recording metadata. Confirm that places which mutate run metadata but do not call `transition()` still call `persist()`.
No special run-store migration is required. If a persisted run lacks `current_model` and `last_agent_request_at`, command output uses placeholders or omits the AI block depending on stage.
#### 10. Observability

Add one structured log event where run metadata is recorded. This can live in handler callback code or in a helper used by handlers:

Event
Level
Fields
Condition

`run.agent_request_recorded`
info
`run_id`, `request_id`, `model`, `route_task`, `route_stage`, `route_intent`
Emitted after `current_model` and `last_agent_request_at` are updated

No new metrics are required. Existing `agent.run_started`, `agent.drain_started`, and model runner telemetry remain the detailed diagnostics path.
#### 11. Testing plan

**Command tests — ****`tests/core/commands/run-commands.test.ts`**
- `run.status` includes `*Workspace:* \`/ws/req-001\`` when `workspace_path\` is non-empty.
- `run.status` includes `*Workspace:* not yet allocated` when `workspace_path` is `''` or whitespace.
- `run.status` orders successful reply lines as `Run`, `Workspace`, `Intent`, `Stage`, `Time in stage`, then optional `Model` and `Last request`.
- `implementing` run with `current_model` and `last_agent_request_at` includes `Model` and `Last request` lines.
- `implementing` run without metadata includes `Model: not yet requested` and `Last request: not yet requested`.
- `awaiting_impl_input` run with stale metadata does not include `Model` or `Last request`.
- `done` and `failed` runs with stale metadata do not include `Model` or `Last request`.
- Existing lookup behavior by inferred request ID, explicit request ID, and explicit run ID still passes.
Use fake timers or a timestamp near `Date.now()` to assert stable last-request formatting.
**Agent service tests — ****`tests/core/ai/agent-services.test.ts`**
- `AgentRunnerImplementationAgent.implement()` calls `onAgentRequest` before draining completes and passes the resolved `profile.model`.
- `AgentRunnerImplementationPlanningAgent.plan()` calls `onAgentRequest` with the planning route and model.
- `AgentRunnerArtifactAuthoringAgent.create()` and `.revise()` call `onAgentRequest` with the artifact route and model.
- Missing `profile.model` is reported as `'unknown'`.
- The same resolved profile object is passed to `runner.run()` after callback invocation.
**Handler/orchestrator tests**
- Starting artifact creation records `run.current_model`, sets `run.last_agent_request_at`, and persists.
- Starting implementation planning updates `last_agent_request_at` again, proving the timestamp changes per invocation.
- Starting implementation updates `current_model` to the implementation route's model when it differs from the planning model.
- Transition from an AI-active stage to `awaiting_impl_input` clears both fields.
- Transition to `done` or `failed` clears both fields.
- Operator `overrideRunStage()` to `done`, `failed`, `awaiting_impl_input`, or `awaiting_planning_input` clears stale metadata.
#### 12. Alternatives considered

**Mutate the run from ****`ClaudeAgentSdkAgentRunner`**
Rejected. The runner does not own orchestrator state, and coupling it to `Run` would make it harder to reuse for non-run tasks. The agent-service layer already resolves the exact profile and receives run telemetry, so it is the right seam for reporting invocation metadata.
**Resolve the model at command time**
Rejected. Resolving at command time would show what the routing policy would choose now, not necessarily what was invoked earlier in the run. Storing the model at invocation time records what actually ran.
**Parse model names from logs**
Rejected. Logs are diagnostic output, not application state. Parsing them for command output would be slower, more fragile, and harder to test.
**Show the AI block for every non-terminal stage**
Rejected. Waiting stages like `awaiting_impl_input` are specifically human-input states. Showing stale model metadata there would imply the AI is still active when it is waiting.
#### 13. Risks

**The recorded timestamp is an Autocatalyst invocation timestamp, not provider HTTP timing**
The Claude Agent SDK may make multiple internal model calls during a single agent run. This enhancement records when Autocatalyst started the agent invocation. It does not observe each provider request unless the SDK exposes that later. The Slack label `Last request` should be understood as the latest Autocatalyst agent request.
**Review stages may show the model from recently completed agent work**
The issue asks to include `reviewing_spec` and `reviewing_implementation` in the AI-active set. In current orchestration, those stages can also represent human review after agent work completes. The spec keeps metadata visible in those stages because it is useful context for the artifact under review, but it does not claim a provider request is still running.
**Persist timing depends on handler wiring**
If a new handler invokes an agent but forgets to pass `onAgentRequest`, `ac-run-status` will show `not yet requested` or stale data for that path. Mitigation: centralize helper types and tests around all current agent-service methods, and document the callback as required for run-scoped agent invocations.
## Task list

### Story 1 — Extend run state and shared AI context helpers

**Task 1.1 — Add optional AI request fields to ****`Run`**
- **Description**: Add `current_model?: string` and `last_agent_request_at?: string` to `Run` in `src/types/runs.ts`.
- **Acceptance criteria**:
	- `Run` accepts both optional fields.
	- Existing tests and persisted run fixtures compile without setting the fields.
	- `npm run typecheck` passes.
- **Dependencies**: None
**Task 1.2 — Add shared AI-active stage helper**
- **Description**: Create `src/core/run-ai-context.ts` with `AI_ACTIVE_STAGES`, `isAiActiveStage()`, `recordAgentRequest()`, and `clearAgentRequestContext()`.
- **Acceptance criteria**:
	- The AI-active set contains `speccing`, `reviewing_spec`, `planning`, `implementing`, and `reviewing_implementation`.
	- `recordAgentRequest()` stores `unknown` for missing/blank model names.
	- `clearAgentRequestContext()` removes both optional fields.
	- Unit tests cover helper behavior if helper tests are customary in this repo; otherwise behavior is covered through command/orchestrator tests.
- **Dependencies**: Task 1.1
### Story 2 — Update `ac-run-status` output

**Task 2.1 — Add workspace output**
- **Description**: Update `makeRunStatusHandler` to build response lines and always include `*Workspace:*` with a backticked path or `not yet allocated`.
- **Acceptance criteria**:
	- Non-empty workspace paths are shown exactly once, wrapped in backticks, and placed immediately after the `Run` line.
	- Empty and whitespace workspace paths show `not yet allocated`.
	- Workspace output does not depend on `current_model`, `last_agent_request_at`, or any agent request being sent.
	- Existing run ID, stage, intent, time-in-stage, and terminal suffix content is unchanged, aside from the new line order.
- **Dependencies**: None
**Task 2.2 — Add conditional AI context output**
- **Description**: Use `isAiActiveStage()` in `makeRunStatusHandler` to show `Model` and `Last request` lines only for AI-active stages.
- **Acceptance criteria**:
	- `implementing` with metadata shows model in backticks and relative request age with `ago`.
	- AI-active stages without metadata show `not yet requested` placeholders.
	- `awaiting_impl_input`, `awaiting_planning_input`, `done`, and `failed` do not show AI context lines.
	- Existing lookup tests by request ID and run ID still pass.
- **Dependencies**: Task 1.2, Task 2.1
### Story 3 — Record agent invocation metadata

**Task 3.1 — Add agent invocation metadata telemetry type**
- **Description**: Add `AgentInvocationMetadata` and `AgentServiceTelemetry` types in `src/types/ai.ts`, then update agent service method signatures to accept `AgentServiceTelemetry` instead of repeated inline telemetry shapes.
- **Acceptance criteria**:
	- `onAgentRequest` is optional and backwards compatible.
	- All existing call sites compile without changes until callbacks are wired.
	- The metadata includes model, requested timestamp, and route.
- **Dependencies**: Task 1.1
**Task 3.2 — Invoke callback from agent services**
- **Description**: In `src/core/ai/agent-services.ts`, resolve each profile into a local variable, call `telemetry?.onAgentRequest?.(...)`, and pass the same profile to `runner.run()`.
- **Acceptance criteria**:
	- Artifact create, artifact revise, implementation planning, and implementation run paths call the callback before awaiting drain completion.
	- Missing model is reported as `unknown`.
	- Callback failures do not mask agent execution unless the chosen callback deliberately throws; prefer catching/logging in handlers or make the callback non-throwing.
	- Existing runner behavior and prompt construction are unchanged.
- **Dependencies**: Task 3.1
**Task 3.3 — Wire handler callbacks to update runs**
- **Description**: In run-scoped handlers, pass an `onAgentRequest` callback that updates the run, persists, and logs `run.agent_request_recorded`.
- **Acceptance criteria**:
	- Spec creation and revision update `current_model` and `last_agent_request_at`.
	- Planning updates both fields.
	- Implementation and implementation feedback updates both fields.
	- If implementation review coordinator invokes agent-backed work, metadata is forwarded through that path as well.
	- Each update calls `persist()` after mutation.
- **Dependencies**: Task 3.2
### Story 4 — Clear stale metadata on non-AI stages

**Task 4.1 — Clear fields in normal transitions**
- **Description**: Update `transition(run, stage)` in `src/core/orchestrator.ts` to call `clearAgentRequestContext(run)` when the target stage is not AI-active.
- **Acceptance criteria**:
	- Transition to `awaiting_impl_input` clears metadata.
	- Transition to `awaiting_planning_input` clears metadata.
	- Transition to `done` and `failed` clears metadata.
	- Transition between AI-active stages preserves metadata until a new agent invocation updates it.
- **Dependencies**: Task 1.2
**Task 4.2 — Clear fields in operator stage overrides**
- **Description**: Update `overrideRunStage()` to clear AI metadata when the target stage is not AI-active.
- **Acceptance criteria**:
	- Override to a waiting or terminal stage clears stale fields.
	- Override to an AI-active stage does not synthesize metadata.
	- Stage override logging remains unchanged except for any added structured field if useful.
- **Dependencies**: Task 4.1
### Story 5 — Tests

**Task 5.1 — Add run status command tests**
- **Description**: Extend `tests/core/commands/run-commands.test.ts` for workspace output and conditional AI context.
- **Acceptance criteria**:
	- Tests cover non-empty workspace, unallocated workspace, the required line order, implementing with metadata, implementing without metadata, and non-AI stages with stale metadata.
	- Tests use stable time control for request-age formatting.
	- Existing command tests still pass.
- **Dependencies**: Story 2
**Task 5.2 — Add agent-service callback tests**
- **Description**: Extend `tests/core/ai/agent-services.test.ts` to assert `onAgentRequest` callback behavior for each agent service path.
- **Acceptance criteria**:
	- Callback receives resolved model and route for artifact create/revise, planning, and implementation.
	- Callback fires before the service resolves its final result.
	- Unknown model fallback is covered.
	- The resolved profile is still passed to `runner.run()`.
- **Dependencies**: Story 3
**Task 5.3 — Add run metadata lifecycle tests**
- **Description**: Extend orchestrator and/or handler tests to cover mutation, persistence, and clearing of run AI metadata.
- **Acceptance criteria**:
	- A run records metadata when an agent-backed handler starts.
	- A second agent invocation updates `last_agent_request_at`.
	- Normal transitions to waiting/terminal stages clear metadata.
	- Operator stage overrides to waiting/terminal stages clear metadata.
- **Dependencies**: Story 3, Story 4