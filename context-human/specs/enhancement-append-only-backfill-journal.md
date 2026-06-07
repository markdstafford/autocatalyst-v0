---
created: 2026-06-07
last_updated: 2026-06-07
status: implementing
issue: 192
specced_by: autocatalyst
implemented_by: markdstafford
superseded_by: null
---
# Enhancement: Append-only backfill journal

## Parent feature

- `feature-run-persistence.md` — persists the current run registry in per-repo `.autocatalyst/runs.json`.
- `feature-approval-to-implementation.md` — defines the request-to-spec-to-implementation run lifecycle and thread-message routing.
- `enhancement-comprehensive-telemetry-instrumentation.md` — establishes structured logging, redaction expectations, and AI runner diagnostics.
- `enhancement-model-runner-telemetry.md` — adds model-run telemetry that this enhancement turns into durable per-session journal records.
- `enhancement-two-part-implementation-review.md` — provides `run.review_exchanges`, which is one source of AI-authored feedback records.
- `enhancement-run-status-workspace-ai-context.md` — adds current model and latest agent request metadata to active runs.
- `enhancement-existing-issue-work-routing.md` — introduces the existing-issue flow that may later let multiple runs coalesce under one topic.
## What

Autocatalyst adds a capture layer that writes an append-only JSONL journal under the per-repo `.autocatalyst/journal/` directory. The journal records the history needed to replay v0 runs into the future Autocatalyst data model: `Conversation`, `Topic`, `Run`, `Message`, `Feedback`, `RunStep`, `RunStepRole`, `Session`, and `Cost`.
The journal has four streams:
1. `messages.jsonl` records every run-associated inbound and outbound human-interface message.
2. `sessions.jsonl` records one model invocation session for every direct-model and agent-runner call that belongs to a run.
3. `feedback.jsonl` records human feedback and AI review findings with attribution and lifecycle fields.
4. `run-events.jsonl` records run creation and every run stage transition.
The capture layer is additive and config-gated by `journal.enabled`, which defaults to `true`. When disabled, Autocatalyst writes no journal files and preserves today's behavior. Journal write failures never fail a run; they are logged and swallowed.
This enhancement does not import the journal into the future schema. It captures a raw, redacted superset so a later importer can map the data after the new schema settles.
### Goals

- Create four append-only JSONL streams under per-repo `.autocatalyst/journal/`: `messages.jsonl`, `sessions.jsonl`, `feedback.jsonl`, and `run-events.jsonl`.
- Keep the journal independent of `runs.json` pruning, demotion, and rewriting.
- Record every run-associated inbound `new_request` and `thread_message` payload with redacted content and classified intent when classification is available; if a known-run inbound message cannot be classified, record `intent: null` with a classification status instead of inventing an intent.
- Record every outbound `postMessage()` reply from a single choke point instead of instrumenting each call site.
- Record one `sessions.jsonl` line for each model invocation associated with a run across Anthropic direct, OpenAI direct, Claude Agent SDK, and OpenAI Agent SDK runners.
- Include orchestrator-owned direct model calls such as `intent.classify` and `pr.title_generate` when they have run context.
- Normalize token counts to `{ input, output, cache_read, cache_write }` in adapter code where provider data is available.
- Record `tokens: null` when provider token data is unavailable.
- Record `inference.effort` and `inference.thinking` for every session from the resolved profile.
- Record `assistant_turns`, `tool_calls`, `tool_results`, and elapsed timing for agent sessions.
- Capture human feedback messages and AI review findings in `feedback.jsonl` with attribution, timestamp, target, category, severity, and disposition.
- Record run creation and every stage transition in `run-events.jsonl`, including stage loops.
- Write run event records before any path can prune or demote the run from `runs.json`.
- Redact captured message and feedback text with the shared secret-redaction implementation.
- Make journaling config-gated by `journal.enabled`, defaulting to enabled.
- Add structured logs for journal writer initialization, append counts, disabled state, and write failures.
### Non-goals

- Building the importer from journal JSONL into the future Autocatalyst data model.
- Adding pricing, `usd`, rate tables, cost rollups, or aggregation.
- Adding a query API, dashboard, or user-facing journal UI.
- Changing existing structured logs or OpenTelemetry-style metric emission except to add journal lifecycle logs.
- Replacing `runs.json` as the current run store.
- Guaranteeing token usage for providers that do not expose it.
- Capturing unredacted secrets for perfect replay.
- Moving journal files into `~/.autocatalyst/`; the streams live under the per-repo workspace root's `.autocatalyst/journal/` directory.
## Why

v0 is the tool building the next Autocatalyst. The team wants the full history of how v0 was built to be replayable into the new data model. Today that history is incomplete and sometimes actively destroyed.
Inbound `Request` and `ThreadMessage` content is transient. Outbound replies pass through `postMessage()` and are not persisted. Only `run.origin.message_id` survives in the run record.
Model usage is computed at runner boundaries and logged, but it is not connected to durable run state. Direct runners log token counts and drop them. The Claude agent runner reads terminal usage and logs it. `AgentDrainSummary` reports turns, tool calls, tool results, and elapsed time to agent services, then disappears.
Feedback lacks provenance. Current feedback items and review exchanges do not form a durable record with author, timestamp, target, category, severity, and lifecycle. This makes it hard to reconstruct what a human asked for, what an AI reviewer found, and how the run addressed those items.
`FileRunStore.load()` can drop active runs whose workspace is missing and demote stale runs to `failed`. Because `runs.json` is rewritten later, a run's history can vanish before anything imports it. The journal must survive this pruning and demotion path.
### Personas

- **Enzo: Engineer/operator** — needs to reconstruct run history after workspace cleanup, restarts, failed runs, or importer bugs.
- **Phoebe: Product manager** — wants future Autocatalyst to preserve the product conversation that led to each spec and implementation.
- **Autocatalyst analytics agent** — needs raw messages, sessions, feedback, and run timelines to build cost, quality, and process analytics later.
- **Importer implementer** — needs stable JSONL records with enough raw detail to map v0 history into the new data model without scraping logs.
### Narratives

#### Enzo recovers a pruned active run

