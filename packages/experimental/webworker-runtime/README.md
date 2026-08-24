# `@deepseek-ai/dsh-experimental-webworker-runtime`

English | [中文](README.zh.md)

The browser worker host: the whole harness plugin tree runs inside one dedicated Web Worker, for preview deployments and packaging regressions ([experimental stance](../../../.agents/notes/implemented/architecture/2026-08-20-webworker-pack-lowering-and-preview.md)). The worker inflates a packed VFS image off its download and mounts it in memory, loads its modules through a CommonJS wrapper loader, and serves the page over a postMessage tunnel that speaks plain HTTP.

Three artifacts from one tsdown pipeline:

- **`lib/index.js` (assembly library)** — `createWorkerHost`/`startWorkerHost` mount the image (`storage/`), install the module loader (`module-system/`) and the `process` shim, boot the tree through the image's own `dsh-app-boot`, and hand the tunnel its serving seams. The image layout contract (`image-layout.ts`: virtual root, config/manifest paths, empty directories, the `lowered` wrapper-contract gate) is shared with the packer. Boot patches force the deployment-shaped rows: frontend serving off, JSONL session logs on the plaintext path, preset roots onto the image's `config/agent-presets`.
- **`lib/worker.js` (worker bundle)** — the assembly plus this package's Node-compatibility layer as one self-contained ES module. The module proxy table (`module-proxies.ts`) is the only platform fork: `node:*` builtins over VFS/tunnel/browser primitives, structural stubs that fail loud on the console for what a browser cannot do, and replaced externals. AsyncLocalStorage carries sync-stack causality across `await` through the snapshot/restore faces the pack-time lowering injects. The worker holds no compiler: an image the packer did not lower is refused at mount ([note](../../../.agents/notes/implemented/architecture/2026-08-20-webworker-pack-lowering-and-preview.md)).
- **`src/shell/` (the worker's own process layer)** — a browser worker cannot fork, so `node:child_process` is not a stub but an implementation: `spawn` starts the command in its own Web Worker — this same bundle, told by its first frame to be a shell process — and reports it through the `ChildProcess` surface the subprocess service consumes. The command runs off the host's thread, `SIGKILL` terminates it whatever it is doing, and it reaches the VFS only by message (the host serves those frames). The grammar is `@yarnpkg/parsers`' `parseShell`; this package owns the evaluator (pipelines, `&&`/`||`, subshells, redirections, expansion, globs) and the command table, which is the only `/bin` that exists — a name it does not hold reports `command not found`, and `execSync`/`fork` still refuse, because they need a real process.
- **`lib/client.js` (page half)** — `connectWorkerHost(worker, { image? })` completes the pre-Cordis handshake: the opening `init` frame carries the image URL (the one deployment-shaped input), the boot payload delivers the structured index-injection table, and `applyIndexInjections` executes it before the shell entry runs. The tunnel exposes fetch-shaped transport, the API client, and `loadBundle` for the shell's boot seam.

Acceptance lives in `apps/web/tests/preview-boot.e2e.ts`, which serves the real built pages and drives the worker boot in headless Chromium.

## Model Experience

None, as this package only hosts the tree in a browser worker and answers its `node:*` calls; every model-facing registration belongs to the plugins it boots.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The worker composition writes plaintext session logs** (`compression: 'none'` boot patch): it carries no Zstandard codec, so exported logs are `.jsonl`, never `.jsonl.zstd`.
- **The skill catalog is never cached in the worker** — `skill-filesystem` watches its roots through `node:fs.watchFile`, which this package refuses, so every discovery pass returns an incomplete observation and re-scans. Discovery itself stays correct; the cost is a re-scan on every pass.
- **`node:vm`, `node:net`, `node:sqlite`, `node:worker_threads` are structural stubs**: every call reports its refusal on the console and throws. Rows needing a real process or realm isolation cannot run here.
- **The bash tool runs only under `danger-full-access`**: a browser has no kernel to confine a command with, so `ctx.sandbox.confine` fails loud in every other permission preset and the command never starts. The mode is the deployment's own user-facing switch, not a worker-specific composition.
- **The worker bundle pins a path inside `@yarnpkg/parsers`** — the build resolves the package's own `lib/shell.js` instead of its root, whose barrel also re-exports the Syml parser and so drags js-yaml into a bundle that never parses that format (around 175 kB, plus its module body at worker start). The path is derived from the package manifest, so a layout change fails the build rather than reinstating the barrel; upgrading the dependency means re-checking that the shell parser still lives there.
- **The shell is not bash**: no loops, functions, `case`, job control, or process substitution — the grammar stops at pipelines, `&&`/`||`, subshells, groups, redirections, and expansion. `&` runs its command to completion in place, `sed` accepts only substitution scripts, patterns are JavaScript regular expressions, and the command table holds coreutils only (no `git`, no network tools).
- **A shell process has no synchronous filesystem**: it reads and writes the host's VFS by message, because blocking on a reply would need `SharedArrayBuffer`, which requires a cross-origin isolation GitHub Pages cannot grant. Directory-walking commands therefore cost one round trip per entry, and two concurrent commands can interleave their writes.
- **Transport, worker-host, and page-half coverage needs a browser-grade harness** — the per-file coverage gate is unmet for those modules; unit specs cover storage, ALS, the transform, and the stub contracts.
