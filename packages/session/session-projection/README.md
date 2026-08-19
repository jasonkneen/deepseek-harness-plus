# @deepseek-ai/dsh-session-projection

English | [中文](README.zh.md)

Session-projection Service Definition and drive registry. It owns `ctx.sessionProjections`, the registry that folds committed session events through every registered projection and serves finished whole values to carriers, currently the api-proxy history tail page and `session/projection` push frame. A domain registers pure mathematics; the framework owns the drive. The [session-projection RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md) records the design rationale.

## Service: `SessionProjectionRegistry` (ctx key: `sessionProjections`)

### Public API

- `ctx.sessionProjections.register(definition): () => void` Register one domain's unit. Registrants with the same key and `stateVersion` share its cells; an incompatible version or invalid `stateVersion` throws. The registration is an effect on the calling fiber, so the last unload removes the key and its cached cells from subsequent drives and snapshots.
- `ctx.sessionProjections.onChanged(listener): () => void` Subscribe to the change feed: one call per unit whose state reference changed, per committed event, carrying the schema-validated view and the causing seq. Effect-tied like `register`.
- `ctx.sessionProjections.snapshot(session): ProjectionSnapshot` One consistent synchronous cut over every registered unit — `{ asOfSeq, values }` with `asOfSeq` = the seq of the last event every value reflects (`-1` for an empty log).

### Key Types

- `SessionProjectionMap` — the single merge-extensible type table for the whole chain (host unit, wire block, React hook). Values are wire-JSON whole values; rendering belongs to the slot system, never this layer.
- `ProjectionDefinition<K, S>` — `{ key, schema, init(), apply(state, event), view(state), stateVersion }`: a state-driven computation unit of three pure synchronous functions plus declarations, never an opaque getter.

## Contract

- **The framework drives, the domain computes.** The registry subscribes to `session/event` once and runs every unit's `apply` over each committed event. Domains hold no subscriptions. Cells (`{state, observedSeq}` per unit per session, WeakMap-keyed) build lazily — a unit registered after events flowed, or a read of a session predating the registration, folds `init` over the in-memory log on first touch.
- **Same-reference means no work.** `apply` MUST return the same state reference for events that do not concern the unit; the drive gates the change feed on `Object.is`, so non-matching events cost one call and nothing downstream.
- **Whole-value event rule (load-bearing).** A state-carrying log event MUST carry the complete post-change state, never a bare delta — it keeps every transition trivially cheap and every served value self-describing (last-wins for consumers).
- **Synchronous unit discipline.** `init`/`apply`/`view` MUST be synchronous; carriers read `snapshot()` in the same tick as their page slice, which is what makes `asOfSeq` one consistent cut. An accidentally-async `view` returns a Promise, which fails the boundary `schema.parse` loudly.
- **State is plain JSON, `stateVersion` is its invalidation anchor.** The persisted projection cache stores `(sessionId, key, ver, seq, val)` rows; bump `stateVersion` whenever the state shape or the fold semantics change so stale rows are discarded instead of forward-applied into garbage.
- **No wire vocabulary here.** The registry exposes only the change feed and the snapshot read face; carriers (api-proxy) mint their own frames (`session/projection`) and blocks from them.
- **Dependency follows use.** A domain that requires projection state declares `sessionProjections` as a Cordis service dependency; optional contributors may register under `ctx.inject(['sessionProjections'], …)`. Carriers use `ctx.get('sessionProjections')` and omit their block or frames when the registry is absent.

## Role

This package owns the Service Definition and drive roles of the capability seam: domain host plugins (e.g. `dsh-tool-todo`) contribute units, carriers (`dsh-host-apiproxy`) consume the snapshot and change feed, and neither knows the other.

## Model Experience

None, as the registry only computes client-facing read models of already-logged session state and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; projections never assemble or send provider requests.

## Known Limitations and Deferred Work

- **Every tail page carries every registered key** — there is no per-key opt-out or lazy-key request shape yet; acceptable while values are UI-scale whole states (a todo list, a goal snapshot), revisit if a domain's value grows large.
- **The unit table is process-wide, so key presence is not a per-session capability signal** — a key registered by ANY agent preset appears in every session's snapshot, including sessions whose own composition mounts nothing that produces it. A client must read the VALUE (`plan.active`, an empty todo list) rather than treat an absent key as absence of the feature; a unit whose empty value is indistinguishable from a real one belongs on the host plane instead, which is why `dsh-token-meter` sits there.
- **Eager drive touches every unit per event** — bounded by each unit's transition and the same-reference gate, but a hot path would justify per-unit event-type prefilters, addable without contract change.
- **Registry cells live in memory only** — a restart rebuilds by folding the log on first touch; compositions that mount `dsh-session-projection-cache` seed that fold from persisted rows instead.
- **Synchronous unit discipline is only partially mechanical** — the boundary `schema.parse` rejects a Promise-returning `view`, but an `apply` that blocks or reads torn non-session state is a review concern; the invariant companion documents why no runtime check exists.