An implementation run is active when its workspace directory is accidentally deleted. On restart, `FileRunStore.load()` drops or demotes the run because the workspace path is missing. Before this enhancement, the original conversation, intermediate stages, and model sessions would be gone unless Enzo could find logs.
With the journal enabled, `run-events.jsonl` still contains the run creation, every stage transition written before the prune path, and the load-time prune or demotion event written before `runs.json` is rewritten. `messages.jsonl` contains the original request and replies. `sessions.jsonl` contains each model invocation that reached the runner boundary. Enzo can inspect the journal or feed it to a later importer without depending on the surviving `runs.json` entry.
#### Phoebe reviews product history in the next Autocatalyst

Phoebe asks why a feature was built in a particular way. Future Autocatalyst imports the v0 journal and shows the original Slack request, the follow-up feedback, the spec approval, and the implementation review thread as `Message` and `Feedback` records.
The importer can attach the records to the correct `Conversation`, `Topic`, and `Run` because each journal line carries `conversation_id`, `topic_id`, `run_id`, and `request_id`. The imported history shows what happened, not only the final code and spec.
#### An analytics agent estimates historical cost

An analytics agent wants to compare model usage across v0 runs. The journal stores raw token counts, cache-read/cache-write counts where providers expose them, inference settings, runner type, turn counts, and tool counts. It does not store dollars.
The later importer applies a rate table to the raw token records. If a provider did not expose token counts, such as the OpenAI agent SDK path, the journal records `tokens: null`. The importer treats unknown cost as unknown, not zero.
## User stories

- As Enzo, I can inspect `.autocatalyst/journal/run-events.jsonl` after a `runs.json` prune or demotion and reconstruct the run timeline.
- As Enzo, I can inspect `messages.jsonl` and see every run-associated inbound request, follow-up, and outbound Autocatalyst reply with secrets redacted.
- As Enzo, I can disable journaling with `journal.enabled: false` and verify no journal streams are written.
- As Phoebe, I can later import v0 conversations and see the human messages that shaped a spec and implementation.
- As Phoebe, I can later distinguish human feedback from AI review findings because each feedback record has an author principal and source target.
- As an analytics agent, I can read one `sessions.jsonl` record per model invocation and calculate historical cost from raw tokens later.
- As an analytics agent, I can tell the difference between zero tokens and unknown token usage because unsupported providers write `tokens: null`.
- As an importer implementer, I can map `conversation_id`, `topic_id`, `run_id`, and `request_id`, then reconstruct per-run session order from `sessions.jsonl` file order without relying on wall-clock ordering alone.
- As an operator, I can trust journal write failures to be visible in logs but non-fatal to the active run.
## Design changes

This is a backend capture enhancement. There is no new human-facing UI.
### Journal location

The runtime writes streams under the same per-repo `.autocatalyst/` root used by `FileRunStore`:
```plain text
/.autocatalyst/
  runs.json
  journal/
    messages.jsonl
    sessions.jsonl
    feedback.jsonl
    run-events.jsonl
```
`workspace_root` is the configured repository workspace root passed to runtime composition. The journal is not stored inside each per-run cloned workspace. It must survive per-run workspace deletion.
### Stream format

Each stream is line-delimited JSON. Each line is one complete record with a process-local stream sequence field and a writer boot identifier. Implementations never rewrite or compact a stream.
`seq` is not durable across process restarts. A file-backed writer generates a `writer_id` when it initializes and starts `seq` at `1` for each stream within that writer process. After a restart, the next writer may append records with a new `writer_id` and `seq: 1` to an existing stream. Importers must use JSONL file order as the primary stream order and use `(writer_id, seq)` only to order records produced by the same writer instance. Cross-process or cross-restart global sequence ordering is not required for v0.
For `sessions.jsonl`, file append order is also the canonical per-run session order. A process restart can resume an existing run whose `runs.json` entry survived, and v0 writers do not scan existing journal files or persist a per-run counter. Therefore `session_seq` is a best-effort convenience field that is monotonic only while a writer process has an in-memory counter for that run. Importers that need deterministic within-run ordering must filter `sessions.jsonl` to the target `run_id` in file order; they must not use `session_seq` or `ts_start` as the primary order key across restarts.
Writers append one UTF-8 line ending in `\n`. If the process crashes while writing, the only expected damage is a torn final line. The future importer must tolerate a trailing partial line.
### Identity mapping

The journal uses explicit IDs so import does not rely on channel-specific fields.
- `conversation_id` comes from `run.conversation`, serialized as a stable channel-independent conversation reference.
- `topic_id` is the run ID for v0 because v0 increments `attempt` in place instead of starting a new run for each retry.
- `run_id` is `run.id`.
- `request_id` is `run.request_id`.
- `origin_message_id` is the inbound or outbound message's channel message ref when available.
The existing-issue and future intent-upgrade flows may create a new run that belongs to the same human topic. The importer can later coalesce those runs into one `Topic` when it sees shared issue references or explicit topic metadata. This enhancement records enough raw identifiers to make that possible, but it does not implement coalescing.
### Configuration

Add a top-level config block:
```yaml
journal:
  enabled: true
```
Rules:
- Missing `journal` means journaling is enabled.
- `journal.enabled: true` writes all configured streams.
- `journal.enabled: false` creates no writer, writes no streams, and preserves existing behavior.
- Invalid non-boolean `journal.enabled` fails config validation with a clear error.
This is a deliberate journal-scoped exception to the no-content-at-info-log rule. The journal is durable capture, not routine logs. Captured free text must be redacted before it reaches disk.
### Message capture

