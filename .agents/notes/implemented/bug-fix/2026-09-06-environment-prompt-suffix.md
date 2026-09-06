# Agent Note: Environment facts follow reusable prompt instructions

Status: implemented

English | [中文](2026-09-06-environment-prompt-suffix.zh.md)

## Problem

The local Web URL, Harness checkout path, and persona model/workspace values differ across users and machines. Placing those facts before reusable tool instructions makes otherwise identical prompts diverge near their beginning, limiting the prefix available for cache reuse.

## Decision

The [system-prompt registry](../../../../packages/core/system-prompt/README.md) keeps the fixed Harness identity first and places first-party reusable instructions through `STRUCTURED_OUTPUT` before the environment-bearing suffix: `HARNESS_SOURCE` at `10000`, `WEB_SURFACE` at `10100`, and `DEPLOYMENT_PERSONA` at `10200`. Existing section names, interpolation, scoped shadowing, and exact `complete: true` persona overrides are unchanged. The order change applies to entire sections; it does not parse persona prose or add an OS variable or value.

This decision supersedes only persona placement in the [prompt-variables and tool-guidance ownership note](../architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md). That note remains active because its single-owner rule, strict interpolation, and tool-guidance responsibilities still apply.

## Alternatives considered

**Move only the source path and Web URL.** Shipped personas also contain the model and cwd, so leaving the persona near the beginning still breaks the reusable prefix across workspaces.

**Split environment facts into a new API or infer variable sections from their text.** Existing named section orders cover the current producers. A new classification or persona parser adds behavior and configuration without a current consumer that needs it.

**Move these facts into runtime-context messages.** That changes their message role and persistence placement rather than only their order. The existing system sections can preserve their content and ownership while moving after reusable instructions.

## Consequences

Cross-user byte-identical prefixes require matching tools, configuration, and preceding section text. Tool schemas, plan mode, deployment-specific guidance, and experimental Team state can still differ. Arbitrary extension orders and assembly listeners remain authoritative; this is a first-party placement policy, not a universal stable-prefix guarantee. Provider cache sharing and hit-rate improvements are not measured or promised.

The deployment persona and Web/source guidance occur later, including after structured-output instructions. Structured output need not be the final string; complete persona overrides still suppress every other system section. Source and Web facts retain their existing distinction between the Harness checkout, session workspace, and current working directory.

## Testing

[Registry tests](../../../../packages/core/system-prompt/tests/system-prompt.spec.ts) compare identical reusable prefixes across changed checkout paths, URLs, models, cwd values, and a test-registered platform variable; they also cover strict interpolation and complete overrides. [Loop tests](../../../../packages/core/agent-loop/tests/loop.spec.ts) pin request ordering and session-cwd interpolation. [Persona tests](../../../../packages/preset/persona/tests/persona.spec.ts) cover scoped replacement and complete personas. [Recorded prompt snapshots](../../../../docs/testing.md) cover the emitted prompts in native-tool and generated-SDK compositions; they do not measure provider cache hits.
