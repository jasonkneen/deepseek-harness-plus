# Agent Note: Model-selected subagent routes

Status: implemented

English | [中文](2026-08-18-model-selected-subagent-routes.zh.md)

## Problem

`dsh-tool-subagent` can configure child `AgentOptions`, and both in-process providers merge those values over the parent Agent's LLM selection. The model-facing tool could not request a different provider, model, or reasoning effort for one suitable subtask. Loading one distinctly named delegation tool per LLM route duplicates schemas and turns a per-call scheduling choice into deployment configuration.

The model also needs a bounded way to discover live providers and model-owned effort ids. Rendering the adapter directory into every delegation description would make an advisory, mutable catalog part of the prompt prefix.

## Decision

`dsh-tool-subagent` exposes optional `provider`, `model`, and `reasoning_effort` fields only when its instance enables `enableModelSelection`, or its Agent-scoped `modelSelectionSettings` instance resolves an enabled Session decision, and the bound subagent provider advertises `SubagentCapabilities.agentOptions`. No route allowlist is required. Registered LLM provider routes are available for child selection; this tool does not add a second authorization policy over the deployment's LLM registry. Disabled instances omit and reject model-facing selection, while configured `Config.agentOptions` remain deployment-owned defaults. Either selection mode against a provider without the capability fails the plugin mount.

Provider and model form one route and must be supplied together. An effort may be supplied alone when configured or parent values provide the effective route. Model arguments override `Config.agentOptions`, and configured fields override the parent Agent's latest logged request selection; creation options supply the fallback before its first request and retain the configured output-token limit. Reasoning-effort identifiers remain adapter-owned. An unchanged route inherits an omitted effort, while changing provider or model without naming an effort clears the lower layer's route-owned value so the selected model resolves its own default. `AgentOptions` carries the resulting effort into the child loop, whose request header logs the effective value. A continuable descriptor records it with the resolved provider and model so a child that has not logged its first request can cold-resume with the same selection.

An explicit or configured provider, model, or effort resolves through `ctx.llm.resolveCallConfig()` before child creation. That lookup owns provider registration, exact-model metadata, reasoning-effort validation, and adapter defaults. The tool checks cancellation again after the asynchronous lookup and before creating a child or background job. Calls with no model-facing selection and no configured route fields preserve the existing provider path without requiring the optional LLM service.

An enabled definition registers `list_subagent_models`. With no arguments the tool lists registered providers; with `provider` it calls that adapter's advisory model catalog; with `provider` and `model` it resolves the exact model and returns its reasoning efforts and default. At most one instance in a tool scope enables selection because the discovery name is global. Shipped product compositions put `modelSelectionSettings: true` on the primary Agent-scoped `subagent` instance and register the Host-owned `subagent-model-selection` settings namespace with `enabled: false`. A new top-level Session samples that preference during composition and logs an enabled decision as `subagent/model-selection-enabled` before any model request. A child Session inherits the live parent's decision, and a resumed Session uses its existing marker instead of the current preference. Therefore a settings edit affects only subsequently composed top-level Sessions. The fixed discovery definition remains available without the optional LLM service, while discovery and selected-route calls fail until that service is present. An unlisted model remains selectable when the adapter accepts its id.

Shipped `subagent_fork` instances leave `enableModelSelection` disabled even though the in-process fork provider supports `agentOptions`. A fork inherits the parent's effective provider and model so its copied conversation prefix remains eligible for provider-side KV Cache reuse. Changing either route component requires the new route to prefill that inherited history again, and that recomputation can dominate the delegated task's cost. This restriction is independent of the discovery tool's global name: separating discovery ownership would permit the configuration but would not preserve reuse. Fork route selection remains unavailable until a route change can retain prefix reuse or the caller can explicitly bound and accept the recomputation cost.