`messages.jsonl` captures inbound and outbound messages that can be associated with a run. Unrouteable inbound messages that cannot be tied to a run are out of scope for this journal. Known-run inbound messages whose intent classification fails are still captured with `intent: null` and `classification_status: "failed"`.
Inbound hooks:
- `new_request` after run creation and after Stage 1 classification succeeds or defaults.
- `thread_message` after the orchestrator identifies the run. If classification succeeds, include the raw v0 intent. If classification fails after the run is known, write the message with `intent: null` and `classification_status: "failed"`.
- Unknown-thread or otherwise unrouteable inbound messages are not journaled because the v0 journal requires run context.
Outbound hook:
- Wrap `OrchestratorImpl.postMessage()` so every successful outbound reply writes one record through a single choke point.
- If the human-interface adapter returns a message reference, include it as `origin_message_id`. If it does not, write `origin_message_id: null`.
- Do not instrument every call site individually.
`messages.jsonl` record shape:
```json
{
  "seq": 1,
  "writer_id": "journal-writer-uuid",
  "ts": "2026-06-07T12:00:00.000Z",
  "conversation_id": "slack:C123:1717600000.000",
  "topic_id": "run-uuid",
  "run_id": "run-uuid",
  "request_id": "request-001",
  "direction": "in",
  "author_principal": "slack:U123",
  "content": "please work on issue 192",
  "intent": "work_on_issue",
  "classification_status": "classified",
  "origin_message_id": "slack:C123:1717600000.000:1717600000.000"
}
```
Field rules:
- `seq` is monotonic per stream only within one writer process identified by `writer_id`.
- `writer_id` identifies the writer process boot that assigned `seq`.
- `ts` uses `received_at` for inbound messages and current time for outbound messages.
- `direction` is `in` or `out`.
- `author_principal` is the inbound author for human messages and a service principal such as `autocatalyst` for outbound replies.
- `content` is redacted before write.
- `intent` stores the raw v0 `Intent` when available. For outbound messages and classification failures with no classified intent, use `null`.
- `classification_status` is `classified`, `defaulted`, `failed`, or `not_applicable`. Outbound messages use `not_applicable`.
### Session capture

`sessions.jsonl` captures one record per model invocation associated with a run. The record must be emitted at the runner boundary, agent-service boundary, or orchestrator direct-call boundary where the resolved route, profile, timing, outcome, and usage are all visible.
Record shape:
```json
{
  "seq": 1,
  "writer_id": "journal-writer-uuid",
  "session_seq": 1,
  "ts_start": "2026-06-07T12:00:00.000Z",
  "ts_end": "2026-06-07T12:00:09.200Z",
  "conversation_id": "slack:C123:1717600000.000",
  "topic_id": "run-uuid",
  "run_id": "run-uuid",
  "request_id": "request-001",
  "phase": "speccing",
  "step": "artifact.create",
  "role": null,
  "round": 1,
  "gate": null,
  "model": { "provider": "anthropic", "name": "claude-sonnet-4-6" },
  "inference": { "effort": "medium", "thinking": { "type": "enabled", "budget_tokens": 8000 } },
  "tokens": { "input": 1000, "output": 200, "cache_read": 50, "cache_write": 25 },
  "assistant_turns": 3,
  "tool_calls": 4,
  "tool_results": 4,
  "outcome": "ok",
  "runner": "anthropic_agent"
}
```
Field rules:
- `session_seq` is a best-effort convenience counter. It is monotonic per run only within one writer process and is ordered by capture, not wall-clock time. It may reset or collide after a process restart; importers must use `sessions.jsonl` append order, filtered to the run, as the canonical per-run order.
- `conversation_id` and `topic_id` use the same identity mapping as message and run-event records.
- `phase` is the active run stage at invocation time.
- `step` is `route.task`, such as `intent.classify`, `artifact.create`, `spec.review`, `implementation.plan`, `implementation.run`, or `implementation.review.initial`.
- `role` is `null` until the convergence role work lands. Later values may include `proposer`, `critic`, `implementer`, `reviewer`, `author`, and `planner`.
- `round` is `1` for non-loop work until convergence rounds are available.
- `gate` is `null` until layered convergence lands. Later values may include `layout`, `public_api`, `private_api`, and `build`.
- `model.provider` comes from the resolved profile provider. `model.name` comes from the resolved profile model.
- `inference.effort` and `inference.thinking` come from the resolved profile and may be `null` if not configured.
- `tokens` is normalized raw counts or `null` if unavailable.
- `assistant_turns`, `tool_calls`, and `tool_results` are `null` for direct calls.
- `outcome` is `ok`, `failed`, or `incomplete` as appropriate for the runner result.
- `runner` identifies the runner implementation: `anthropic_direct`, `openai_direct`, `anthropic_agent`, or `openai_agent`.
Ordering rule:
- Within a run, `sessions.jsonl` file order is the canonical order for replay and convergence analysis, including future within-round role order such as proposer before critic. `ts_start` is observability data and is not a reliable ordering key. `session_seq` helps humans inspect records from one process boot but is not durable enough to drive import ordering.
Token normalization rules:
- Anthropic direct maps `usage.input_tokens` and `usage.output_tokens` to `input` and `output`.
- Anthropic direct and Claude Agent SDK also map cache fields when exposed: `cache_read_input_tokens` to `cache_read`, and `cache_creation_input_tokens` to `cache_write`.
- OpenAI direct maps `usage.prompt_tokens` to `input` and `usage.completion_tokens` to `output`.
- OpenAI direct maps prompt-cache details to `cache_read` when the response exposes cached prompt token data.
- OpenAI Agent SDK records `tokens: null` unless provider event data later exposes a reliable token breakdown.
- Missing usage means `tokens: null`, never a zero-filled object.
- The journal stores raw token counts only. It never stores dollars.
### Feedback capture

`feedback.jsonl` captures both human-authored feedback and AI-authored review findings.
Record shape:
```json
{
  "seq": 1,
  "writer_id": "journal-writer-uuid",
  "id": "feedback-uuid-or-source-id",
  "ts_created": "2026-06-07T12:03:00.000Z",
  "conversation_id": "slack:C123:1717600000.000",
  "topic_id": "run-uuid",
  "run_id": "run-uuid",
  "request_id": "request-001",
  "target": "artifact",
  "gate": null,
  "author_principal": "slack:U123",
  "text": "Please add a config flag.",
  "anchor": null,
  "severity": "info",
  "category": "human_feedback",
  "disposition": "open",
  "thread": []
}
```
Sources:
- Human `thread_message` events classified as feedback, approval with comments, implementation feedback, or implementation input.
- Artifact publisher comments and anchors when those are available through `FeedbackSource` or `ArtifactComment`.
- AI review exchanges at the moment the implementation review coordinator appends each exchange to `run.review_exchanges`.
- Future `gate_exchanges` if layered convergence work adds that field.
AI findings must be captured exactly once. The preferred hook is the append point where the coordinator adds an exchange or finding to `run.review_exchanges`, because that hook sees only new source data. If an implementation instead observes `run.review_exchanges` from a transition or persistence hook that can run repeatedly, the feedback writer must dedupe on the stable finding/exchange `id` before appending to `feedback.jsonl`. Importer-side dedupe is allowed as a safety net but is not the primary design.
Field rules:
- `conversation_id` and `topic_id` use the same identity mapping as message and run-event records.
- `id` is stable when source data has an ID. Otherwise generate a deterministic ID from stream source, run ID, source timestamp, and text hash.
- `target` is `artifact` for spec/triage/chore-plan feedback and `implementation` for implementation review feedback.
- `gate` is `null` until layered gates exist.
- `author_principal` is the human author for inbound feedback and the reviewer model profile principal for AI findings.
- `text` is redacted before write.
- `anchor` stores comment anchor data when available.
- `severity` uses source severity for AI findings and defaults to `info` for human feedback unless a source field says otherwise.
- `category` uses source category for AI findings and `human_feedback` for human messages.
- `disposition` maps lifecycle states to `open`, `addressed`, `resolved`, or `wont_fix`.
- `thread` stores redacted follow-up comments when available.
### Run event capture

