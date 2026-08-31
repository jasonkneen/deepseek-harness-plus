---
description: "Prerequisite mounting and fail-fast Inbox stubs for Agent and agent-loop tests."
kind: "package-library"
---

# @deepseek-ai/dsh-agent-loop-testkit

English | [中文](README.zh.md)

## Summary

`dsh-agent-loop-testkit` mounts the standard prerequisite services a test needs before loading the concrete `AgentLoop` — the LLM runtime, session store, session-projection registry, system-prompt registry, tool registry, and agent registry — in dependency order, with one call. The loop itself, adapters, optional plugins, agents, and teardown stay in the test's hands, so each scenario keeps its own load order and topology. It also provides a fail-fast unsupported Inbox placeholder for Agent stubs whose tests do not exercise pending input. Use the package when a test's subject is loop behavior rather than service wiring; tests that probe injection failures or partial topologies mount their dependencies directly. It registers no model-facing behavior of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This package gives an AgentLoop test a working service topology before the loop is mounted.

### Minimal example

```ts
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'

const ctx = new Context()

await mountAgentLoopTestDependencies(ctx)
// Register the test adapter and any optional plugins here.
await ctx.plugin(AgentLoop, { agents: [] })
```

The mounting helper activates the LLM, session, session-projection, system-prompt, tool, and agent services in dependency order and returns before the loop is mounted. System-prompt and tool-registry configuration can be forwarded through `options`; the helper provides no test defaults beyond those the services own.

### Stub an Agent outside Inbox tests

Use `unsupportedInbox()` only when the test subject does not exercise pending Agent input. It exposes empty pending lists and throws on every mutation, so an unexpected Inbox dependency fails at its first write. Tests that exercise Inbox behavior construct `ReactLoopInbox` from `@deepseek-ai/dsh-agent-loop` instead.

```ts
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'

const agent = {
  // ...
  inbox: unsupportedInbox(),
}
```

### When to use it

Use the mounting helper for tests whose subject is the loop: load order, retries, tool execution, or session behavior on a real prerequisite stack. Mount dependencies directly when a test probes service load order, injection failures, partial topologies, or teardown — the helper hides exactly the wiring such tests must control.

### What can go wrong

A plugin-load failure rejects the mounting helper call; services activated earlier in the sequence remain owned by your context and unwind with it. The context owns every mounted service, so dispose it after the test.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the test utilities; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design

`mountAgentLoopTestDependencies` mounts six service plugins in a fixed dependency order — LLM, session, session-projection registry, system-prompt registry, tool registry, then agent registry — and deliberately stops before `AgentLoop` itself, so the caller controls loop load order and the topology under test. [`src/inbox.ts`](src/inbox.ts) provides only the fail-fast unsupported placeholder; it does not reproduce the concrete Inbox algorithm. The mounting implementation lives in [`src/index.ts`](src/index.ts); the [`src/invariant.ts`](src/invariant.ts) companion declares no runtime invariant because the package owns no production event stream or mutable data.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the loop to the services the helper mounts and the tests that use it.

- [Agent loop package](../../core/agent-loop/README.md) — the concrete loop this helper prepares tests for.
- [Session package](../../core/session/README.md) — the session store the helper mounts.
- [LLM package](../../llm/llm/README.md) — the LLM runtime and adapter contract the helper mounts.
- [Testing policy](../../../docs/testing.md) — the coverage tiers these tests serve.
- [Test-support group map](../README.md) — sibling harnesses and support packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as these test-only utilities neither drive nor modify model requests.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the utilities do not share. They are current package constraints, not a task backlog.

- **Only the mandatory prerequisite spine is shared** — adapters, optional plugins, `AgentLoop`, agents, and context teardown remain caller-owned so scenario-specific ordering stays visible.
- **The unsupported Inbox accepts no mutations** — use the concrete `ReactLoopInbox` whenever pending input is part of the test subject.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
