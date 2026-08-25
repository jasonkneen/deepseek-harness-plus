# @deepseek-ai/dsh-spill-local

English | [中文](README.zh.md)

The **local-filesystem** implementation of the [`@deepseek-ai/dsh-spill`](../spill) storage seam. Registers as `ctx.spillStore` and persists a tool's oversized text to a private, session-scoped file; its locator is the file path and its retrieval hint tells the model to use `read` or `grep` on that path.

## Storage layout

Files land at `<root>/session-<hash>/​<random>-<safeName>`:

- **`root`** — the config `root` (resolved to absolute), or a lazily-created private (0700) per-process directory under the OS temp dir when omitted. A predictable, world-readable root would let other local users read spilled tool output or plant symlinks.
- **`session-<hash>`** — a short `sha256(sessionId)` prefix, so a session's spill files group together and a future cleanup can drop them per session.
- **`<random>-<safeName>`** — an unpredictable hex prefix (defeats symlink planting in a shared root) plus the caller's `suggestedName` sanitized to one safe path segment (traversal-proof; mirrors the JSONL persistence backend's `encodeSegment`). The write is exclusive + owner-only (`open(path, 'wx', 0o600)`): it fails on any pre-existing path, symlink or not, so a planted target cannot redirect it.

## Config

| Key | Default | Meaning |
|---|---|---|
| `root` | private 0700 temp dir | Root directory for spill files. Set to keep them under a known location. |
| `cleanupPeriodDays` | `30` | Age in days after which a spill file is eligible for the one-shot startup cleanup sweep. `0` disables cleanup. |

## Startup cleanup

The backend never deletes a spill on the write path — a persisted, resumed, or forked session may still reference an older locator, so immediate deletion would break retrieval. Instead, one best-effort sweep runs **once after activation**: it does not delay service availability, is owned by the plugin fiber, and is awaited on disposal (no sweep I/O outlives the fiber). There is no recurring timer and no separate process, so a long-lived deployment is not swept again until its next restart.

The sweep scans the configured `root` **and** any earlier default `dsh-spill-*` temp roots that prior default-root runs left under the OS temp dir. It resolves each root to its filesystem identity, so a configured alias of a discovered root remains the active, non-prunable root. Within each root, the sweep deletes regular files whose `mtime` is strictly older than `now − cleanupPeriodDays` and prunes every empty session directory; only an empty discovered prior-default root is itself removed. A write recreates a session directory if cleanup races it. The sweep never follows or deletes a symlink and skips unrelated entries.

On POSIX, cleanup admits only roots owned by the current user, not writable by group or others, and protected from replacement through their ancestor path; a writable sticky temporary directory such as `/tmp` is permitted. Session directories must satisfy the same ownership and write restrictions. Unsafe paths are skipped with a warning, which prevents an untrusted local process from redirecting path-based deletion outside the spill root. Every filesystem or warning-sink failure is contained, so cleanup cannot fail activation or a concurrent spill write. Retention is deliberate: an old model-visible locator goes stale only once it ages past the cutoff.

`saveText` rejects on a real storage failure (permissions, ENOSPC); the spill policy treats a rejection as best-effort and keeps the inline result. See the seam README for the vocabulary and the [tool output spill Agent Note](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md) for the design, and the [startup-cleanup Agent Note](../../../.agents/notes/implemented/architecture/2026-07-17-local-spill-startup-cleanup.md) for the sweep.

## Model Experience

Indirectly, through spill consumers that render the local path and `read`/`grep` retrieval guidance.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **A long-lived deployment is not swept until restart** — the one-shot sweep runs once after activation, so files that age past `cleanupPeriodDays` mid-run are reclaimed only on the next start; there is no recurring timer.
- **Locators require a co-located filesystem consumer** — a remote or virtual deployment needs another `SpillStore` backend whose locator and retrieval hint are meaningful there.