`run-events.jsonl` captures run creation, every stage transition, and load-time prune or stale demotion decisions made by `FileRunStore.load()`.
Record shape:
```json
{
  "seq": 1,
  "writer_id": "journal-writer-uuid",
  "event_type": "transition",
  "ts": "2026-06-07T12:00:00.000Z",
  "run_id": "run-uuid",
  "request_id": "request-001",
  "conversation_id": "slack:C123:1717600000.000",
  "topic_id": "run-uuid",
  "from_stage": "intake",
  "to_stage": "speccing",
  "attempt": 0,
  "intent": "idea",
  "workspace_path": "/workspace-root/request-001",
  "branch": "spec/request-001",
  "artifact_ref": "context-human/specs/feature-example.md",
  "pr_url": null,
  "issue": 192
}
```
Rules:
- Run creation writes a record with `event_type: "created"`, `from_stage: null`, and `to_stage: "intake"`.
- Every call to `transition()` writes a record with `event_type: "transition"` before persisting the mutated `runs.json` state.
- `FileRunStore.load()` writes a best-effort run event before it rewrites `runs.json` for any active run it is about to drop because the workspace is missing or demote to `failed` because the run is stale.
- Prune/drop events use `from_stage` as the stage loaded from `runs.json`, `to_stage: null`, and `event_type: "pruned"`.
- Stale demotion events use `from_stage` as the stage loaded from `runs.json`, `to_stage: "failed"`, and `event_type: "demoted"`.
- Self-transitions are recorded because they can represent useful lifecycle loops.
- The stream must contain enough data to reconstruct `RunStep` occurrences by reading `to_stage` values in order.
- Write the creation event as soon as `createRun()` constructs the run, before later classification or workspace allocation can fail.
### Redaction

Captured free text must pass through the shared secret redactor before disk write. This includes:
- message `content`;
- feedback `text`;
- feedback thread text;
- write-failure error strings if they may include captured content.
The existing redaction behavior in `implementation-feedback-page.ts` should move to a shared utility, then expand as needed to cover known token forms from the telemetry spec: `sk-...`, `github_pat_...`, `gho_...`, `ghs_...`, Slack `xapp-...`, bearer tokens, Anthropic custom header API keys, generic API-key strings, and password-like values.
Redaction is not optional when journaling is enabled. If redaction fails unexpectedly, the writer logs a redacted failure and skips the record instead of writing unredacted text.
### Failure modes

- Journal writer initialization failure disables journal writes for that process and logs `journal.init_failed`.
- Per-record append failure logs `journal.append_failed` with the stream name and redacted reason, then continues the run.
- A malformed record produced by a caller logs `journal.record_invalid` and skips only that record.
- Concurrent runs serialize writes per stream through a shared writer instance.
- Missing token data writes `tokens: null`.
- A torn final JSONL line after process crash is acceptable; importer tolerance is deferred to the importer task.
## Technical changes

### Affected files

Expected implementation touch points:
- `src/types/config.ts` — add `journal?: { enabled?: boolean }` to `WorkflowConfig`.
- `src/core/config.ts` — validate `journal.enabled` when present.
- `src/core/config-normalizer.ts` — expose `journal_enabled`, defaulting to `true`.
- `src/types/journal.ts` — define journal record types, normalized token usage, stream names, writer interface, and no-op writer.
- `src/core/journal/redaction.ts` — provide shared `redactSecrets()` and tests.
- `src/core/journal/jsonl-writer.ts` — implement append-only JSONL writing with per-stream sequencing and serialized appends.
- `src/core/journal/run-journal.ts` — implement high-level capture helpers for messages, sessions, feedback, and run events.
- `src/core/orchestrator.ts` — capture inbound messages, outbound messages, run creation, stage transitions, and orchestrator-owned direct model calls such as `intent.classify` and `pr.title_generate` when run context exists.
- `src/core/run-store.ts` or the current `FileRunStore` implementation file — accept a journal dependency during load and capture prune/drop or stale demotion events before rewriting `runs.json`.
- `src/core/ai/agent-services.ts` — emit agent-session records with route, profile, timing, drain summary, outcome, and telemetry IDs.
- `src/types/ai.ts` — add normalized usage fields to `DirectModelRunResult`, extend `AgentDrainSummary` with terminal usage, and carry session/capture metadata where needed.
- `src/adapters/anthropic/direct-model-runner.ts` — normalize Anthropic direct usage including cache fields when present.
- `src/adapters/openai/direct-model-runner.ts` — normalize OpenAI direct usage including prompt-cache fields when present.
- `src/adapters/anthropic/claude-agent-sdk-agent-runner.ts` — expose terminal usage through normalized events or `AgentDrainSummary`.
- `src/adapters/openai/agent-sdk-agent-runner.ts` — emit session metadata with `tokens: null` and no false zero counts.
- `src/adapters/runtime-composition.ts` — construct the journal writer from normalized config and pass it to orchestrator and AI services.
- `src/adapters/notion/implementation-feedback-page.ts` — import the shared redactor instead of keeping a local copy.
- `tests/core/journal/*.test.ts` — cover writer behavior, sequencing, redaction, config gating, and failure handling.
- `tests/core/orchestrator.test.ts` — cover message and run-event capture.
- `tests/core/ai/agent-services.test.ts` — cover session capture and summary usage propagation.
- `tests/adapters/*/*runner*.test.ts` — cover provider-specific token normalization.
- `tests/core/run-store.test.ts` — cover journal survival and load-time `pruned`/`demoted` event emission through prune/demote cycles.
### 1. Journal type model

