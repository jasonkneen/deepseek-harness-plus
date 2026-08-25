# Agent Note: Out-of-process subagents expose minimal actionable diagnostics

Status: implemented

English | [中文](2026-08-21-out-of-process-subagent-minimal-diagnostics.zh.md)

## Problem

An ACP child can stop because it reached a remote limit, denied a required permission, lost its protocol transport, or exited as a process. The shared result historically reduced these outcomes to a stop reason such as `error`, while startup and cleanup rejection messages could expose the original exception. A parent could not choose between narrowing the task, adjusting permission policy, or repairing the child deployment without Host logs.

Copying exceptions, stderr, task content, tool input, paths, environment values, credentials, or protocol payloads into `SubagentResult.diagnostic` would make untrusted child text model-visible. Reusing a complete product-specific error union would also duplicate independently versioned authorities in the provider-neutral [subagent seam](2026-06-21-subagent-capability-seam.md).

## Decision

Each out-of-process provider owns a small mapping from facts it already receives at its protocol and process lifecycle points to fixed safe display text. The ACP provider implements that rule from its closed stop reasons, current operation, closed tool kind, configured permission policy, selected permission outcome, and the managed subprocess exit code or signal. Consumers continue to use the existing optional `SubagentResult.diagnostic`; they do not parse its punctuation or provider-private category names.

### Safe failure text

Generic error diagnostics have this fixed field order:

```text
Subagent failure (provider: <provider>; stage: <stage>; category: <category>; stop reason: <reason>; exit code: <code>; signal: <signal>)
```

Unavailable optional fields are omitted. The complete result is limited to 4096 UTF-8 bytes by the shared settlement boundary. Successful results and local cancellation carry no failure diagnostic. Partial assistant output remains in `SubagentResult.output` and is presented separately.

When an ACP permission request contributes to a non-completed result, a fixed line records `policy`, the closed ACP tool `request` kind, and `decision`. Tool titles, raw input, locations, option names, and metadata are excluded. For `max-tokens`, `refusal`, or remote `aborted`, the public stop reason already carries the terminal fact, so the permission line is the complete diagnostic; generic error paths append it after the failure line. A diagnostic-bearing remote `aborted` result keeps its public stop reason; the one-shot Job adapter treats it as failed, while diagnostic-free local cancellation remains killed.

### ACP facts

| Stage | Owned operation | Safe categories and facts |
| --- | --- | --- |
| `initialize` | Parent workspace resolution and ACP initialize | `configuration`, `transport`, or `process-exit` |
| `new-session` | ACP `session/new` and returned session-id validation | `protocol`, `transport`, or `process-exit` |
| `prompt` | ACP prompt request, remote stop reason, and permission callback | `remote-limit`, `transport`, `unknown`, or a permission-only diagnostic |
| `process` | Child-process spawn failure, or a managed child exits before a prompt terminal response | `process-start`, or `process-exit` plus independently observed exit code and signal |
| `teardown` | EOF quiescence and managed process-tree termination | Fixed teardown facts; the original cleanup failure remains internal |

`max_turn_requests` remains the shared `error` stop reason and adds `remote-limit`. An unknown stop reason remains `error` and becomes the fixed `unknown` category without copying the value. `max_tokens`, `refusal`, and `cancelled` keep their existing shared stop reasons; they add a diagnostic only when a permission decision must be explained.

### Ownership and lifecycle

| Fact or resource | Owner | Consumer behavior |
| --- | --- | --- |
| ACP stop reason and tool kind | ACP server and SDK | The provider maps only closed values and uses fixed unknown fallbacks |
| Current failure stage and latest permission decision | One ACP run | Derived at the failure point and discarded with the run; concurrent runs share no diagnostic state |
| Exit code and signal | `dsh-subprocess` handle | Displayed only after the managed outcome is observed; stderr is never parsed |
| Diagnostic bytes and presentation | `dsh-subagent`, foreground tool, and Job runtime | The same bounded text stays separate from assistant output in foreground and one-shot background modes |
| Raw failure | Child runtime, Error cause chain, and Host logger | Available for Host diagnosis only, never copied into the parent model result |

Startup publishes no run until initialize and new-session succeed. A startup failure rolls the private child back to quiescence before rejecting with safe facts. A published run settles its result without rejection, and `dispose()` independently reports a safe teardown failure while still using the backend's existing whole-tree cleanup ladder.

## Verification

ACP package tests drive a real stdio protocol child and pin every stop-reason mapping, remote-limit and unknown fallbacks, permission allow/deny facts, configuration, initialize, new-session, prompt, process, and teardown stages, startup rollback, successful-result and local-cancellation omission, partial output, concurrent-run isolation, Host-only raw errors, process quiescence, and the shared multibyte diagnostic limit. A Loader composition proves the real configured provider reaches the model-visible foreground result. The keyless ACP snapshot pins the same diagnostic and permission fact in foreground error output and one-shot background `job_output` detail.

## Alternatives considered

**Return raw exceptions, stderr, or protocol payloads.** These values can contain task content, tool input, paths, environment values, credentials, and upstream prose. Fixed allowlisted facts preserve the actionable distinction without expanding the model-visible trust boundary.

**Add a shared structured error enum.** ACP and other process-backed providers own different lifecycle points and closed termination vocabularies. A shared enum would invent false equivalence and force unrelated consumers to track provider releases.

**Parse exception messages or stderr into categories.** Free-form text is neither stable nor safe. Only closed protocol values, typed errors, current call sites, and managed process outcomes qualify as diagnostic inputs.

**Change existing stop reasons.** The stop reason remains the provider-neutral terminal result. The optional diagnostic explains why a non-completed result needs a different next action without adding new public result states.

**Add retries, recovery state, or interactive approval.** Diagnostics report a failure; they do not own remediation. Retry policy, session recovery, and human interaction require separate user contracts and lifecycle owners.

## Consequences

The parent can distinguish an ACP remote limit, permission involvement, protocol or transport failure, deployment/process failure, and teardown failure without receiving child-controlled text. Startup and cleanup errors use the same safe facts as published results, while Host observation retains the original cause.

The diagnostic remains display text rather than a public protocol. Consumers may present it but must not branch on its format. This decision adds no retry policy, recovery controller, shared provider-error enum, stderr classifier, authentication taxonomy, session persistence, progress stream, or new ACP capability.
