# @deepseek-ai/dsh-sdk-python-runtime

English | [中文](README.zh.md)

Private direct-config carrier for the temporarily unchanged Python SDK runtime. Its [`jsonrpc`](../server/README.md) entry serves SDK clients over newline-delimited stdio, while an external `cordis.yml` composes the spine, backends, and serving plugin. This npm package exposes no public bin and is not published; the Python SDK's existing `dsh-jsonrpc-agent-pkg-<platform>-<arch>` [single-executable runtime](../../../.agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md) packages `lib/packaged-bin.js` from the closed deploy tree. Bare plugins resolve from that tree, while relative plugins remain configuration-relative.

## Config discovery

The first non-empty channel wins: `$DSH_CORDIS_CONFIG`, then positional `argv[2]`. If neither names an existing file, the packaged entry prints one-line usage to stderr and exits 1; there is no working-directory or built-in fallback. [`dsh-app-boot`](../../boot/app-boot/README.md) makes plugin load failures fatal. This protocol does not use `DSH_SNAPSHOT`.

A config without `dsh-sdk-jsonrpc-server` is valid and serves nothing; the carrier does not designate a server plugin.

## Exit lifecycle

stdin EOF and `SIGTERM` dispose the root to quiescence and exit 0; `SIGINT` exits 130 after the same disposal. EOF may cut off an in-flight turn as documented in the [distribution Agent Note](../../../.agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md). The `jsonrpc` plugin owns response-before-exit protocol shutdown; both paths are idempotent and safe to race.

## stdout is the protocol

stdout carries only JSON-RPC frames. The carrier and boot guards diagnose on stderr, and the config must omit stdout loggers.

## Model Experience

Indirectly, through the plugins loaded from the external `cordis.yml`, which own every model-bound prompt, schema, message, and result; this carrier adds none of its own.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Temporary direct-config exception** — this private carrier remains outside `dsh --profile sdk` only to preserve the current Python executable and wheel behavior; the later Python runtime migration deletes it and then renames the executable family.
- **The carrier cannot prove that the config serves JSON-RPC** — a valid config with no `dsh-sdk-jsonrpc-server` entry boots successfully and serves nothing.
- **No built-in or default config exists** — every launch must provide `DSH_CORDIS_CONFIG` or a positional path, and deployment owns the complete plugin tree and stdout discipline.
- **stdin EOF cuts off in-flight work** — client disappearance disposes the root immediately; callers that need orderly completion use the protocol-level `shutdown` request.
