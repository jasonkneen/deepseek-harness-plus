# Agent Note: SDK default file editor selection

Status: implemented

English | [中文](2026-09-05-sdk-default-file-editor.zh.md)

## Problem

The standard SDK profile inherits both `read`/`write`/`edit` and `str_replace_editor` from the shared base. These offer overlapping file editing interfaces, while the Web standard preset selects the former. [Issue #3599](https://github.com/deepseek-harness/deepseek-harness/issues/3599) requests the same editor choice for the standard SDK without making all SDK and Web behavior identical.

## Decision

The [SDK application patch](../../../../packages/bundle/sdk-app/cordis.patch.yml) disables the inherited `tool-str-replace-editor` row. The SDK retains `read`, `write`, and `edit`; the shared base, reusable editor package, and standalone `sdk-minimal` composition retain their own defaults. A trusted profile, home, or invocation patch can explicitly enable the row.

This narrows the SDK tool default described by [one dsh launcher](../architecture/2026-08-22-single-dsh-application-launcher.md). That decision remains active for launch ownership, shared services, and patch precedence; no active note is fully superseded.

## Alternatives considered

**Keep both editors enabled.** Shared base composition explains their availability, but the standard SDK does not need two default interfaces for the same file editing operations. Callers requiring this editor can select it explicitly.

**Remove the shared registration or reuse the entire Web preset.** Either changes more than the requested SDK default. Keeping the change in the SDK bundle preserves other profiles and the existing application architecture.

## Consequences

Default SDK requests omit the editor schema. Callers that select `str_replace_editor` by name need an explicit patch or their existing dedicated composition. This decision makes no claim of complete SDK/Web tool parity.

## Verification

The [SDK profile process test](../../../../apps/cli/tests/profiles/sdk/keyless-smoke.e2e.ts) captures actual model requests for the default roster, explicit editor enablement, and standalone minimal roster. [SDK recorded sessions](../../../../snapshots/sdk/sdk.snapshot.ts) pin the resulting schemas; shared cross-profile and persistent-editor recordings explicitly retain their required editor.
