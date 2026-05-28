---
created: 2026-05-28
last_updated: 2026-05-28
status: implementing
issue: 187
specced_by: autocatalyst
implemented_by: markdstafford
superseded_by: null
---
# Enhancement: Slack prune command and merge-time workspace auto-prune

## Parent feature

`feature-command-mode.md`
This enhancement extends Autocatalyst's Slack emoji command surface with a destructive operator command, `:ac-prune:`, and extends the PR merge lifecycle with conservative automatic workspace reclamation.
## What

Autocatalyst adds a `:ac-prune:` Slack command that lets operators clean up resources left behind by completed or explicitly selected runs without leaving Slack. Phase 1 supports two manual invocations:

Invocation
Context
Behavior

`:ac-prune: completed`
Slack channel message
Preview all `done` runs associated with the current Slack channel, wait for an exact `Yes` reply in the command thread, then delete each run's workspace directory, delete the associated Slack thread best-effort, and hard-delete the run record from `runs.json`.

`:ac-prune:  [...]`
Slack channel message
Preview the named run or runs, wait for an exact `Yes` reply in the command thread, then delete each selected run's workspace directory, delete the associated Slack thread best-effort, and hard-delete each run record from `runs.json`. Runs in non-terminal stages require `--active` in addition to confirmation.

Autocatalyst also adds `workspace.auto_prune`, a config option under the existing `workspace:` section. It defaults to `true`. When enabled, merge-driven completion deletes only the run workspace after `prManager.mergePR(run.workspace_path, run.pr_url)` succeeds and the run transitions to `done`. Automatic pruning never deletes Slack messages and never removes the run record; it clears `run.workspace_path` after successful deletion so status views do not point at a reclaimed directory.
## Why

Completed runs accumulate two forms of clutter:
- workspace directories on disk, consuming local storage and making workspace roots harder to inspect; and
- Slack run threads, making operational channels noisier over time.
Operators currently have to leave Slack, inspect `runs.json`, manually verify workspace paths, remove directories, and optionally clean up Slack messages by hand. That is slow and error-prone. A guided Slack command gives operators a safer path: preview exactly what will be removed, require explicit confirmation, enforce workspace path containment, and report per-run outcomes.
Automatic workspace pruning addresses the most common low-risk cleanup case. After a PR has been merged from the run workspace and the run is marked `done`, the workspace is no longer needed for normal operation. Removing it by default keeps disk usage bounded while preserving the Slack thread and run record for auditability.
## Personas

- **Enzo: Engineer/operator** — keeps a local Autocatalyst deployment healthy, reclaims disk space, and cleans old run threads without shelling into the workspace root.
- **Phoebe: Product manager** — benefits from a less cluttered Slack channel and can still inspect retained `done` run records after automatic workspace cleanup.
## User stories

- Enzo can post `:ac-prune: completed` in the Autocatalyst Slack channel and see an exact preview of every `done` run that will be removed before anything destructive happens.
- Enzo can reply `Yes` in the preview thread to prune the listed completed runs, then receive a per-run `OK` / `fail` summary.
- Enzo can reply anything other than exact `Yes` to cancel a pending prune without side effects.
- Enzo can post `:ac-prune: ` to prune one failed, done, or otherwise selected historical run by ID.
- Enzo can prune a non-terminal run only by supplying `--active` and then replying `Yes`, preventing accidental deletion of live work.
- Phoebe can still run normal status/list workflows for completed runs whose workspace was automatically reclaimed after merge; the run remains `done` and simply has no workspace path.
- Operators can set `workspace.auto_prune: false` when they want to retain workspaces after merge for manual inspection.
## Goals

