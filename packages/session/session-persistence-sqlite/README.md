---
description: "SQLite session persistence for deployments and maintainers choosing, configuring, or debugging the opt-in packed-row backend."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-sqlite

English | [中文](README.zh.md)

## Summary

`dsh-session-persistence-sqlite` keeps every session's durable history in a single SQLite database: sessions survive restarts, and the deployment's whole history becomes one queryable file you can back up, inspect with SQL, and analyze — instead of one artifact per session. Choosing it changes nothing for the agent loop, the model, or replay, because it serves the same logical `SessionEvent` stream as the JSONL backend; packing, compression, and recovery are storage-internal details. Choose it when a single queryable database fits the deployment; no shipped composition enables it by default. It is a pre-release provider: it rejects database files it does not own instead of migrating them, and its synchronous Node SQLite driver blocks the JavaScript thread during reads and writes. Setup, sizing, and migration guidance come first; the implementation internals live in a collapsible developer section below.

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

Mount this provider when a composition needs durable sessions backed by SQLite and accepts a process-local, synchronous database driver. The common path is explicit: load the session service, mount the provider, and give it a database path.

### When to choose it

Choose this backend when a local deployment benefits from one queryable database instead of many per-session files. Choose the JSONL backend when consumers need a per-session artifact: this provider returns `undefined` from `locate(meta)`, supports no raw artifacts, and exposes no per-session file. Account for synchronous SQLite and compression work before adopting it for a high-concurrency service.

### Disk footprint and performance

The packed layout trades disk space for speed and structure. The available benchmark measures schema 17, the packed predecessor with the same chunk codec but the former row discriminator; schema 18 has not been remeasured. On its corpus — 105 sessions, about 2.5 million events — the SQLite database used 75 MB against 31 MB for the default compressed JSONL logs: roughly 2.5× the on-disk size.

The same measurements show writes finishing about 3× faster, 50-event suffix reads about 40× faster, full-session reads comparable or slightly faster, and about 2.5 million physical rows shrinking to roughly 66 thousand. Expect 2–3× the compressed JSONL footprint depending on session content; the full numbers and method live in the [SQLite physical chunk-row decision](../../../.agents/notes/implemented/architecture/2026-08-18-sqlite-physical-chunk-row-compression.md).

The disk cost buys a structured, queryable view of session history: external tooling can analyze `sessions` and `events` with SQL, decoding physical rows the way this provider does — the groundwork for features such as built-in full-text search.

### Minimal configuration

Load the session service first, then mount the provider with a database path. Use an absolute path when the location must not depend on the process working directory; relative paths resolve from that directory. `:memory:` is valid for an in-process database whose contents disappear with the process.

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-persistence-sqlite'
  config:
    path: /absolute/path/to/sessions.db
```

| Field | Default | Meaning |
|---|---|---|
| `path` | required | SQLite database path, or `:memory:` |
| `journalMode` | `wal` | Durable journal mode: `wal`, `delete`, `truncate`, or `persist` |
| `busyTimeoutMs` | `5,000` | Maximum synchronous wait for another connection's lock |
| `preparedSessionCacheSize` | `5` | Cold session preparations retained for resume reuse |
| `writeBatchMaxDelayMs` | `200` | Fixed live-event coalescing window, in milliseconds |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-persistence-sqlite) is the exhaustive source for every accepted field and its JSDoc.

### Migrating existing JSONL sessions

There is no built-in migration tool: the JSONL and SQLite stores are separate, and nothing copies sessions between them. Because both backends implement the same logical contract, you can carry a session over with the persistence API — read on the JSONL side, write on the SQLite side. One backend serves `ctx.sessionPersistence` per composition, so run the two halves as separate runs or processes:

```text
// Export — run against the JSONL composition, per session id:
const { meta, events } = await ctx.sessionPersistence.load(id)