Create shared types with explicit stream names:
```typescript
export type JournalStream = 'messages' | 'sessions' | 'feedback' | 'run-events';

export interface NormalizedTokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface JournalWriter {
  append(stream: JournalStream, record: unknown): Promise;
  appendSync?(stream: JournalStream, record: unknown): void;
  close?(): Promise;
}
```
`RunJournal` should own domain-specific methods such as `captureInboundMessage()`, `captureOutboundMessage()`, `captureSession()`, `captureFeedback()`, and `captureRunEvent()`. Callers should not hand-build JSON strings.
Provide a no-op writer for disabled journaling so call sites do not branch repeatedly.
### 2. JSONL writer

The writer must:
- create `.autocatalyst/journal/` lazily or during initialization;
- generate a `writer_id` for the process boot and include it on every record;
- keep a monotonic `seq` counter per stream for that writer process;
- serialize concurrent appends per stream with an internal promise queue;
- append one JSON object plus `\n` per record;
- call a flush-equivalent operation where practical after append;
- catch and log I/O errors without throwing to callers;
- log `journal.writer_started` with `journal_dir` and enabled streams;
- log `journal.appended` at debug level with `stream`, `seq`, and `record_type` if available;
- log aggregate append counts on `close()` if a close path exists.
A single process-local writer is enough for v0. If two Node processes point at the same workspace root, the implementation should rely on OS append semantics and still avoid partial in-process interleaving. Cross-process global sequence ordering is not required.
The writer must not scan existing stream tails to initialize `seq`. Restarted processes can append duplicate numeric `seq` values as long as `writer_id` differs; importer code must not treat `seq` alone as globally unique or globally monotonic.
### 3. Config and runtime wiring

Runtime composition should construct one journal object:
- If `normalizedConfig.journal_enabled` is false, pass a no-op journal.
- If true, pass a file-backed journal rooted at `/.autocatalyst/journal`.
- Construct the journal before loading or normalizing `runs.json` so `FileRunStore.load()` can capture prune/drop and stale demotion events before it rewrites `runs.json`.
The same journal instance must be available to:
- the run store for load-time prune/drop and stale demotion capture;
- the orchestrator for message and run-event capture;
- agent services for session capture;
- feedback/review coordinators or handlers for feedback capture.
The config default is on because the goal is complete history. Tests must prove missing config enables the writer and explicit `false` disables it.
### 4. Orchestrator hooks

Add journal calls without changing control flow:
- `createRun(request)` captures a `run-events` creation record after the run object is created and before it is persisted.
- The `new_request` path captures the inbound message after classification succeeds. If no classifier is configured, capture the default intent used by the path.
- The `thread_message` path captures the inbound message after the orchestrator identifies the run. If classification succeeds, include the raw v0 intent. If classification fails after run identification, capture the message with `intent: null` and `classification_status: "failed"`; do not capture a misleading intent. If the thread cannot be associated with a run, do not write a message record.
- `transition(run, stage)` captures a `run-events` stage record before `_persistRuns()`.
- Private `postMessage(conversation, text)` captures outbound content after the adapter call succeeds. If the adapter call fails, do not record a delivered outbound message.
All hooks are best-effort. A journal rejection must not change current handler behavior.
### 4a. Run-store prune and demotion hooks

`FileRunStore.load()` is the path that can remove or demote runs before the orchestrator sees them. Runtime composition must pass the already-constructed journal into the run store before `load()` executes.
During `load()`, before writing a normalized `runs.json` that drops an active run with a missing workspace, append a `run-events` record with `event_type: "pruned"`, `from_stage` set to the loaded stage, and `to_stage: null`. Before writing a stale active run back as `failed`, append a `run-events` record with `event_type: "demoted"`, `from_stage` set to the loaded stage, and `to_stage: "failed"`.
These load-time records are best-effort and must not prevent current run-store recovery behavior. If journaling is disabled or initialization failed, `FileRunStore.load()` continues exactly as it does today.
### 5. Session emission boundary

Use the agent-service boundary for run-associated agent sessions because it knows the resolved route, profile, run ID, request ID, stage/phase, and drain summary. Add an `onSession` or `journal` emission hook to the same telemetry object that currently carries `run_id`, `request_id`, and `onAgentRequest`.
Direct model sessions need equivalent context. For direct calls used by run-owned services, the caller should pass route, run ID, request ID, and phase. If a direct model call is not associated with a run, it can be omitted from this issue or captured with `run_id: null` only if the type model explicitly allows it. The acceptance criteria focus on one session record per model invocation associated with a run.
The orchestrator has direct model call sites that do not naturally pass through agent services. `intent.classify` and `pr.title_generate` are explicitly in scope when the orchestrator has a run/request context for the call. They should emit `anthropic_direct` or `openai_direct` session records through the same direct-session helper used by other run-owned services. If an `intent.classify` call is truly pre-run and no run ID exists yet, it may be omitted rather than captured with a misleading synthetic run ID.
Agent-service emission rules:
1. Record `ts_start` before invoking the runner.
2. Drain the runner and collect `AgentDrainSummary`.
3. Capture terminal usage if the runner provides it.
4. Record `ts_end` and `outcome` in `finally`.
5. Append the session record in best-effort mode.
6. Re-throw original runner or drain errors after the journal append attempt so current error handling stays intact.
### 6. Usage propagation

Extend `DirectModelRunResult`:
```typescript
export interface DirectModelRunResult {
  text: string;
  raw?: unknown;
  usage?: NormalizedTokenUsage | null;
  runner?: 'anthropic_direct' | 'openai_direct';
}
```
Extend `AgentDrainSummary`:
```typescript
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
```
The Claude Agent SDK runner can surface usage on the normalized terminal result event, and `drainAgentRunner()` can copy it into `terminal_usage`. The OpenAI Agent SDK runner should not invent usage. It reports `terminal_usage: null` or omits the field, and the session record writes `tokens: null`.
### 7. Feedback capture