- Add the `:ac-prune:` emoji mapping and register a `prune` command handler.
- Support only Phase 1 manual forms: `completed` and explicit ID list with optional `--active`.
- Require a preview and exact `Yes` confirmation for every manual destructive prune.
- Support plain unmentioned confirmation replies in the command thread while a prune confirmation is pending.
- Hard-delete manually pruned runs from `runs.json`; do not add tombstones, soft-delete flags, or `pruned` statuses.
- Bulk `completed` pruning includes only `stage: 'done'`; it does not sweep `failed`, `pr_open`, or active runs.
- Validate every workspace path as a direct child of its configured workspace root before deletion.
- Tolerate missing workspace directories during prune; missing workspaces should not block Slack/thread cleanup or run record deletion.
- Delete Slack threads best-effort and report per-run failures without aborting other runs.
- Add `workspace.auto_prune`, defaulting to `true`, and automatically reclaim only the workspace directory after merge-driven `done` transitions.
- Preserve existing run lifecycle semantics: `done` remains the only completed state, `failed` remains failed, and no new terminal stage is introduced.
## Non-goals

- Bare `:ac-prune:` overview.
- `:ac-prune: all`.
- Orphan thread detection or cleanup.
- Thread-reply `:ac-prune:` that prunes the current run by context.
- Scheduled or time-based pruning.
- Deleting GitHub issues, PRs, remote branches, or any remote repository artifact.
- Archiving workspace contents before deletion.
- Retrying Slack deletion indefinitely or treating Slack deletion failures as fatal.
- Adding new durable state to represent "manually pruned"; the manual command removes the run record entirely.
## UX and interaction design

### Command syntax

Register one command:

Emoji
Command name
Usage

`:ac-prune:`
`prune`
`:ac-prune: completed` or `:ac-prune:  [ ...] [--active]`

`completed` is a reserved mode token. All other non-flag arguments are treated as run IDs and may match either `run.request_id` or `run.id`, following the existing command pattern in `run.status`, `run.cancel`, and `run.logs`.
### Manual prune preview

Before deleting anything, the command replies in the command thread with an exact preview:
```plain text
Prune preview — reply `Yes` in this thread to delete these resources. Anything else cancels.

• run `7b1...` (`request-001`) — stage `done`
  workspace: `/Users/.../.autocatalyst/workspaces/autocatalyst/request-001`
  Slack thread: C123 / 1710000000.000000

This will delete workspace directories, attempt to delete Slack thread messages, and remove the listed run records from runs.json. This cannot be undone.
```
If no runs match, reply with a non-destructive message such as `No completed runs found to prune.` and create no pending confirmation.
### Confirmation

- The preview itself is the confirmation request.
- The operator confirms by replying with exactly `Yes` in the preview thread.
- Any other reply from the confirming user cancels the prune and clears the pending operation.
- Pending confirmations are in-memory only. If Autocatalyst restarts before confirmation, the operation is cancelled; a later `Yes` is ignored.
- To reduce accidental deletion, only the Slack user who invoked `:ac-prune:` can confirm or cancel that pending prune.
- A pending confirmation should expire after a short window, such as 10 minutes. Expiry clears the operation and a later reply is ignored.
Current Slack thread messages without bot mention are ignored by `SlackAdapter`. To satisfy the required plain `Yes` confirmation, the implementation adds a small confirmation registry that lets the Slack adapter emit a command confirmation event for replies in conversations with pending destructive confirmations before applying the normal thread-message mention requirement.
### Manual prune result summary

After confirmation, reply with a per-item summary:
```plain text
Prune complete.

OK:
• `request-001` — workspace deleted, Slack thread deleted, run record removed

Failed:
• `request-002` — workspace deleted, Slack thread partially deleted: chat.delete failed for 2 messages; run record removed
```
Best-effort Slack deletion failures are reported in the summary and logged. They do not prevent workspace deletion or run record removal unless the failure happens before the run can be identified safely.
### Active run protection

For explicit IDs, any run whose stage is not `done` or `failed` is considered non-terminal for pruning purposes. That includes `pr_open`, `reviewing_*`, `implementing`, `planning`, and other active lifecycle states. If an explicit ID targets a non-terminal run and the command omits `--active`, the command replies with a refusal that lists the affected run IDs and does not create a confirmation.
If `--active` is present, non-terminal runs may be previewed and pruned after the same exact `Yes` confirmation. The preview must call out active stages clearly.
## Technical changes

### Affected areas