// Import — run against the SQLite composition, per exported session:
await ctx.sessionPersistence.create(meta)
await ctx.sessionPersistence.append(id, events)
```

`list()` enumerates the materialized sessions to export. The exported events keep contiguous `seq` values starting at 0, so `append` accepts them as one ordered batch into a fresh session; `load` also commits any needed cold repair on the source first, so the exported log is balanced. Treat the migration as a one-time cutover: verify that the imported sessions load, then switch the composition to the SQLite provider. Continuing to write through the old JSONL root afterwards would let the two stores diverge.

### Startup and safe operation

A fresh database initializes directly at schema version 18. Databases with any other version, a foreign application identity, an unversioned non-pristine schema, or unexpected schema objects are rejected before any data is exposed or changed — this pre-release provider ships no migration. Every statement and fixed pragma comes from packaged `.sql` resources in `resources/sql/`, and runtime values are bound as SQLite parameters, so package code never assembles query text.

Each connection disables SQLite trusted schemas and memory-mapped I/O, verifies the requested journal mode, and pins `synchronous=FULL` so a resolved append remains durable across an OS crash or power loss. On POSIX, the database parent directory and file must belong to the current user, the parent must not be group/world-writable, and the file must grant no group or world permissions; Windows additionally rejects symbolic links and non-regular files, while ACL restriction stays the deployment's job. Path and ownership failures reject plugin initialization; Node's SQLite driver loads lazily on the first persistence operation. Ordinary `create` stays lazy until the first append, while `ensureMaterialized` writes a session metadata row with no event rows.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is built on one separation and three commitments:

- **Logical contract, physical format.** Callers always read and write ordinary `SessionEvent[]`; how rows are packed, stored, and compressed is private to this package.
- **The schema owns the format.** Schema 18 is a frozen physical contract: a database at another version, with a foreign identity, or with unexpected schema objects is rejected, never migrated. Changing the physical rules requires a new schema.
- **Durability is the default.** Appends run in immediate transactions with `synchronous=FULL`, and a resolved `append()` means the batch is durable. Normal appends are insert-only: earlier event rows are never rewritten.
- **Efficiency within strict bounds.** Packing and compression keep the database small, but every limit is a hard format bound — at most 1,024 events and 1 MiB of payload per packed row.

The decision history — alternatives considered, measurements, and consequences — lives in the [SQLite physical chunk-row decision](../../../.agents/notes/implemented/architecture/2026-08-18-sqlite-physical-chunk-row-compression.md).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, service registration, coordinator wiring |
| [`src/store.ts`](src/store.ts) | Storage primitives: transactional append, reads, repair, path and ownership validation |
| [`src/schema.ts`](src/schema.ts) | Schema ownership: version gate, connection hardening, row decoding |
| [`src/codec.ts`](src/codec.ts) | Packing: which `assistant/chunk` runs become packed rows, size bounds |
| [`src/compression.ts`](src/compression.ts) | Physical encoding: compression threshold, sequence lists, row scan and decode |
| [`src/sql.ts`](src/sql.ts) + [`resources/sql/`](resources/sql/) | Every SQL statement as a packaged, closed-name resource |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; packing is observable only by database round-trip) |

### Database schema

A fresh database contains three strict tables, defined in [`resources/sql/schema.sql`](resources/sql/schema.sql):

| Table | Purpose |
|---|---|
| `persistence_state` | One-row store identity |
| `sessions` | One row per session: header fields plus a monotonic revision |
| `events` | Physical event rows: one logical event, or one packed run |

The exact columns live in [`resources/sql/schema.sql`](resources/sql/schema.sql). `events.data` holds text or a blob: small payloads stay text, larger ones are stored compressed when that is smaller. `events.is_packed` is `0` for a scalar logical event and `1` for a packed chunk run, so a scalar event whose type matches a physical chunk tag remains unambiguous. Packed rows reuse the `seq` of their first logical event, so under the composite `(session_id, seq)` primary key physical order is logical order.

### Write path

Each append takes an immediate transaction, re-validates schema ownership, checks the stored tail so a stale writer cannot extend the log, packs only the new batch, inserts its rows, bumps the session revision once, and commits. The coordinator coalesces live events for the configured window, so high-frequency streams produce larger packed runs while physical writes stay proportional to newly durable batches.

### Read and recovery

A full read locates the last valid `turn/end` in a reverse pass, then decodes each physical row into its logical events in forward order, rejecting gaps or malformed rows in the committed prefix. A malformed final row is treated as a torn tail: a mutating load may delete it under the write lock and close the log with synthetic closers. Suffix reads (`readFrom`) examine only the physical span that may contain the requested sequence, so they never parse unrelated earlier rows.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared persistence model to exhaustive configuration and the decision evidence behind the physical layout.

- [Session persistence subsystem](../../../docs/subsystems/persistence.md) — backend-neutral service semantics and provider relationships.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-persistence-sqlite) — every accepted config field and its source declaration.
- [SQLite physical chunk-row decision](../../../.agents/notes/implemented/architecture/2026-08-18-sqlite-physical-chunk-row-compression.md) — rationale, alternatives, and measurements behind the packed layout.

-----

<a id="model-experience"></a>
## Model Experience

### Resumed conversation history

#### What the model sees

Nothing specific to SQLite. Resume restores the same logical events and derived messages as the JSONL backend; physical packed tags never reach prompts, tools, replay, or live `session/event` delivery.

#### Token effect

Zero live-request tokens. Resume pays only for the retained logical history and the current request envelope.

#### KV Cache effect

Physical packing does not mutate request prefixes. Provider cache reuse depends on the reconstructed history, current envelope, and model route exactly as with other persistence backends.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit or needs special operational care. They are current package constraints, not a general SQLite comparison or a task backlog.

- **Pre-release design with no migration** — schema 18 is an interim SQLite-only design; the deferred unified multi-backend relational design with configurable schemas exists as a working external prototype in [morlay/session-persistence-rdb](https://github.com/morlay/session-persistence-rdb) (Drizzle-based, SQLite and PostgreSQL), and neither schema stability nor migration support is guaranteed.
- **Packing depends on batch boundaries** — a compatible run split by the write-behind window or an explicit flush stays split across physical rows; this avoids rewriting prior rows at the cost of a timing-dependent packing ratio.
- **Synchronous SQLite and compression** — Node's SQLite driver and Zstandard calls block the JavaScript thread; the 4 KiB compression threshold bounds per-frame work for small records.
- **Busy waits block the event loop** — SQLite waits inside synchronous calls; a competing writer can stall the thread for up to the configured `busyTimeoutMs`.
- **External SQL readers must decode physical rows** — a packed `events.type` (`text-chunks`, `reasoning-chunks`, `tool-call-chunks`) is not a logical event type; supported consumers read through this provider.
- **No deletion or historical compaction** — normal appends are insert-only and nothing removes old rows.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: measured artifacts, open design questions, and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes, and conclusions migrate there once they stabilize.

#### Benchmark artifact

The numbers below are the frozen schema-17 benchmark. Schema 18 changes the row discriminator and has not been remeasured; the [SQLite physical chunk-row decision](../../../.agents/notes/implemented/architecture/2026-08-18-sqlite-physical-chunk-row-compression.md) is the authoritative record, and this table is an annotated digest.

| Metric | **JSONL (zstd)** | **SQLite (legacy)** | **SQLite (new)** |
|---|---|---|---|
| On-disk size | **30.65 MB** | 709.57 MB | 75.01 MB |
| Write time, 105 sessions | 28.21 s | 10.64 s | **8.58 s** |
| Complete-session read p50 / p95 | 4.49 / 23.36 ms | 9.02 / 69.16 ms | **3.95 / 21.58 ms** |
| 50-event tail read p50 / p95 | 10.58 / 80.90 ms | **0.189 / 0.293 ms** | 0.253 / 0.378 ms |
| Event rows | 2,507,860 (logical) | 2,507,860 | **65,810** |
| Fork of all sessions | 14.48 s | 19.30 s | **13.10 s** |

The corpus was 105 sessions with 2,507,860 logical events appended in 512-event durable batches, so the ratios depend on session content, stream density, and batch boundaries. `SQLite (legacy)` is the scalar layout — one physical row per logical event, no packing — whose 709.57 MB footprint motivated the packed rows. In the measured schema-17 layout, SQLite uses ≈2.5× the JSONL disk space but writes ≈3.3× faster, reads complete sessions faster at both percentiles, and reads 50-event tails ≈40× faster; against the scalar layout it is ≈89% smaller, faster to write, and shrinks 2,507,860 rows to 65,810, while scalar tail reads remain marginally faster (0.189 vs 0.253 ms p50). Re-run or extend this benchmark whenever the write path or the schema changes.

#### Future: multi-backend RDB persistence (Drizzle)

A unified multi-backend relational design stays deferred. A Drizzle-backed rework would need to resolve: schema ownership — the per-version freeze and exact-object validation exist so any composition can read any same-version database, so a customizable schema must remain versioned and validated the same way; backend hardening — `synchronous=FULL`, busy timeout, and ownership checks are SQLite-specific, and Postgres or MySQL backends need their own durability and permission story; and codec portability — the packed-row codec is shaped around SQLite columns, so either a shared codec across dialects or per-backend codecs fixed by schema version must keep the logical contract identical.

#### Future: persistence-to-persistence transfer and version migration

The README documents a manual `load` → `create`/`append` transfer, but the seam has no import/export API, and SQLite rejects other schema versions outright. Automating transfer needs: an export format that preserves header lineage (`seedLength`, `parentSession`, `agentPreset`) and revision semantics; an upgrader chain for format and schema versions, the deferred chain from the [fail-closed event-vocabulary note](../../../.agents/notes/implemented/simplification/2026-08-25-fail-closed-session-event-vocabulary.md); and a source-side guarantee that the log is readable and balanced before export — `load` already commits cold repair.

#### Future: in-database full-text search and indexing

The sibling [session-query-sqlite](../../session-query/session-query-sqlite/README.md) package already maintains a dedicated SQLite FTS5 search index over session content in a separate derived-index database. Putting FTS inside the persistence database would duplicate that surface; open questions are where the index belongs, how to keep it transactional with append, and whether packed rows should be expanded into index documents or the index should read the logical stream. The persistence schema currently indexes only `(session_id, seq)`; further indexes (for example on `sessions.created_at` for cold-cutoff scans) are easy but add write cost.

#### Future: cold-data offloading to cascaded database files

The provider has no deletion or background compaction: everything stays in one database forever. One direction is offloading cold sessions (for example, older than 30 days) into separate archive database files arranged as a cascade, with more aggressive compression — a higher Zstandard level is cheap for cold data. That needs: a routing rule that knows which file holds which session, cross-file fan-out for `list`/`readFrom`/`load`, consistent revisions and store identity across the cascade, and a decision on whether offloading replaces the no-deletion limit or supplements it.

</details>
