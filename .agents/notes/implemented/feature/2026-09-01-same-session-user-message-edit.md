# Agent Note: Same-session user-message editing

Status: implemented

English | [中文](2026-09-01-same-session-user-message-edit.zh.md)

## Problem

Correcting a sent message required creating a fork even when the user wanted to keep working in the same Session. The [earlier removal of the unbacked Edit control](../../archived/simplification/2026-07-31-drop-user-message-edit-stub.md) correctly withheld that affordance until a Host operation existed. Reusing model-surface replacement alone was insufficient: compaction intentionally removes old messages only from model context, while Edit must also replace the visible Chat, Trajectory, turn-navigation, title-input, and search generation without deleting audit data. A running turn, queued prompts, attachments, and session-reference context also make a same-session retry more than a UI text mutation.

## Decision

The ordinary-Session `session.edit` operation accepts only the latest human `user/message`, and that message must open a turn and remain in the current model surface. The request identifies the target event and carries the latest human-message seq observed when the editor opened. The Host validates both before any interruption and repeats validation while it owns idle maintenance; a later human message makes the request stale. Earlier messages, direct subagent Sessions, steering messages, compacted messages, and messages without editable text are rejected.

If the Agent is running, Edit cancels the active turn with `keepInbox: true` and reserves maintenance synchronously at the idle transition. It inserts the replacement at the front of `next-turn`, so the edited rerun precedes existing Queue work without deleting it. The durable inbox admission carries the replacement's `SurfaceIntent` and any retained session-reference messages; AgentLoop expands those companions immediately after the edited prompt and follows the primary message by `MessageId` through `agent/pre-step` rewrites. The pre-step payload exposes claimed intents, and automatic compaction defers while a preplanned surface replacement is pending so its coordinates remain valid through commit. A restart after admission therefore preserves both replacement semantics and reference ordering.

The replacement message keeps the target's non-text content, uses the submitted text and a new timestamp, and runs with the Session's current model selection. An image-bearing edit validates that model before interrupting active work. Existing session-reference recall messages are copied rather than regenerated, so the rerun uses the snapshot the original prompt cited. Edit does not rewind files, processes, background work, subagents, or any other external side effect.

The committed replacement `user/message` carries two independent operations. Its `surfaceOp` replaces the current model-message suffix from the edited turn onward, and `sourceEventSeqs` names every removed surface node. Its `conversationOp` hides the inclusive raw-event range from that turn's `turn/start` through the pre-admission log tail from current user-facing projections. All old events remain in the append-only log.

`ui-conversation` folds `conversationOp` ranges before every target assembles nodes and rebuilds the loaded window atomically when a replacement arrives. Chat therefore never publishes a mixed old/new generation. The turn outline removes hidden turns. A replacement cancels pending or active automatic title work without scheduling a new revision; a later ordinary title revision reads only the current conversation generation. Session Query classifies every searchable event in a hidden edit range as `shadowed`; model-facing search defaults to `current` plus `log-only` and does not expose `shadowed`, while exact reads and traces remain available for diagnostics. Lossless Session export and whole-log statistics retain both generations.

Chat exposes Edit only on that latest eligible message. Editing uses a full Chat-width, composer-style input card with input-surface fill, border, elevation, and an internal cancel/save row. The textarea starts at 80px, grows with its content to 240px, and then scrolls internally. Enter submits, Shift+Enter inserts a newline, Escape cancels, and the normal composer remains enabled. Starting another submission closes the editor. Submission immediately replaces the selected suffix with a local echo; failure restores the durable view, while success hands off to the replacement event. The result has no edited badge or Undo action, and the existing Session title remains unchanged.

The shipped scope is the Edit part of [issue #2351](https://github.com/deepseek-harness/deepseek-harness/issues/2351). Fork and Rewind remain separate behavior.

## Alternatives considered

**Always fork before rerunning.** Rejected because it changes Session identity and leaves the user to choose between correction and branching. Fork remains useful when both histories should stay independently navigable.

**Mutate or delete the original events.** Rejected because Session persistence, replay, diagnostics, and lossless export depend on an append-only log. A replacement event records the new generation while retaining the prior facts.

**Treat every `SurfaceOp` replacement as a human transcript replacement.** Rejected because compaction and result pruning intentionally change model context without erasing what the user already saw. `conversationOp` is explicit and independent.

**Reuse the pending Queue editor.** Rejected because a queued message has not entered model history, while a historical edit must replace consumed context, interrupt current work safely, and rerun.

**Clear Queue or apply it in the edited request.** Rejected because Queue entries remain user-owned future turns. The edited turn runs first and leaves a window in which the user may still remove queued work.

**Provide Undo together with Edit.** Rejected because undoing after new model output requires another explicitly defined generation replacement and conflict policy. The retained raw events preserve the data without advertising an unsupported reversal.

## Consequences

One edit adds a new turn plus durable inbox and replacement metadata; storage, lossless export, and whole-log statistics grow with every generation. Current conversation views and default model search omit replaced generations, while diagnostic reads can still inspect them.

Conversation-range lookup is logarithmic in the number of merged edit ranges for each event. The SQLite provider already rebuilds documents for a changed live Session; Edit adds classification work but no second text index or delete/reinsert protocol for historical rows.

The unchanged prefix before the first replaced model message remains eligible for provider KV-cache reuse. The edited suffix starts a new request series and incurs normal request and response tokens.

Unit coverage pins range validation and folding, durable inbox replay, pre-step intent retention, Queue priority, interruption, attachment and reference preservation, title and outline behavior, search classification, and optimistic UI handoff. The Web replay e2e pins edit, rerun, hidden old output, and refresh reconstruction through the real Host and browser.
