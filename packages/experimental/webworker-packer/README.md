# `@deepseek-ai/dsh-experimental-webworker-packer`

English | [中文](README.zh.md)

The VFS image packer: turns one composed profile into the single gzip-compressed tar the browser worker inflates and mounts as its filesystem ([experimental stance](../../../.agents/notes/implemented/architecture/2026-08-20-webworker-pack-lowering-and-preview.md)). Nothing is compiled from source — the image carries the repository's real build products, so a preview deployment debugs exactly what the served deployment ships.

The pack is a three-layer standard stack:

1. **Roster** — the composed profile's plugin rows (standard YAML parse under Include's dialect, `!!js` intact), plus the rows of every config tree the CLI declares in its `package.json` `dsh.configTrees` (agent presets), materialized as a Node-style dependency closure. External peer edges never bind the worker; workspace peers stay on the chain.
2. **Publish view** — each workspace package contributes the slice npm would publish (`files` through picomatch) minus the rule tables in `src/rules.ts` (no sources, no workspace `dist/`; external packages keep their trees minus the same exclude globs).
3. **Reachability sweep** — the runtime loader's own resolution walks from every workspace export face plus the worker assembly's seeds (`IMAGE_ENTRY_SEEDS`), lowering each reached module to the wrapper contract at pack time. Page assets (`lib/client.js` behind `./client` exports) ship verbatim; an unresolvable request from our own code fails the pack, third-party ones are tolerated to fail loud at require time.

`repository.ts` owns the repo-shaped inputs (workspace scan of `vendor/`, `packages/`, `apps/`; profile composition through the real CLI dump path); `pack.ts` owns none of them, so the same library packs a different tree by being called differently. The CLI is `dsh-pack-vfs-image --out <file> [--profile web]`; `apps/web`'s `build:preview` runs it after the preview shell build.

## Model Experience

None, as this package runs at build time and writes an image file; nothing it produces reaches a model request on its own.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The rule tables are judgement calls** (`rules.ts`: exclude globs, page-asset patterns, entry seeds) pinned by `tests/`; a new asset class the worker must reach needs a table row, not a scanner change.
- **Vendored package sources (`src/*.ts`) are excluded** — nothing resolves them at runtime; a future in-worker source-inspection feature would need a dedicated include rule.
- **The packer assumes built `lib/` artifacts are current**: it never compiles, so a stale workspace build packs stale bytes. Run the repository build first.
