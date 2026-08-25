# @deepseek-ai/dsh-tool-subagent

English | [中文](README.zh.md)

The model-facing delegation tool over one configured `ctx.subagents` provider. Changing the provider changes transport without changing the execution contract.

## Provider selection and lifecycle

Each plugin instance binds one subagent transport `provider` to one `toolName`; the model cannot change that transport. Load another distinctly named instance to expose another transport. `enableModelSelection: true`, or an enabled Host preference when `modelSelectionSettings: true`, requires that provider's child `agentOptions` capability and exposes optional child LLM `provider`, `model`, and `reasoning_effort` fields without additional route configuration. A call may supply a complete provider/model pair, or only an effort when configured or parent values supply the effective route. The live adapter resolves explicit or configured routes before child creation. A call that omits every selection field uses `agentOptions` and then inherits compatible missing values from the parent's latest logged request selection, falling back to its creation options before the first request and retaining its configured `maxTokens`. Changing provider or model without naming an effort clears the lower layer's route-owned effort so the selected model resolves its default.

The delegation tool registers only while its subagent provider exists, avoiding sibling load-order and provider-reload dependencies. When model selection is enabled, its optional fields remain visible without `ctx.llm`; a call that selects a route rejects if the service is unavailable. When disabled, the schema omits those fields and execution rejects a forced selection. Configured `agentOptions` remain deployment-owned child defaults independently of this model-facing switch. Adapter catalog and topology changes do not rewrite or re-register the tool. Its description follows `provider.inheritsParentContext`: fresh children require standalone prompts, while forked children already see completed parent turns.

An enabled definition registers `list_subagent_models`, which lists registered providers, one provider's advertised models, or one exact model's reasoning efforts at call time. At most one instance in a tool scope may enable selection because this discovery tool has a global name; duplicate owners fail registration. Shipped product compositions default the primary `subagent` (`spawn`) instance off and sample the Host `subagent-model-selection.enabled` preference when each new top-level session is composed. The enabled decision is logged as `subagent/model-selection-enabled`, inherited by child sessions, and retained on resume; later settings edits do not change a running session. Shipped compositions deliberately keep `subagent_fork` disabled so the fork inherits the parent's provider and model: changing that route would forfeit provider-side KV Cache reuse of the inherited conversation prefix and can make prefix recomputation dominate the delegated task's cost. This restriction remains even if discovery ownership is separated. Catalog membership remains advisory: an enabled delegation tool accepts an unlisted model id when its adapter does. The [model-selected route Agent Note](../../../.agents/notes/implemented/feature/2026-08-18-model-selected-subagent-routes.md) owns the rationale and reintroduction condition.

A foreground call passes the execution signal through startup and execution, awaits `run.result`, and always awaits `run.dispose()` before returning. Only `completed` returns the canonical `{ kind: 'foreground', runId, output: JsonValue[] }`, rendered as the same final text. Abort, refusal, token limit, and other failures become errored tool results whose message contains the stop-reason headline, an optional provider-authored `SubagentResult.diagnostic`, and then any preserved partial assistant text. The diagnostic remains separate from `SubagentResult.output`, so a truncated answer is never reported as success or confused with infrastructure detail. If result collection and disposal both reject, the errored result preserves both failures.

`backgroundMode` selects both the background route and the omitted `run_in_background` default. `one-shot` waits in the foreground by default; an explicit `true` registers a plain parent-owned Task and returns canonical `{ kind: 'background', jobId }`, rendered as `started background subagent job <id>`, even when the provider supports continuable children. Generic task tools own its later status, collection, cancellation, and notices; a failed Task keeps the stop reason and the same optional provider diagnostic in its detail. `continuable` runs in the background when the argument is omitted or `true`; an explicit `false` waits for the result in the foreground. Its background route requires a provider with the `prepareContinuable` capability, calls `ctx.subagents.startContinuable()`, and returns `{ kind: 'continuable', subagentId }`, rendered as `started subagent <childId>`. The route resolves at inbox acceptance: the child owns its own turns from there, so this call neither waits for nor collects a result. The child's transcript by that id remains the source of its detailed output, and the optional global `send_message` tool sends it more work. The continuation service delivers one settlement notice whenever the child's Activation ends, containing its outcome and any final assistant message independently of `report`. Starting continuable work does not require `send_message` to be loaded. See the [background subagent Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-background-subagent-tasks.md), the [continuable subagents Agent Note](../../../.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.md), and the [background-first delegation Agent Note](../../../.agents/notes/implemented/feature/2026-08-11-background-first-continuable-delegation.md).