Start with three concrete capture paths:
1. Human `thread_message` events in `reviewing_spec`, `awaiting_planning_input`, `awaiting_impl_input`, `reviewing_implementation`, and `pr_open` when the classified intent is feedback, approval, implementation feedback, or question/input tied to the run.
2. Artifact comments read through `FeedbackSource` during spec revision when comments have IDs, anchors, and text.
3. AI review exchanges appended to `run.review_exchanges` by the implementation review coordinator.
The feedback capture layer should be tolerant of partial source data. For example, a plain Slack feedback message has no anchor and no structured severity, so it writes `anchor: null` and `severity: "info"`.
AI review exchange capture should happen at append time for each newly created exchange/finding. Re-reading the full `run.review_exchanges` array during repeated transition hooks is not acceptable unless the feedback writer dedupes by stable finding/exchange `id` before writing, because otherwise the same AI finding can be emitted multiple times.
Feedback capture is in scope for this enhancement and is required for acceptance. If implementation needs sequencing, land feedback capture after message, session, and run-event capture on the same branch; do not mark the enhancement complete while `feedback.jsonl` capture is only a placeholder or follow-up.
### 8. Telemetry and logs

Add structured logs per `AGENTS.md` and `context-agent/standards/logging.md`:
- `journal.disabled` when config disables journaling.
- `journal.writer_started` with `journal_dir`.
- `journal.appended` at debug level with `stream`, `seq`, and `duration_ms`.
- `journal.append_failed` at warn level with `stream`, `seq` if assigned, and redacted `error`.
- `journal.record_invalid` at warn level when validation rejects a caller-provided record.
- `journal.closed` with per-stream append counts.
These logs must not include unredacted message or feedback content.
### Testing plan

#### Unit tests

- Config validation accepts missing `journal`, accepts boolean `journal.enabled`, defaults missing value to true, and rejects non-boolean values.
- No-op journal accepts append calls and writes no files.
- JSONL writer creates `.autocatalyst/journal/`, appends valid JSON lines, includes `writer_id`, increments `seq` per stream within the writer process, and preserves existing lines.
- Concurrent appends to the same stream produce complete, parseable lines with monotonic process-local sequence values for the same `writer_id`.
- Restarting a writer against existing streams starts new process-local `seq` counters with a new `writer_id`; tests assert importers cannot rely on `seq` alone for global ordering.
- Restarting the process during a persisted run can reset `session_seq`; tests document that importers must order that run's sessions by `sessions.jsonl` file order, not by `session_seq` or `ts_start`.
- Writer append failure logs `journal.append_failed` and does not throw to the caller.
- Shared `redactSecrets()` redacts planted API keys and tokens in message and feedback text.
- `RunJournal` serializes `ConversationRef`, `MessageRef`, and model profile fields into stable journal IDs.
#### Orchestrator tests

- `new_request` with classified intent writes one inbound `messages.jsonl` record and one creation `run-events.jsonl` record.
- `thread_message` for a known run writes one inbound message record with the classified intent.
- A successful outbound `postMessage()` writes one outbound message record from the private choke point.
- A failed outbound `postMessage()` does not record a delivered outbound message and preserves current error behavior.
- Every `transition()` writes a run-event record before run persistence.
- Stage loops and self-transitions are represented in `run-events.jsonl`.
- Journal write rejection does not fail the run or change its final stage.
- `FileRunStore.load()` writes `pruned` and `demoted` run events before rewriting `runs.json`, and disabled/no-op journaling preserves current load behavior.
#### Runner and session tests

- Anthropic direct returns normalized usage with input/output and cache fields when present.
- OpenAI direct returns normalized usage with prompt/completion and prompt-cache fields when present.
- Claude Agent SDK terminal usage reaches `AgentDrainSummary.terminal_usage` and then `sessions.jsonl`.
- OpenAI Agent SDK produces a session record with `tokens: null`.
- Direct sessions have `assistant_turns`, `tool_calls`, and `tool_results` set to `null`.
- Orchestrator-owned direct calls with run context, including `intent.classify` and `pr.title_generate`, produce direct session records instead of being silently missed.
- Agent sessions include `assistant_turns`, `tool_calls`, `tool_results`, elapsed timing, route task, provider, model, effort, and thinking.
- A failed runner emits a failed session record when enough context exists and then rethrows the original error.
#### Feedback tests

- Human feedback messages write feedback records with human `author_principal`, `ts_created`, redacted text, target, and `disposition: "open"`.
- Artifact comments write feedback records with stable IDs and anchors.
- AI review exchanges write feedback records once per newly appended finding/exchange with reviewer profile as `author_principal`, finding severity/category, and addressed disposition when the implementer responded.
- Repeated transition or persistence hooks do not duplicate AI review feedback rows; if capture observes accumulated `run.review_exchanges`, it dedupes by stable finding/exchange `id` before append.
- Redaction applies to feedback text and nested thread text.
#### Persistence and recovery tests

- Create an active run, write messages, sessions, feedback, and run events, delete its workspace, then call `FileRunStore.load()`. Assert the run may be dropped or demoted in `runs.json`, the journal lines written before load remain unchanged and parseable, and a best-effort `pruned` or `demoted` run event is appended before the rewrite when journaling is enabled.
- Disable journaling and repeat a simple run. Assert no `.autocatalyst/journal/` streams are created and existing behavior is unchanged.
### Acceptance criteria