The delegation definition is static across adapter registration and catalog changes, so live topology neither expands every parent request nor invalidates its cache prefix. The discovery result enters the transcript only when called. A custom inheritance-capable instance that enables selection warns that changing provider or model can prevent provider-side reuse of the inherited conversation prefix.

`SubagentCapabilities.agentOptions` remains the transport truth. The service rejects a request carrying those options before calling a provider that advertises `false`. Both in-process providers advertise `true`; the current ACP, Codex, Claude Code, and DSH SDK transports advertise `false`. Tool configuration that supplies `agentOptions`, statically enables model selection, or makes it settings-controlled also fails when its bound provider lacks the capability.

## Alternatives considered

**Keep a deployment-configured route allowlist.** Rejected because it duplicates the live LLM registry, requires configuration before the model can use an already registered route, and creates a second policy surface for clients to edit. Deployments that must restrict LLM access should control which provider routes they register.

**Render the live adapter catalog in every delegation description.** Rejected because one provider can advertise hundreds of models, inflating every request, and catalog changes would rewrite an early cache-prefix definition. The on-demand directory keeps mutable data out of the fixed schema.

**Use the advertised catalog as an allowlist.** Rejected because adapter catalogs are advisory and some providers accept arbitrary exact model ids. Exact resolution remains authoritative.

**Add discovery methods to the subagent service.** Rejected because provider/model/effort metadata already belongs to `ctx.llm`; the new tool is a model-facing consumer of that existing capability.

**Export discovery as a separately loaded plugin entry.** Rejected because shipped compositions always pair discovery with their primary delegation tool. Explicit ownership on that instance prevents duplicate global names without another Cordis config entry or lifecycle.

**Configure discovery independently from model-facing selection.** Rejected because discovery exists to supply valid route and effort identifiers to the same model that can select them. One switch prevents a tool schema from advertising selection without its discovery path, or discovery without an applicable delegation route.

**Enable model-facing route selection on shipped fork tools.** Not shipped because changing provider or model forfeits the inherited prefix's KV Cache reuse and can make prefix recomputation more expensive than the delegated work. The option can be reconsidered when reuse survives the route change or the interface makes that cost explicit and bounded.

**Use a global reasoning-effort enum.** Rejected because effort identifiers and defaults belong to an exact provider/model route. The LLM adapter validates them without central translation or clamping.

**Allow remote providers to ignore the fields.** Rejected because the request would claim a route choice that did not happen. The capability flag makes the unsupported path fail before child creation.

## Consequences

- An enabled delegation tool can select any live child LLM route without deployment selector configuration; disabled instances omit and reject model-facing route fields.
- The primary delegation-tool instance defaults selection off, exposes a Models-page opt-in for new Sessions, and registers `list_subagent_models` only in Sessions whose durable decision is enabled; its catalog rows do not restrict delegation.
- Shipped fork tools inherit the parent's provider and model and omit model-facing route fields so the inherited conversation prefix remains eligible for KV Cache reuse.
- Omission retains configured defaults and compatible inheritance from the parent's latest logged request; a route change without an explicit effort uses the selected model's default.
- Adapter catalog and topology changes leave the delegation definition and its prompt-cache prefix unchanged.
- Out-of-process subagent providers reject configured and model-selected Agent options until they implement and advertise the capability.
- Unit coverage owns the default-off Host preference, new-Session sampling, child inheritance, resumed decisions, opt-in schema and execution enforcement, merge precedence, route-aware effort inheritance, preflight cancellation, live discovery, diagnostics, definition stability, capability rejection, and optional-service behavior. A shipped headless snapshot pins inheritance from a logged parent selection; the shipped examples also own the assembled keyless model-visible schemas.

## Related decisions

This note refines only child LLM routing. The fixed subagent transport remains owned by the [subagent capability seam](2026-06-21-subagent-capability-seam.md), while the separate effect of child-scoped prompt and tool additions on fork prefix reuse remains owned by [cache-preserving forked children stay one-shot](../architecture/2026-08-10-fork-children-stay-one-shot.md).