`toolFilter` changes the child's global tool layer but is not a parent-derived authority ceiling. See the [agent-scope security non-goal](../../../.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md#security-and-authority-are-non-goals).

## Config

| Key | Meaning |
|---|---|
| `provider` (required) | Provider name (`spawn`, `fork`, `acp`, ...). |
| `toolName` | Model-facing name, default `subagent`; distinct for every loaded instance. |
| `enableModelSelection` | Exposes and accepts model-facing child LLM selection fields and registers the shared `list_subagent_models` tool, default `false`. It requires the subagent provider's `agentOptions` capability. At most one instance in a tool scope may enable it; the discovery schema remains registered without `ctx.llm`, while discovery and selected-route calls reject until that optional service is available. Configured `agentOptions` remain available when this switch is disabled. |
| `modelSelectionSettings` | Samples the Host `subagent-model-selection` preference while composing an Agent, records an enabled decision in its Session, and inherits that decision in child Sessions. Default `false`; mutually exclusive with `enableModelSelection` and valid only in an Agent-scoped composition. The preference defaults off and changes only subsequently composed top-level Sessions. |
| `enableRunInBackground` | Exposes background mode, default `true`; disabling also rejects forced background calls. |
| `backgroundMode` | Background lifecycle policy, default `one-shot`. `one-shot` defaults calls to foreground; `continuable` defaults them to background, requires the provider's `prepareContinuable` capability, and returns a durable child id without requiring the follow-up tool. |
| `agentOptions` | Configured child LLM `provider`, `model`, adapter-owned `reasoningEffort`, and positive `maxTokens`; requires the subagent provider's `agentOptions` capability. In-process providers merge explicit values over the parent's latest logged request selection, or its creation options before the first request. An inherited effort survives only while the effective provider/model route is unchanged; changing the route without an explicit effort lets the selected model supply its default. A configured provider, model, or effort is checked through the optional `ctx.llm` service before child creation even when the call omits model-selection fields; a missing service or invalid value rejects the call. |
| `persona` | Per-child persona; requires provider `persona` capability. |
| `toolFilter` | Per-child global-tool restriction; requires `toolFilter` capability. |
| `maxDepth` | Absolute delegation-depth cap, default `3` (`0` forbids delegation); a numeric cap requires the `depthLimit` capability and fails the mount without it. `'provider-managed'` sends no cap for an out-of-process provider whose budget belongs to the child harness. The tool stays visible at the cap; each attempted start checks the calling agent's current depth and returns an errored tool result when rejected. |

## Concurrency

Foreground and background calls are concurrency-safe: sibling delegations in one assistant message overlap under the loop's rolling pool (`maxParallelToolCalls`), and results still commit in model order. Children work in their own sessions and a run never mutates the parent session; the one-shot background form's one parent-owned write — registering a Task — is a synchronous, commutative insertion that tolerates concurrent dispatch, so overlapping background calls acquire their job ids in dispatch-race order. Coordinating sibling workspace effects belongs to the model, exactly as it already does for background and continuable children. See the [parallel subagent Agent Note](../../../.agents/notes/implemented/feature/2026-08-09-parallel-subagent-delegations.md) and the [parallel tool-call Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md).

## Model Experience

### Tool schema

#### What the model sees