- `src/adapters/slack/classifier.ts` — add `ac-prune` to the emoji command table.
- `src/core/commands/registry-setup.ts` — register `prune`.
- `src/core/commands/prune-command.ts` — new command handler for parsing, previewing, confirmation, and execution.
- `src/core/command-confirmations.ts` — new in-memory pending confirmation registry.
- `src/types/commands.ts` or adjacent command types — add any metadata needed for confirmation events without changing ordinary command dispatch behavior.
- `src/adapters/slack/slack-adapter.ts` — emit confirmation command events for plain replies in pending confirmation threads; expose or delegate Slack thread deletion.
- `src/types/config.ts`, `src/core/config.ts`, `src/config/defaults.ts` — add and validate `workspace.auto_prune`.
- `src/core/workspace-manager.ts` or a new `src/core/workspace-pruner.ts` — add reusable guarded workspace deletion.
- `src/core/handlers/pr-merge-handler.ts` and `src/core/default-handler-registry.ts` — call auto-prune only after merge-driven transition to `done`.
- `src/adapters/runtime-composition.ts` — wire config, pruner, Slack deletion dependency, and command dependencies.
- Tests under `tests/core/commands/`, `tests/adapters/slack/`, `tests/core/`, and `tests/core/config.test.ts`.
### Run selection rules

For `:ac-prune: completed`:
1. Select runs where `run.stage === 'done'`.
2. Restrict selection to runs whose `run.channel` matches the command event channel. This keeps a channel command focused on clutter in that channel and avoids accidental cross-repo cleanup in multi-channel deployments.
3. Do not include `failed`, `pr_open`, or any other stage.
4. Sort deterministically by `updated_at` ascending, then `request_id`, so previews and summaries are stable.
For `:ac-prune:  [...]`:
1. Resolve each ID against `run.request_id`, then `run.id`.
2. Deduplicate resolved runs while preserving argument order.
3. If any ID cannot be resolved, refuse the command and list unknown IDs; do not create a partial confirmation.
4. If any resolved run is non-terminal and `--active` is absent, refuse the command and list those runs with their stages.
5. If all checks pass, preview exactly the resolved runs.
### Workspace path guard

Manual and automatic pruning share a pure guard:
```typescript
interface WorkspacePathGuardResult {
  root: string;
  workspace_path: string;
}

function assertDirectWorkspaceChild(workspaceRoot: string, workspacePath: string): WorkspacePathGuardResult;
```
Rules:
- Expand `~` in `workspaceRoot`.
- Resolve both paths syntactically with `path.resolve`; do not require `workspacePath` to exist because missing workspaces are tolerated.
- Reject empty or whitespace workspace paths.
- Reject paths where `path.dirname(resolvedWorkspacePath) !== resolvedWorkspaceRoot`.
- Reject the workspace root itself.
- Reject paths whose basename is `.` or `..`.
- Log and surface a clear error when a path fails validation.
Workspace roots are resolved from the run's channel binding in `channelRepoMap`. For legacy runs missing channel metadata, the implementation may accept the workspace path only if it is a direct child of exactly one configured workspace root; ambiguous or unmatched roots fail closed.
### Workspace deletion

Guarded deletion uses `fs.rm` / `rmSync` with `{ recursive: true, force: true }`. `force: true` means a missing workspace is an `OK` result with status `missing`. Deletion emits structured logs:
- `workspace.prune_started`
- `workspace.pruned`
- `workspace.prune_failed`
- `workspace.prune_rejected`
Fields include `run_id`, `request_id`, `workspace_path`, `workspace_root`, `mode` (`manual` or `auto`), and `duration_ms` where applicable.
### Slack thread deletion