- [ ] Four append-only streams exist under per-repo `.autocatalyst/journal/`: `messages.jsonl`, `sessions.jsonl`, `feedback.jsonl`, and `run-events.jsonl`.
- [ ] All run-associated stream schemas carry `conversation_id`, `topic_id`, `run_id`, and `request_id` when those identifiers exist in run context.
- [ ] Journal streams survive a `FileRunStore.load()` prune or stale-stage demotion cycle unchanged.
- [ ] `run-events.jsonl` records enabled load-time prune/drop and stale demotion events before `FileRunStore.load()` rewrites `runs.json`.
- [ ] Run-associated inbound `new_request` and `thread_message` payloads are captured with redacted content and classified intent when available; known-run classification failures write `intent: null` with `classification_status: "failed"`, while unknown-thread and unrouteable messages are explicitly out of scope.
- [ ] Every successful outbound `postMessage()` reply is captured through one shared outbound hook.
- [ ] One `sessions.jsonl` record is written for every run-associated model invocation across Anthropic direct, OpenAI direct, Claude Agent SDK, and OpenAI Agent SDK runners, including `conversation_id` and `topic_id` when the run context provides them.
- [ ] Orchestrator-owned direct model calls with run context, including `intent.classify` and `pr.title_generate`, are captured as direct sessions or are explicitly omitted only when no run ID exists yet.
- [ ] Within-run session replay order is defined by `sessions.jsonl` file order filtered to `run_id`; `session_seq` is documented and tested as best-effort across process restarts.
- [ ] Direct and Claude-agent paths record normalized raw token counts, including cache-read/cache-write fields where providers expose them.
- [ ] OpenAI Agent SDK path records `tokens: null` unless reliable token usage is available.
- [ ] `inference.effort` and `inference.thinking` are recorded per session from the resolved profile.
- [ ] Feedback from human messages and AI review exchanges is captured with `conversation_id`, `topic_id`, attribution, `ts_created`, target, severity/category when available, redacted text, and lifecycle disposition.
- [ ] AI review findings are captured once at source append time or deduped by stable finding/exchange `id` before writing to `feedback.jsonl`.
- [ ] `run-events.jsonl` records run creation and every stage transition before run persistence can rewrite `runs.json`.
- [ ] Secret redaction is verified for message content, feedback content, and nested feedback thread text.
- [ ] Journal write failures are logged and never fail a run.
- [ ] `journal.enabled` defaults to `true`; when set to `false`, no journal streams are written and runtime behavior matches today.
- [ ] The journal stores raw tokens only and never stores `usd` or any priced cost field.
### Risks and mitigations

- **Risk: Captured content may include secrets.** Mitigation: route all free text through a shared redactor, expand token patterns, and skip the record if redaction fails.
- **Risk: Journal I/O adds latency or fails on disk errors.** Mitigation: keep writes best-effort, serialized, and non-fatal; log failures with enough context to diagnose.
- **Risk: Provider token fields drift.** Mitigation: normalize only known fields, keep raw response in existing runner result where needed, and use `tokens: null` instead of false zeroes.
- **Risk: Session context is incomplete for direct calls.** Mitigation: capture run-associated direct calls first and explicitly allow non-run direct calls to be out of scope unless a caller can provide run context.
- **Risk: Feedback capture expands the issue too much.** Mitigation: sequence feedback implementation after message, session, and run-event capture if needed, but keep it in this enhancement and do not accept the work as complete without `feedback.jsonl`.
- **Risk: Sequence numbers are process-local.** Mitigation: importer orders streams by file order. For per-run sessions, importer filters `sessions.jsonl` by `run_id` in file order; `session_seq` is best-effort only and cross-process global ordering is not required for v0.
## Task list

### Story 1 — Add journal configuration and shared types

- [ ] **Task: Add ****`journal.enabled`**** config support**
	- **Description**: Extend `WorkflowConfig`, config validation, and config normalization with `journal.enabled`, defaulting to `true`. Reject non-boolean values with a clear error.
	- **Acceptance criteria**:
		- [ ] Missing `journal` enables journaling.
		- [ ] `journal.enabled: true` enables journaling.
		- [ ] `journal.enabled: false` disables journaling.
		- [ ] Non-boolean `journal.enabled` fails config validation.
	- **Dependencies**: None.
- [ ] **Task: Define journal record and writer types**
	- **Description**: Add `src/types/journal.ts` with stream names, normalized token usage, message/session/feedback/run-event record interfaces, and `JournalWriter`/no-op writer contracts.
	- **Acceptance criteria**:
		- [ ] Types cover all four stream schemas in this spec.
		- [ ] `tokens` can be a normalized object or `null`.
		- [ ] Direct and agent runner names are represented as a closed union.
	- **Dependencies**: `journal.enabled` config support.
### Story 2 — Build the safe append-only writer and redactor

- [ ] **Task: Move and expand secret redaction**
	- **Description**: Move the local `redactSecrets()` helper from `implementation-feedback-page.ts` into a shared journal-safe redaction utility. Expand patterns for common GitHub, Slack, bearer, Anthropic custom header, API-key, and password-like forms. Update existing imports.
	- **Acceptance criteria**:
		- [ ] Existing implementation feedback redaction behavior is preserved.
		- [ ] Tests cover planted secrets in message and feedback strings.
		- [ ] Redaction utility has no dependency on Notion-specific code.
	- **Dependencies**: Journal types.
- [ ] **Task: Implement the JSONL journal writer**
	- **Description**: Create a writer that appends one JSON record per line under `.autocatalyst/journal/`, assigns process-local stream sequence numbers, serializes in-process appends per stream, and logs failures without throwing.
	- **Acceptance criteria**:
		- [ ] Writer creates the journal directory.
		- [ ] Appended lines are valid JSON and end in `\n`.
		- [ ] Every appended record includes the writer process `writer_id`.
		- [ ] Sequence numbers are monotonic per stream within the process and are not initialized by scanning existing stream tails.
		- [ ] A restarted writer may reuse numeric `seq` values with a new `writer_id`; tests document that `seq` alone is not globally unique.
		- [ ] Concurrent appends do not interleave partial JSON lines.
		- [ ] Write failures log `journal.append_failed` and are non-fatal.
	- **Dependencies**: Shared redactor and journal types.
- [ ] **Task: Add the high-level ****`RunJournal`**** facade**
	- **Description**: Add helper methods that accept domain objects and write stream records. Centralize ID serialization, redaction, default values, and error swallowing in this facade.
	- **Acceptance criteria**:
		- [ ] Callers can capture messages, sessions, feedback, and run events without hand-building JSON strings.
		- [ ] Free-text fields are redacted before append.
		- [ ] Any `session_seq` assignment is in-memory and process-local; the facade does not scan existing `sessions.jsonl` to resume counters.
		- [ ] Invalid records are logged and skipped.
	- **Dependencies**: JSONL writer.
### Story 3 — Wire run events and message capture

- [ ] **Task: Construct and inject the journal in runtime composition**
	- **Description**: Build a file-backed journal when enabled and a no-op journal when disabled. Pass it to orchestrator dependencies and AI services.
	- **Acceptance criteria**:
		- [ ] Enabled runtime logs `journal.writer_started`.
		- [ ] Disabled runtime logs `journal.disabled` and writes no stream files.
		- [ ] The journal is constructed before `FileRunStore.load()` and passed to the run store.
		- [ ] Tests can inject a fake journal.
	- **Dependencies**: `RunJournal` facade.
