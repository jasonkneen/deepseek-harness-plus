# Agent Note: Feedback-gated session-telemetry default

Status: implemented

English | [中文](2026-08-25-feedback-gated-telemetry-default.zh.md)

## Problem

Diagnosing a `/feedback` report needs the session data the report describes. With the shared base resolving an unset `DSH_TELEMETRY_MODE` to `DISABLED`, a default installation's feedback reached its receiver with no session data at all, and the reporter had no way to grant access at the moment they asked for help; only deployments that had exported `DSH_TELEMETRY_MODE` beforehand ever delivered a diagnosable report.

## Decision

The [canonical feedback decision](../architecture/2026-09-05-canonical-feedback-log.md) supersedes this default composition: the shipped base disables its OTel row. The optional backend retains its modes; the release-boundary rationale below does not authorize upload in a default installation.

When explicitly enabled without replacing its config, the shared base's OTel row resolves an unset or empty `DSH_TELEMETRY_MODE` to `FEEDBACK_ONLY`. The plugin's own omitted-`mode` default remains `DISABLED`; `FULL` and `DISABLED` are explicit environment overrides, and non-empty `DSH_TELEMETRY_DISABLED` remains the pre-load hard opt-out. In `FEEDBACK_ONLY`, each `feedback/record` releases the canonical suffix after the same Session object's handoff cursor through that event. A new object starts at its constructor boundary: a fresh Session begins at seq 0, while a forked, resumed, or migrated Session excludes its constructor seed and begins with this lifecycle's `session/end-seed`.

Feedback-gated release lets a reporter share the lifecycle that exhibited the problem without reproducing it. It trades continuous export for an explicit feedback trigger, but a deployment must establish consent before enabling that policy. The [archived default-off](../../archived/feature/2026-08-10-telemetry-default-off.md) and [default-mount](../../archived/feature/2026-07-31-web-telemetry-default-mount.md) notes record the earlier composition; the [base patch](../../../../packages/bundle/base/cordis.patch.yml) and [OTel README](../../../../packages/session/session-telemetry-otel/README.md) own current configuration.

## Alternatives considered

**Require reporters to re-run after enabling telemetry.** Rejected as the feedback-gated workflow: the Session that exhibited the problem is the useful evidence, and re-running loses it.

**Default to `FULL`.** Rejected: a fresh installation does not authorize continuous export without user action.

**Use only subsequent DeepSeek requests for delivery.** The canonical feedback decision accepts this for the shipped default, including the risk that a final feedback entry remains local. The optional feedback-gated OTel mode retains its event-time release trigger; request-time delivery cannot provide that timing without initiating another request.

## Consequences

- The shipped base uploads nothing through OTel. An explicitly enabled `FEEDBACK_ONLY` backend hands off the unreleased lifecycle-local prefix only on `feedback/record`; message-rating events do not themselves trigger release.
- On-demand capture copies and redacts the canonical log at feedback time. Without a deployment redaction rule, exported data can include message text, tool arguments and results, and workspace paths.
- The command acknowledgement confirms recording, not sharing or delivery. A deployment requiring prior informed consent must provide it before enabling uploads; OTel handoff remains subject to the SDK's batching, retry, and loss policy.