The generated default [`subagent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent) under this instance's configured name while its provider exists. `enableModelSelection` adds `provider`, `model`, and `reasoning_effort` plus inheritance and selection guidance; the provider must support `agentOptions`. Provider context inheritance changes the tool and prompt descriptions. Enabled background mode adds `run_in_background`: continuable mode documents its `true` default, runtime settlement notice, and explicit foreground override, while one-shot mode documents its `false` default and the job id collected with `job_output` or stopped with `job_kill`. While the tool is visible in an assembly's scope, a `tool:<toolName>` system-prompt section tells the model to start independent continuable delegations together, keep working while they run, and choose foreground only when its next action depends on the result; a tool restriction removes both its schema and this guidance.

#### Token effect

Fixed schema cost per parent request; enabling model selection adds three parameters. Each subagent provider instance adds one schema, and each continuable instance adds one short system-prompt section.

#### KV Cache effect

Prefix-stable while subagent provider instances and their configuration are unchanged. Adapter catalog changes do not alter the definition. A route override on an inheritance-capable instance may prevent the child from reusing the inherited parent prefix.

### Model selection and discovery

#### What the model sees

An instance with static `enableModelSelection: true`, or a settings-controlled instance whose Session decision is enabled, exposes the child LLM selection fields and `list_subagent_models`. Calls reject while the optional `ctx.llm` service is unavailable. With no arguments the discovery tool returns registered provider ids and names; with `provider` it returns that adapter's advertised models; with `provider` and `model` it resolves the exact model and returns its advertised reasoning efforts and default. The result is read-only runtime metadata, not an authorization list.

#### Token effect

One fixed tool schema is present in shipped compositions. Directory contents enter the transcript only when the model calls the tool.

#### KV Cache effect

The schema is prefix-stable across adapter registration and catalog changes. Each result is appended after the reusable prefix.

### Foreground result

#### What the model sees

The call retains the description and prompt. Success contains only the child's final text; other outcomes become `Error: <stop reason>`, followed by a safe provider diagnostic when present and then any partial assistant text. Intermediate child steps stay out of the parent.

#### Token effect

The prompt and result remain in parent history until compaction; child working context remains in the child.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Background result

#### What the model sees

Start returns exactly `started subagent <childId>` in configured continuable mode, or `started background subagent job <id>` in configured one-shot mode. In one-shot mode the generic task surface provides later status, final output, cancellation responses, and notices; failed status detail includes the provider diagnostic when the result supplied one. In continuable mode this tool returns no result of its own; the child's settlement reaches the parent as a [service-owned notice](../subagent/README.md#settlement-notice), an independently loaded `send_message` tool delivers follow-ups, and the child's transcript by its id is the source of its detailed output.

#### Token effect

The acknowledgement is retained; a one-shot final output enters parent history only when collected or injected, while a continuable child's output never returns through this tool — its settlement notice arrives independently of any tool result.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Background runs expose no result through this tool** — a one-shot task's final output is collected through the generic task surface, and a continuable child's output stays in its own session, read by its subagent id. The settlement notice states how that child ended and carries any final assistant message, but it is not this call's return value and cannot be awaited here.
- **Duplicate names across waiting one-shot instances are detected late** (`TODO(subagent-dup-toolname)`) — continuable instances reserve their prompt-section name during plugin application, but preventing provider-registration rollback for waiting one-shot instances requires a registry of intended names.
- **Shipped fork tools cannot select a child LLM route** — they inherit the parent's provider and model to keep the copied conversation prefix eligible for KV Cache reuse. Re-enable the fields only when route changes preserve reuse or expose a bounded recomputation cost.
- **Non-routing child policy is fixed per instance** — another persona, tool filter, or depth cap requires another distinctly named tool. LLM provider/model/reasoning-effort selection requires static enablement or an enabled per-Session preference and a subagent provider that advertises `agentOptions`; out-of-process providers currently reject enabling it rather than ignore it.