Add a Slack-specific thread deletion capability behind a small interface so core command logic can report provider support cleanly:
```typescript
interface ThreadPruner {
  pruneThread(ref: ConversationRef): Promise;
}

interface ThreadPruneResult {
  status: 'ok' | 'partial' | 'unsupported' | 'failed';
  deleted_messages: number;
  failed_messages: Array;
  errors: string[];
}
```
The Slack implementation:
1. Uses `conversations.replies` with cursor pagination to list all messages in `ref.conversation_id`.
2. Attempts `chat.delete` for each reply message. Delete replies before the root message so the thread remains addressable during cleanup.
3. Attempts to delete human-authored messages where token scopes allow. Failures such as `cant_delete_message` are recorded but do not abort the prune.
4. Attempts `reactions.remove` for bot-owned reactions on the root where needed/available.
5. Attempts `chat.delete` for the root message last.
6. Logs per-message failures at warn/debug and returns `partial` when some messages could not be deleted.
Slack limitations are expected. Depending on bot/user token scopes and workspace policy, Autocatalyst may be unable to delete human-authored messages or remove some reactions. The command must report these limitations directly rather than pretending cleanup was complete.
### Manual prune execution order

For each confirmed run:
1. Re-read the run from the live `runs` map by `request_id`.
2. Re-validate that the run still satisfies the previewed mode:
	- `completed` entries must still be `done`;
	- non-terminal entries must still require that the pending operation was created with `--active`.
3. Validate the workspace path if it is non-empty.
4. Delete the workspace directory, tolerating missing paths.
5. Delete the Slack thread best-effort when `run.conversation.provider === 'slack'` and a Slack thread pruner is configured.
6. Hard-delete the run from the `runs` map.
7. Persist `runs.json`.
8. Add an item to the summary.
Run record deletion is intentionally hard delete. There is no `pruned_at`, `deleted`, `archived`, or tombstone field for manual pruning.
### Automatic workspace pruning on merge

Add config:
```yaml
workspace:
  root: ~/.autocatalyst/workspaces/autocatalyst
  auto_prune: true
```
Behavior:
- `workspace.auto_prune` is optional and defaults to `true`.
- Validation accepts only booleans when the field is present.
- Generated default config includes `auto_prune: true` with a comment warning that it deletes workspaces after merge.
- Only the PR merge approval path triggers auto-prune.
- The safe point is immediately after:
	1. `prManager.mergePR(run.workspace_path, run.pr_url)` succeeds;
	2. the user-facing `PR merged.` message is attempted; and
	3. the run transitions to `done`.
- Auto-prune deletes only `run.workspace_path`.
- On successful deletion, set `run.workspace_path = ''`, update `run.updated_at`, and persist.
- On deletion failure, leave `run.workspace_path` unchanged, log `workspace.auto_prune_failed`, and keep the run `done`.
- Auto-prune never deletes the Slack thread and never removes the run record.
This intentionally changes default upgrade behavior: deployments that upgrade will begin deleting workspaces after successful merge unless they explicitly set `workspace.auto_prune: false`.
### Confirmation event design

Add a provider-agnostic in-memory registry:
```typescript
interface PendingCommandConfirmation {
  id: string;
  command: string;
  conversation: ConversationRef;
  requested_by: string;
  expires_at: string;
  payload: TPayload;
}

interface CommandConfirmationRegistry {
  create(pending: PendingCommandConfirmation): void;
  consume(conversation: ConversationRef, author: string, response: string): PendingCommandConfirmation | undefined;
  hasPending(conversation: ConversationRef): boolean;
  sweepExpired(now?: Date): number;
}
```
The Slack adapter checks `hasPending()` for a thread before dropping an unmentioned thread reply. If a pending confirmation exists, it emits a `CommandEvent` such as:
```typescript
{
  command: 'prune.confirm',
  args: [rawReplyText],
  messageText: rawReplyText,
  conversation,
  origin,
  author,
  received_at,
}
```
`prune.confirm` consumes the pending operation. If the response is exactly `Yes`, it executes the stored prune plan. Otherwise, it cancels the pending operation and replies `Prune cancelled.`
### Telemetry

Add structured logs for:
- `prune.preview_created`
- `prune.preview_rejected`
- `prune.confirmed`
- `prune.cancelled`
- `prune.expired`
- `prune.item_started`
- `prune.item_completed`
- `prune.item_failed`
- `prune.completed`
- `slack.thread_prune_started`
- `slack.thread_pruned`
- `slack.thread_prune_partial`
- `slack.thread_prune_failed`
- `workspace.auto_prune_started`
- `workspace.auto_pruned`
- `workspace.auto_prune_failed`
Do not log secrets or full Slack token errors. It is acceptable to log run IDs, request IDs, Slack channel IDs, Slack timestamps, workspace paths, and sanitized error strings.
## Testing plan

