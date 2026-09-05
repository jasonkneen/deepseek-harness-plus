# Agent Note: Canonical feedback log and request delivery

Status: implemented

English | [中文](2026-09-05-canonical-feedback-log.zh.md)

## Problem

Editable message ratings need one durable authority that Session export and request delivery can retain. A separate feedback store makes those consumers incomplete and introduces a second commit relationship with the target message. Recording a human judgment must not change model input or imply that a collector accepted it.

## Decision

The canonical Session log owns feedback. Session-level remarks use `feedback/record`; material message edits and deletions use `feedback/message-put` and `feedback/message-delete`. All are log-only. The service folds current items from events matching the requested `sessionId`, so inherited parent events do not become a fork's current feedback. Deletion removes the current item, not earlier ratings or notes from the log.

Live message-feedback mutations append through the owning Session and await its durability checkpoint; cold mutations hold a persistence write handle across read, comparison, append, and flush without creating a Session or Agent. A matching no-op appends nothing but still awaits persistence. Failures propagate, and a failed live flush can leave an observable in-memory item for retry. Per-item versions prevent unrelated message edits from conflicting; strict stale-write rejection prevents ABA overwrites even when the desired value matches. Target validation binds a judgment to a sent assistant message, and forks keep independent judgments. These choices retain rationale recorded in the [archived sidecar decision](../../archived/architecture/2026-08-10-message-feedback-sidecar.md), whose storage and commit mechanism is superseded.

The existing opt-in [session-log-deepseek contribution](../../../../packages/session/session-log-deepseek/README.md) includes feedback in the ordinary `dsh_session_log` suffix on a subsequent eligible request. It uses the existing DeepSeek destination selection and acceptance watermark. There is no separate `dsh_feedback` uploader, feedback-triggered request, or model-input field. The shipped base disables its OTel row; this supersedes the default composition in the [feedback-gated default decision](../feature/2026-08-25-feedback-gated-telemetry-default.md), not the optional backend's modes.

The command confirms recording with the Session and anonymous user ids, without depending on telemetry or disclosing its policy. Its append remains unflushed. This supersedes the command-copy decision in the [archived sharing disclosure note](../../archived/feature/2026-08-07-feedback-acknowledgement-sharing-disclosure.md). The [telemetry service's policy API](../../../../packages/session/session-telemetry/README.md#the-sharing-disclosure) remains independently available: a backend discloses its policy, not delivery or retention, and the optional OTel package does not own that vocabulary.

## Alternatives considered

**Keep the sidecar.** It supports destructive local edits, but cannot make feedback part of ordinary canonical-log export and delivery without another join and durability relationship.

**Reuse `feedback/record` for message edits.** A free-text Session remark does not identify an item mutation, and its optional OTel consumer treats it as a release trigger. Distinct events preserve message identity and deletion semantics without that coupling.

**Add a dedicated uploader or immediate request.** The existing opt-in log contribution already carries canonical events and records acceptance. A second path would add delivery ownership and deduplication policy; this design accepts delayed delivery instead.

## Consequences

Feedback survives ordinary log export and replay without consuming model-input tokens or changing KV Cache. Current-item deletion is not erasure, and feedback recorded after the last eligible request can remain local indefinitely. The Web controller remains a unary Remote consumer and does not consume feedback log events for cross-tab updates.

[Message-feedback tests](../../../../packages/feedback/message-feedback/tests/message-feedback.spec.ts) cover material events, no-ops, strict versions, fork isolation, and persistence failures. The [request contribution tests](../../../../packages/session/session-log-deepseek/tests) own suffix acceptance and retry; the [command tests](../../../../packages/feedback/command-feedback/tests/command-feedback.spec.ts) pin the plain confirmation.
