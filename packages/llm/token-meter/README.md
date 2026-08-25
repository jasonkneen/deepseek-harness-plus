# @deepseek-ai/dsh-token-meter

English | [中文](README.zh.md)

Replay-aware token measurement through the singleton `ctx.tokenMeter` service. It advances one isolated fold per session from the durable log, so compaction and other pressure-sensitive plugins can share accounting without depending on `CompactionEngine`.

## Configuration

The estimator has no settings. It intentionally uses one fixed heuristic: four characters per token plus structural overhead for roles, blocks, and request-envelope fields. Any key is rejected; model capacity belongs to the adapter that owns an exact provider/model route and is available through `ctx.llm.resolveModelInfo().context`.

## Measurement contract

`ctx.tokenMeter` directly exposes two operations:

- `measure(session, requestHeader?)` returns request pressure and the current priced surface at one consumed-log revision.
- `estimateMessage(message)` prices one message with the fixed heuristic.

`measure()` synchronizes once and returns one detached, deeply immutable snapshot. `totalTokens` is request-and-response pressure, while `surfaceTokens` is the surface-only route-priced total and equals the sum of `nodes[].tokens`. A `requestHeader` override selects the priced route and the pressure fields; the node set still describes the current session. Every call clones the positional nodes, so measurement is O(surface).

The fold tracks full request-header snapshots, step boundaries, surface appends and replacements, successful assistant messages, provider usage, and the chunk seqs cited by each assistant message. Each measurement resolves the effective envelope's provider/model to that route's declared request-image pricing through the optional `llm` service: image occurrences are then priced as the visual tokens plus model-visible text the routed request actually sends, while routes and compositions without declared pricing keep the fixed heuristic. Every node also carries `heuristicTokens`, the route-independent fixed price the shadow-price protocol uses for replacements. Provider usage is reused only when the latest successful call's canonical request envelope matches the measured envelope and its total is no lower than that call's full route-priced anchor; a later success replaces the earlier anchor. Otherwise the complete current envelope and surface are estimated. Surface changes remain signed relative to a matching anchor repriced under the same route, including negative deltas after shrinking replacements.

Usage accounting sums disjoint input, cache-read, cache-write, and output buckets; reasoning is not added again. Every successful call records an assistant anchor, including content-less calls. An explicit empty `sourceEventSeqs` list means a known empty provider stream, while an absent legacy list conservatively treats the durable assistant output as provider output.

## Session projections

When the composition provides `ctx.sessionProjections`, token-meter registers three units through an optional child fiber.

`tokenUsage` carries the complete durable log's `uncachedInputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens`. Usage chunks are counted even when a request later fails; a final assistant-message usage replaces the streaming sample from the same model attempt instead of double-counting it. A matching `llm/retry-started` boundary ends that replacement scope, so a retry with the same `(turn, step)` contributes a new billed attempt. Reasoning remains an output subdivision. The single last-sample slot relies on a session-log ordering property: once a later step reports usage, a legal log never reports usage for an earlier step again.

Token-meter also owns the browser-safe pure fold from one complete Turn's durable events to exact attempt and Turn usage. `step/start` and `llm/retry-started` open real attempts; final message usage replaces that attempt's streaming sample; terminal failures, retries, and step boundaries close it. Missing lifecycle evidence, unsafe counts, or contradictory exact totals fail closed. Presentation consumers select a complete Turn window and render the result; they do not define a second accounting state machine.

`contextPressure` carries optional `pressureTokens` — the newest provider-reported prompt size, summing uncached input plus cache reads and writes — optional `projectedTokens`, and optional `contextWindow` from the newest `request/context` record. Both figures stay absent until a provider reports usage; capacity stays absent for a route whose adapter advertises none. Output is excluded, so `pressureTokens` holds still while a turn streams and steps forward when the next request reports its usage.

`projectedTokens` is what the NEXT request's prompt would cost: the sample plus the heuristic repricing of everything the surface gained or lost since it was taken, clamped at zero. Its O(1) fold in `surface-projection.ts` tracks appends and consumes the logged shadow price immediately before a replacement; on fully metered logs it agrees with the measurement service's positional plan/commit fold without retaining per-node prices. Only the delta is estimated, so the figure stays anchored to the provider while reacting the moment content lands — or a compaction shadows a span. That last case is why the field exists: compaction summarizes through a direct `ctx.llm.stream()` call and appends no usage of its own, so `pressureTokens` alone reports the pre-compaction prompt until an entire further turn completes. Occupancy displays read `projectedTokens`.

`contextBreakdown` carries heuristic `systemTokens`, `toolsTokens`, and `messageTokens` — the context's composition rather than its provider-billed size. The envelope figures reprice last-wins on every `request/header`; the message figure replays the same O(1) shadow-price fold as `contextPressure`, so on fully metered logs it equals the sum of `measure().nodes[].heuristicTokens` at every event boundary and compaction shrinks it by its logged shadow price. The route-priced `measure().surfaceTokens` diverges when the routed model reprices images. A replacement without an adjacent shadow-price claim leaves this bounded projection unchanged because it cannot reconstruct the replaced range. All three figures use the measurement service's fixed heuristic and are estimates: they will not sum to `projectedTokens`, whose provider anchor carries exactly the error — CJK text and JSON schemas underprice badly at four characters per token — that the composition rows still contain. Present them as an approximate composition, never as a total.

All three units use the standard projection baseline, live frame, higher-seq-wins store, and JSON checkpoint paths. Unloading token-meter removes all three keys. A composition without the projection seam keeps the measurement service's existing behavior.

### Context occupancy is an approximation, by design

The occupancy fields are independent last-wins records and are **not** one atomic observation of a single request. Switching models pairs the fresh capacity with the previous route's sample until the next request reports usage, and `pressureTokens` describes the last request rather than the surface as it stands right now — `projectedTokens` carries that sample forward over the surface's movement, but its anchor is still the older request.

This is deliberate. An occupancy percentage is a user-facing reference figure, not a billing record or a gating input — nothing in the harness makes decisions from it, and compaction reads `measure()` instead. A UI computes occupancy by dividing measured pressure by the separately resolved capacity for the selected model.

The [Agent Note](../../../.agents/notes/implemented/architecture/2026-07-29-projected-token-usage-and-request-context.md) records the rejected atomic-pair comparison. Consumers that need an exact same-boundary figure should call `measure()` at their own request boundary rather than read this projection.

## Composition

```yaml
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compaction-basic'
```

Both plugins have usable defaults. The meter consumes only the optional `llm` service, and only to resolve route-declared request-image pricing; compaction remains optional. A deployment configures capacity and image pricing on its LLM adapter and compaction policy on `dsh-compaction-basic`.

## Model Experience

Indirectly, through consumers such as `dsh-compaction-basic`; the service itself adds no prompt, message, schema, tool, or model call.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **The fixed heuristic is approximate** — text without reusable provider usage is priced by character count plus structural overhead, not an exact provider tokenizer or request serializer; only image occurrences on routes with declared pricing carry provider-exact visual tokens.
- **Every measurement clones the current surface** — coherent immutable snapshots make reads O(surface), including below-threshold pressure checks.
- **Provider usage is only reusable for an identical canonical envelope** — prompt, prefix, tools, provider, model, or call-config changes deliberately fall back to full heuristic estimation.
- **Missing legacy source seqs are handled conservatively** — assistant messages without `sourceEventSeqs` cannot distinguish provider output from listener rewrites, so the fold avoids claiming a known empty or exact chunk stream.