### Config tests

- `workspace.auto_prune` absent defaults to enabled through the runtime helper.
- `workspace.auto_prune: true` is accepted.
- `workspace.auto_prune: false` is accepted.
- Non-boolean `workspace.auto_prune` fails validation.
- Generated default config includes `workspace.auto_prune: true`.
### Workspace guard/pruner tests

- Direct child of configured root is accepted.
- Workspace root itself is rejected.
- Sibling path is rejected.
- Nested grandchild path is rejected.
- `..` traversal path resolving outside root is rejected.
- Empty workspace path is rejected for manual deletion, while auto-prune with empty path logs skip/no-op.
- Missing direct-child workspace is treated as successful/missing with `force: true`.
### Command parsing and preview tests

- `:ac-prune: completed` selects only `done` runs for the command channel.
- `completed` mode excludes `failed`, `pr_open`, and active stages.
- `:ac-prune: ` resolves by request ID.
- `:ac-prune: ` resolves by run UUID.
- Multiple IDs are deduplicated.
- Unknown IDs reject the whole command without creating pending confirmation.
- Non-terminal ID without `--active` rejects the whole command.
- Non-terminal ID with `--active` creates a preview that clearly marks the active stage.
- Empty args or unsupported mode returns usage.
### Confirmation tests

- Preview creates one pending confirmation keyed by conversation and author.
- Exact `Yes` from the requesting author executes the prune.
- `yes`, `YES`, `Yes `, and any other content cancel rather than confirm.
- Reply from a different author does not execute the prune.
- Expired confirmation does not execute.
- Restart/no pending confirmation causes a later `Yes` to be ignored by normal routing.
### Manual prune execution tests

- Successful prune deletes workspace, invokes Slack thread pruner, removes run from map, persists run store, and replies summary.
- Missing workspace still removes Slack thread and run record.
- Slack thread partial deletion still removes run record and reports partial Slack cleanup.
- Workspace guard failure prevents deletion and leaves the run record intact.
- In `completed` mode, a run that changed from `done` to another stage between preview and confirmation is skipped/fails safely.
- Persist failure is logged by `RunStore` as non-fatal per existing behavior; summary should not claim persistence succeeded if the command can detect failure.
### Slack adapter/thread pruner tests

- `ac-prune` maps to `prune`.
- Plain unmentioned `Yes` in a pending confirmation thread emits `prune.confirm`.
- Plain unmentioned reply in a non-pending thread remains ignored.
- `conversations.replies` pagination is followed.
- Replies are deleted before the root message.
- Per-message `chat.delete` failures produce `partial` results.
- Human-authored delete failures are reported but do not throw.
- Unsupported non-Slack conversation returns `unsupported`.
### Auto-prune tests

- Merge approval with default config transitions run to `done`, deletes workspace, clears `workspace_path`, and persists.
- Merge approval with `workspace.auto_prune: false` leaves workspace path unchanged and does not delete.
- Auto-prune failure leaves the run `done` with original `workspace_path` and posts/keeps the normal merge result.
- Auto-prune is not triggered by question runs, failed runs, manual status overrides to `done`, or any non-merge route to `done`.
- Auto-prune does not invoke Slack thread deletion or remove the run record.
## Task decomposition

### Story 1 — Add guarded workspace pruning

- **Task: Implement workspace path guard**
	- **Description:** Add a pure helper that validates a workspace path as a direct child of a configured workspace root, including `~` expansion and traversal rejection.
	- **Acceptance criteria:** Direct children pass; root, siblings, grandchildren, empty paths, and traversal attempts fail closed with clear errors.
	- **Dependencies:** None.
- **Task: Implement reusable workspace prune function**
	- **Description:** Add a deletion helper/service that applies the guard and removes the workspace with recursive/force semantics while emitting structured logs.
	- **Acceptance criteria:** Missing direct-child directories are tolerated; guard failures do not call `fs.rm`; success/failure logs include run/request IDs and mode.
	- **Dependencies:** Workspace path guard.
