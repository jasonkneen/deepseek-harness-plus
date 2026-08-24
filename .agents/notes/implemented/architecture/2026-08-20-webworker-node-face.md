# Agent Note: the worker's Node face — builtins, VFS, and the shell process layer

Status: implemented

English | [中文](2026-08-20-webworker-node-face.zh.md)

## Problem

The worker runs the web profile's Cordis configuration byte for byte — no worker-specific rows — so a browser's missing platform must be replaced at the module layer, where a proxied module keeps its identity and changes its implementation. That covers three fronts: the Node builtins the tree imports, the filesystem those builtins answer from, and a process layer for the bash tool, which mounted, advertised itself to the model, and then failed on every call while `node:child_process` was a structural stub.

## Decision

**Builtins.** The proxy table replaces Node builtins and external npm packages, never workspace or vendored modules. `./implemented/<module>.ts` carries real semantics over a worker data source; `./mock/<module>.ts` mounts silently and reports the missing capability when a call reaches it. The loader's table holds one memoized thunk per specifier — evaluation happens at first `require`, not at assembly — and each shim's exported face typechecks against Node's own module type, with the narrow, documented exceptions where structural identity (a real class) cannot be satisfied. The worker installs the `process` global itself and fills it into the table at assembly.

**VFS.** Memory is the truth. `statSync(path, { bigint: true })` returns Node's BigInt shape, and two fields carry real information because `dsh-fs-local`'s stale-write guard depends on them: `ino` is per-path identity from a monotonic counter (a recreated path reports a new identity), and `mtimeMs` is strictly increasing per entry (`max(now, previous + 1)`), because in-memory writes routinely land in one millisecond and an equal timestamp would let a stale overwrite pass. The hunt that produced this also fixed the silence around it: cordis's logger verbosity counts UP, so an exporter that declares no level drops every warning — `startWorkerHost` installs a console exporter with `levels: { default: 2 }` before any entry mounts.

**Shell.** `node:child_process` is a real implementation over the VFS. The grammar is bought — `@yarnpkg/parsers`' `parseShell` — and the evaluator and command table are owned, because every candidate interpreter brings its own filesystem: pipelines are strings handed along, and each program is a function over the VFS. The table is the machine's whole `/bin`; an absent name reports `command not found` (127). Each `spawn` starts a child Web Worker from this same bundle, its first frame declaring the shell-process role, so the termination ladder is real: `SIGTERM` asks at the next command boundary, `SIGKILL` terminates the worker mid-loop — the preemption an in-thread interpreter can never have. The filesystem face is asynchronous end to end (child frames to the host VFS); `execSync`, `execFileSync`, and `fork` refuse, and `node-pty` stays a stub.

## Alternatives considered

**Replacing `dsh-subprocess-local` or the bash executor.** The first would let the proxy table replace a workspace package against its own classification and invert the layering; the second trips `dsh-permission-presets`' boot-time `sandboxMode` validation and drops tested timeout/output behavior.

**`@yarnpkg/shell`, WASM shells, WebContainer.** The matching interpreter is built on real Node streams (~1.5 MB closure to own); WASM was removed from this deployment by decision and WASI has no `fork`; all of them arrive with their own filesystem, the one part that cannot be reused.

**`SharedArrayBuffer` + `Atomics.wait` for a synchronous child filesystem.** Measured on the deployment target: without COOP/COEP headers `SharedArrayBuffer` is not defined, and GitHub Pages cannot set response headers. The asynchronous face is a superset; a SAB backend can slot under it later without touching a program.

**Fabricating stats or widening error predicates instead of honoring `bigint`.** Constant `ino`/wall-clock `mtimeNs` silently disable the stale-write guard; swallowing `FS_IO_ERROR` in skill discovery would have made the same bug a permanently empty catalog with no failure anywhere.

## Consequences

- Sandbox modes other than `danger-full-access` fail loud: `SandboxEnforcement` has no "nothing was enforced" value and a browser has no kernel, so `ctx.sandbox.confine` fails closed and the command never starts. Real enforcement at the VFS frame gate is a designed follow-up, not this note.
- The Node-host ladder test (`tests/node/child-process.spec.ts`) is registered windows-unsupported: the ladder's win32 kill rung is taskkill-by-real-pid, undeliverable to a process-table pid, while the worker itself always reports `linux`.
- Output is incremental but not streamed: programs write into sinks forwarded as `data` events, and a pipeline stage completes before the next starts.
- The runtime's tests mirror `src/` (`tests/node/`, `tests/shell/`, `tests/storage/`, …), so each shim family owns its behavior cases beside the oracle-diff suites.