- [ ] **Task: Capture run creation and transitions**
	- **Description**: Update `createRun()`, `transition()`, and `FileRunStore.load()` to append `run-events` records. Ensure transition records are written before `_persistRuns()` and load-time prune/demotion records are written before `runs.json` is rewritten.
	- **Acceptance criteria**:
		- [ ] Creation records use `from_stage: null`, `to_stage: "intake"`.
		- [ ] Every transition writes from/to stage, attempt, intent, workspace path, branch, artifact ref, PR URL, and issue.
		- [ ] `FileRunStore.load()` appends `event_type: "pruned"` before dropping a run whose workspace is missing.
		- [ ] `FileRunStore.load()` appends `event_type: "demoted"` before writing a stale active run as `failed`.
		- [ ] Journal failures do not change run stage or persistence behavior.
	- **Dependencies**: Runtime journal injection.
- [ ] **Task: Capture inbound and outbound messages**
	- **Description**: Add inbound capture for `new_request` and `thread_message` after classification context is known. Wrap private `postMessage()` for outbound capture after successful delivery.
	- **Acceptance criteria**:
		- [ ] `new_request` records include raw v0 intent.
		- [ ] `thread_message` records include raw v0 intent when classification succeeds and `intent: null` with `classification_status: "failed"` when classification fails after the run is known.
		- [ ] Outbound records include service principal and redacted text.
		- [ ] Failed outbound posts do not record a delivered message.
	- **Dependencies**: Runtime journal injection.
### Story 4 — Capture model sessions and token usage

- [ ] **Task: Normalize direct model usage**
	- **Description**: Extend `DirectModelRunResult` and update Anthropic/OpenAI direct runners to return normalized raw usage. Include cache fields where the provider response exposes them.
	- **Acceptance criteria**:
		- [ ] Anthropic direct maps input/output and cache fields.
		- [ ] OpenAI direct maps prompt/completion and prompt-cache fields.
		- [ ] Missing usage returns `usage: null` rather than zeroes.
	- **Dependencies**: Journal types.
- [ ] **Task: Surface agent terminal usage through drain summaries**
	- **Description**: Extend normalized agent terminal events and `AgentDrainSummary` so Claude Agent SDK usage reaches agent services. Preserve OpenAI Agent SDK `tokens: null` behavior.
	- **Acceptance criteria**:
		- [ ] Claude Agent SDK terminal usage appears in `AgentDrainSummary.terminal_usage`.
		- [ ] OpenAI Agent SDK does not invent token counts.
		- [ ] Existing drain telemetry still logs turns, tool calls, tool results, and diagnostics.
	- **Dependencies**: Journal types.
- [ ] **Task: Emit session records from the model invocation boundary**
	- **Description**: Add a session emission hook in agent services and direct-model service call sites with route, phase, profile, timing, outcome, usage, and drain summary fields.
	- **Acceptance criteria**:
		- [ ] Every run-associated model invocation writes one `sessions` record.
		- [ ] `session_seq` increments monotonically per run only within one writer process and is documented as best-effort after restarts.
		- [ ] Tests and developer comments state that per-run session replay order comes from `sessions.jsonl` file order filtered to `run_id`, not from `session_seq` or `ts_start`.
		- [ ] Direct sessions have agent turn/tool fields set to `null`.
		- [ ] Orchestrator-owned direct calls with run context, including `intent.classify` and `pr.title_generate`, emit direct session records through the shared direct-session helper.
		- [ ] Agent sessions include turn/tool counts and elapsed timing.
		- [ ] Failed sessions are captured when enough context exists and original errors still propagate.
	- **Dependencies**: Runtime journal injection; normalized usage propagation.
### Story 5 — Capture feedback records

- [ ] **Task: Capture human feedback messages**
	- **Description**: Write `feedback` records for human thread messages that represent spec feedback, implementation feedback, implementation input, approval comments, or PR-stage feedback. Use human author principal and received timestamp.
	- **Acceptance criteria**:
		- [ ] Human feedback records include `conversation_id`, `topic_id`, target, author principal, timestamp, redacted text, and `disposition: "open"`.
		- [ ] Messages without anchors write `anchor: null`.
		- [ ] Journal failures do not affect feedback handling.
	- **Dependencies**: Message capture hooks.
- [ ] **Task: Capture artifact comments and AI review findings**
	- **Description**: Capture structured artifact comments when available and capture AI findings once as each exchange/finding is appended to `run.review_exchanges`. Map reviewer profiles to author principals and response status to disposition.
	- **Acceptance criteria**:
		- [ ] Artifact comments preserve IDs and anchors when present.
		- [ ] AI findings include severity, category, reviewer principal, and redacted text.
		- [ ] Repeated stage transitions do not duplicate AI finding rows in `feedback.jsonl`; append-time capture is used, or writes dedupe by stable finding/exchange `id`.
		- [ ] Addressed/declined responses map to lifecycle disposition.
	- **Dependencies**: Human feedback capture.
### Story 6 — Verify durability, gating, and docs

- [ ] **Task: Add recovery and config-gating tests**
	- **Description**: Add tests that run journal capture, delete a workspace, call `FileRunStore.load()`, and verify journal lines remain. Add disabled-mode tests.
	- **Acceptance criteria**:
		- [ ] Journal lines survive active-run drop/demotion.
		- [ ] Disabled mode writes no stream files.
		- [ ] Existing run-store behavior remains unchanged.
	- **Dependencies**: Run-event, message, session, and feedback capture.
- [ ] **Task: Document provider gaps and importer boundary**
	- **Description**: Add short developer documentation or comments near journal types describing `tokens: null`, raw-token-only storage, append-order session replay, and the deferred importer.
	- **Acceptance criteria**:
		- [ ] Docs state that OpenAI Agent SDK token usage may be unavailable.
		- [ ] Docs state that pricing and importer work are out of scope.
		- [ ] Docs state that `sessions.jsonl` file order filtered by `run_id` is the canonical per-run session order and `session_seq` is best-effort across process restarts.
		- [ ] Docs state that journal write failures are non-fatal.
	- **Dependencies**: Session capture.