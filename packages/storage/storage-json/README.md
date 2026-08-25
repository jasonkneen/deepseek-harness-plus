# @deepseek-ai/dsh-storage-json

English | [中文](README.zh.md)

JSON backend for the [storage hub](../storage/README.md), registered as backend `json`, serving two unit layouts:

- **`single` (default)** — one human-readable `<unit>.json` file per unit under a configured root.
- **`per-record`** — one version-stamped document per record at `<root>/<unit>/<table>/<key>.json` (plus `global.json`), so one write replaces one record instead of the whole unit; the unit is stateless (the directory is the state; `loadAll` re-reads the tree). Record keys must be path-safe (`[a-zA-Z0-9_-]+`); an unsafe key rejects.

Design: [domain KV storage Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md).

## Model

- `single` layout: the in-memory unit state is authoritative; every write primitive republishes the whole file via temp-write + fsync + atomic `rename()` replace. A unit file is always the complete current net state — legibility is this backend's reason to exist; scale is the SQLite backend's job.
- A missing file (or unit directory, for `per-record`) opens as an empty unit and materializes on the first write. In `single` layout a foreign or unparsable file rejects with `malformed-medium`, and a stored version differing from the descriptor rejects with `version-mismatch` (no migration, pre-release stance). In `per-record` layout the contract is per record instead: a document that is malformed or stamped with another version reads as an absent record, so one bad or stale file never bricks the unit, and a version bump discards stale records rather than rejecting the whole unit.
- An empty `per-record` tree bootstraps its declared-table records from a legacy `<unit>.json` whole-unit file and retains that file unchanged. Any new-layout document path in a declared table, or `global.json` for a declared global, suppresses the bootstrap for the whole unit even when the document is unreadable or stale; absent records remain absent instead of being filled from legacy state.
- Write ordering across calls belongs to the caller (the domain layer's write chain); each single call is atomic and durable once resolved.

## Config

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `root` | string | required — no default (a cwd fallback would scatter files) | Directory holding unit files; created `0o700` on demand |

## Model Experience

### Stored domain records

#### What the model sees

Nothing. This backend contributes no prompt, tool, or schema; it persists non-session domain data behind `ctx.storage` for host-side consumers only.

#### Token effect

Zero live-request tokens.

#### KV Cache effect

None — the backend never touches live request prefixes.

## Known Limitations and Deferred Work

- Windows durability relies on libuv's `rename()` (`MoveFileExW` with replacement) without an explicit write-through flag; the session-log backend's stricter Win32 write-through publish helper is planned to move down here when the append-log facet lands (see the Agent Note's migration section).
- No cross-process write locking: two processes writing the same root can interleave whole-file replacements (last write wins). Single-host-process deployments are the current consumer; the multi-process story is deferred per the Agent Note's out-of-scope table.
