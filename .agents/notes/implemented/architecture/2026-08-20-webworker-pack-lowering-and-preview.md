# Agent Note: pack-time lowering and the single-build preview

Status: implemented

English | [中文](2026-08-20-webworker-pack-lowering-and-preview.zh.md)

## Problem

The browser worker can neither compile modules at load nor be served by the product webserver: every module body must arrive runnable, and the page must be a static artifact. Both surfaces drifted early. The loader carried a fallback compiler, so a collector gap surfaced as a slow boot instead of a broken image — and `acorn` rode into `lib/worker.js` through the package barrel, a parser a runtime that only wraps pre-lowered bodies never needs. The preview was a second HTML template beside the served one, a page the served index could silently drift away from.

## Decision

**Lowering happens at pack time only.** `@deepseek-ai/dsh-experimental-webworker-packer` composes the profile, materializes the closure, and lowers every JavaScript body; `LOWERING_VERSION` and `WRAPPER_PARAMS` are the pack↔worker contract and live in `src/image-layout.ts` beside the rest of the image layout. The loader wraps bodies exactly as the image holds them: a body still carrying module syntax is a refusal naming the image, and `startWorkerHost` requires the manifest's `lowered` to equal this build's contract before it mounts a single module. `lowerModuleSource` is the transform's only face and the packer its only caller; inside the worker graph, imports name the module that owns the value — never the package barrel, which is the edge that smuggled the parser in.

**The preview is the served page plus one tag.** One Vite build emits `dist/index.html` and `dist/preview.html` sharing every chunk; the only difference is a prepended bootstrap entry whose module connects the worker host. Startup then converges on one protocol: whichever side applies the injection table settles the `__DSH_BOOT_READY__` deferred — the served renderer resolves it in a tail script after the rendered rows, the worker bootstrap installs it before its first await and settles it after the last row — and the client entry awaits it before reading any injected state, so the chain from the stock entry onward is the served chain verbatim. The build uses a relative base so the output mounts under any static directory; the served form anchors deep SPA-fallback paths by rendering `<base href="/">` at serve time, keeping the on-disk pages byte-shared.

Both packages live in `packages/experimental/` as `@deepseek-ai/dsh-experimental-*`, private and outside official releases. The boundary that carries product promises stays in the product packages: the injection table, `__DSH_TRANSPORT__`, and the `/plugins` bundle bytes are owned by `dsh-host-webserver`, `dsh-client-modules`, and `dsh-client-connection`.

## Alternatives considered

**A load-time transform as a safety net.** It turned a broken image into a timing regression nobody attributed, and made "which path lowered this body" unanswerable from outside.

**Contract constants inside the transform, trusting tree shaking.** The transform functions did shake out, but `acorn` declares no `sideEffects`, so the barrel edge alone carried the whole parser into the worker bundle.

**A separate preview template.** The retired `preview.html` template duplicated the served document and drifted (language, title, entry wiring). Deriving the page from the built index at `closeBundle` removes the second document entirely.

**Gating the stock entry on top-level await ordering instead of a deferred.** Sibling module scripts do not wait for one another's top-level awaits; the `??=`-installed deferred makes the handshake order-independent and lets a failed handshake reject into the boot page's failure rendering.

## Consequences

- `lib/worker.js` contains no parser (423.5 kB → 246.3 kB at the time of the cut, before the shell process layer landed).
- `diff dist/index.html dist/preview.html` is exactly one script tag; `packages/experimental/webworker-packer/tests/image-loadable.spec.ts` pins both halves of the loader contract, and `apps/web/tests/preview-boot.e2e.ts` pins preview usability (boot to an interactive page) in the web browser lane, replacing the retired `apps/web/scripts/preview/` probe scripts.
- The served `<base href="/">` anchor exists because relative asset URLs would resolve under the request directory on SPA-fallback paths; remove it only together with the relative build base.
- The image ships as a deterministically gzip-compressed tar (`vfs-image.tar.gz`; MTIME 0, OS byte 0xff): static hosts do not compress binary content types (type allowlists, CDN size caps), so the compression rides the artifact, and the worker inflates the fetch body through the browser's native `DecompressionStream` while it downloads.