### Story 2 — Add prune command preview and confirmation

- **Task: Register ****`:ac-prune:`**
	- **Description:** Add `ac-prune` to the Slack emoji command table and register `prune` / `prune.confirm` command handlers with usage text.
	- **Acceptance criteria:** Message-based `:ac-prune:` dispatches a `prune` command event; help output includes usage.
	- **Dependencies:** None.
- **Task: Add pending command confirmation registry**
	- **Description:** Create an in-memory confirmation registry keyed by conversation and requesting author, with expiry and consume semantics.
	- **Acceptance criteria:** Exact author/conversation can consume once; expired entries are ignored/swept; no persistence is introduced.
	- **Dependencies:** None.
- **Task: Let Slack adapter emit confirmation replies**
	- **Description:** Before ignoring unmentioned thread replies, check the confirmation registry and emit `prune.confirm` for pending conversations.
	- **Acceptance criteria:** Plain `Yes` in a pending thread reaches command dispatch; unrelated unmentioned thread replies remain ignored.
	- **Dependencies:** Pending command confirmation registry.
- **Task: Implement prune command parsing and preview**
	- **Description:** Parse `completed`, explicit IDs, and `--active`; select runs; validate active protections; create preview text and pending confirmation payload.
	- **Acceptance criteria:** Selection/refusal behavior matches the run selection and command parsing tests; no deletion happens before confirmation.
	- **Dependencies:** Command registration, confirmation registry.
### Story 3 — Execute manual prune

- **Task: Implement Slack thread pruner**
	- **Description:** Add Slack `conversations.replies` pagination, per-message `chat.delete`, best-effort reaction removal, and root deletion with partial-result reporting.
	- **Acceptance criteria:** Pagination and deletion order are covered; per-message failures are reported but do not abort the entire thread prune.
	- **Dependencies:** None.
- **Task: Implement ****`prune.confirm`**** execution**
	- **Description:** Consume pending prune plans; exact `Yes` executes; anything else cancels; execute each item independently.
	- **Acceptance criteria:** Successful items delete workspace, prune Slack thread best-effort, remove run record, persist, and appear in summary; failed items are isolated.
	- **Dependencies:** Workspace prune service, Slack thread pruner, confirmation registry.
### Story 4 — Add merge-time auto-prune

- **Task: Add ****`workspace.auto_prune`**** config**
	- **Description:** Extend config types, validation, runtime helper/defaults, and generated config.
	- **Acceptance criteria:** Field defaults to true, accepts booleans, rejects non-booleans, and appears in generated defaults.
	- **Dependencies:** None.
- **Task: Wire auto-prune into PR merge completion**
	- **Description:** After merge-driven transition to `done`, delete only the workspace when enabled, clear `workspace_path` on success, and persist.
	- **Acceptance criteria:** Auto-prune occurs only on PR merge success; failures are logged and do not alter the `done` transition; Slack thread and run record are retained.
	- **Dependencies:** Workspace prune service, config helper.
## Risks and mitigations

- **Slack cannot delete some messages.** Human-authored messages and some reactions may be protected by Slack scopes or workspace policy. Mitigation: treat Slack cleanup as best-effort, log per-message failures, and report partial cleanup in the command summary.
- **Plain ****`Yes`**** replies could be accidental.** Mitigation: confirmations are scoped to the command thread, requesting author, exact case-sensitive `Yes`, and a short expiry.
- **Path deletion is irreversible.** Mitigation: direct-child workspace root guard runs before every deletion, and manual deletion always requires preview plus confirmation.
- **Default auto-prune changes upgrade behavior.** Mitigation: document the new default in config comments and release notes; operators can set `workspace.auto_prune: false`.
- **Run record hard deletion removes audit history.** This is an explicit issue decision for manual prune. Automatic prune preserves run records to retain auditability for normal merged runs.
## Open questions

No open product questions for Phase 1. The implementation should preserve the future-phase space from issue #187: orphan thread cleanup, `all`, `orphans`, a read-only overview, and thread-reply prune are intentionally deferred.