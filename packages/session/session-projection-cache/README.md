# @deepseek-ai/dsh-session-projection-cache

English | [中文](README.zh.md)

The persisted projection cache (`ctx.sessionProjectionCache`): durable checkpoints of every projection unit's state, one version-stamped document per session on the `session_projcache` storage domain in `per-record` layout (the shipped json backend lands each session's record at `<root>/session_projcache/sessions/<id>.json`). The cache never consults the persistence layer. Design authority: the [session-projection RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md) (persisted projection cache section).

A stored row `(key → {ver, seq, val})` is a fold shortcut, never an authority: possibly stale (`seq` says exactly how stale) but never wrong. Consequences the implementation commits to:

- **Reads and writes share one coherent state.** Every read is a synchronous lookup in the domain's in-memory tables; every write queues on the domain's per-unit write chain and mutates memory only after durability, so a read can never go around the write chain to the medium (no direct disk reads, no torn values).
- **Every background write is fail-soft.** A failed durable write logs a warning and keeps the cache stale; the next write self-heals. A crash between writes costs a longer tail replay, never a wrong value.
- **A `ver` mismatch against the live unit's `stateVersion` discards, never migrates.** A unit bump invalidates its rows at read time; the key refolds from the log.
- **A row must pass the live unit's `stateSchema`.** A malformed or stale record document reads as "no cache row" at open, so the cold path refolds from the log.
- **Whole-record writes.** Each write atomically replaces the session's record document (the registry cut is always complete), snapshotted through the lossless-JSON boundary — a unit state violating the plain-JSON contract fails loud. The domain write chain serializes writes, so a newer cut never lands before an older one.
- **Records are bound to a log lifecycle, not just an id.** Each record stores the header identity (`createdAt`, `cwd`) it was folded from; every read validates it (the live header is the witness) before accepting a record, so a deleted-then-recreated id cannot let an old record seed state folded from an unrelated log.
- **The log leads, the cache follows.** A live checkpoint flushes the session's buffered events durably BEFORE the cache row lands, so a crash can leave the cache behind the log (a longer tail replay) but never ahead of it.
- **The medium is the domain's, private by default.** The json backend creates its tree owner-only (`0o700`); the cache does not depend on which persistence backend is mounted — no `locate`, no per-session-dir probing.

## Write policy

Three mandatory points, throttled in between:

| Trigger | Nature |
|---|---|
| Session creation | Mandatory — the seed-derived cut (a forked child's inherited title, say) lands immediately, so a crash or a live-held session never loses it from the cold list. |
| `turn/end` | Mandatory — the turn-final value is what listing reads want. |
| Session disposal (detach) | Mandatory — the live-to-cold moment; after it the cache serves this session's final cut. |
| `writeEveryEvents` committed events | Config throttle (count). |
| `writeIntervalMs` since the first dirty event | Config throttle (interval). |

Both throttle triggers are required `Config` fields (no defaults): the flush cadence is a deployment choice stated in cordis.yml.

## Listing read (`cachedSnapshot(meta)`)

A synchronous, zero-I/O read from the domain's in-memory tables: client values viewed straight from the identity-matching stored record (version- and state-schema-matching keys only), returned as a `{asOfSeq, values}` cut — `asOfSeq` is the lowest served-row watermark, so a client seeding its per-session value store under higher-seq-wins can never let a stale list block overwrite a newer push frame. Host-only rows are never returned. `undefined` when no usable client row exists (unknown id, unrelated lifecycle, absent or foreign record document, or no usable rows); the api-proxy list carrier turns that into an absent column.

`write(session)` is the synchronous-cut checkpoint both mandatory points use; carriers may call it directly (not fail-soft — the fail-soft wrappers own containment).

## Composition

The cache opens its domain through the storage stack, so base mounts `storage`, `storage-json` (root `dshHomePath('storages')`), and `storage-domain` (`backend: json`) before it:

```yaml
- id: session-projection-cache
  name: '@deepseek-ai/dsh-session-projection-cache'
  config:
    writeEveryEvents: 200
    writeIntervalMs: 5000
```

Injects `storageDomain`, `sessionProjections`, `sessions`. Without this row the projection system runs live-only (watermark cache; cold reads fall back to full log loads wherever a carrier implements them).

## Model Experience

None, as the cache only persists host-side read models of already-logged session state and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; the cache never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **No eviction or retention surface** — records accumulate per session; pruning stored checkpoints is out-of-band maintenance, same stance as session persistence itself.
- **Interval throttle is per-session coarse** — the timer arms at the first dirty event after a clean write; a steady sub-threshold trickle writes once per interval, not a sliding window.
- **No cache-side cold refold** — the cache serves and refreshes its rows but never reads the session log (it does not depend on the persistence layer); a consumer that needs a guaranteed cold snapshot refolds from the log itself.
