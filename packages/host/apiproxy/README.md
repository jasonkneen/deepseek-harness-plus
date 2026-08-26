---
description: "The shared API gateway for web GUI host clients: the browser-safe API contract, the fetch carriers, and the host-side gateway service every client shape uses."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-apiproxy

English | [中文](README.zh.md)

## Summary

Every client of the web GUI host calls one typed API through `dsh-host-apiproxy` — sessions and history, workspaces, directory picking, model selection, agent presets, skills, goals, settings, credentials, LLM catalogs, events, and session export — moved over HTTP or in-process by fetch carriers. The contract layer has zero Node dependencies and imports from the browser, so one typed API serves the Web server, Electron, and any future client shape. The shipped Web composition assembles the gateway in [`dsh-web-app`](../../bundle/web-app/README.md). Choosing a carrier, calling the domain APIs, and configuring the gateway come first; the wire protocol internals live in a collapsible developer section below.

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

Compose the gateway when a client of the GUI host needs the session, workspace, and configuration APIs: load `ApiProxyService`, wrap `ctx.apiProxy` in a carrier, and call the typed domain methods.

### Choosing a carrier

`toFetchHandler(api)` turns the gateway into a pure WHATWG fetch function for an HTTP server (the shipped Web composition exposes it behind `/api/…` routes), while `InProcessApiClient` runs the same serialization and validation path in-process — the isomorphic point for callers and tests that need the full wire path without a network.

```text
const client = new InProcessApiClient(toFetchHandler(ctx.apiProxy))
const response = await client.sessions.list({})
```

The HTTP carrier refuses non-JSON POST bodies with 415 before dispatch, so cross-site simple requests can never run a side-effectful method blind. The browser carrier applies the same Host/Origin checks and signed-cookie authentication to every Host API method ([`dsh-client-connection`](../../client/connection/README.md)); individual Client features may still withhold native or persistent operations on non-loopback pages.

### What the gateway exposes

The API is grouped into domains: `sessions` (list, create, history, prompt, cancel, queue, models, selectModel, rename, fork, search, attachment), `workspace`, `host` (describe, pickDirectory, listDirectory, createDirectory, openPath), `skills`, `agentPresets`, `goals`, `settings`, `credentials`, `llm`, `events`, and `downloads`. The sessions, workspace, and events contracts are owned by the Session Controller, Workspace Controller, and API Remotes packages respectively; the remaining domain contracts and the `RpcMethodMap` live in `src/api/`.

### Sessions and history

`session.history` pages a session's appended message stream (`maxMessages` counts append-origin `user/message` and `assistant/message` events, so model-only replacement copies consume no quota) and keeps each page a contiguous raw event range, which keeps a compaction's log-only summary on the same page as the replacement that cites it. The tail page optionally carries a `projections` block — the watermark snapshot of every registered projection unit — while the gateway pushes live `session/projection` frames for units whose state changed. `session.search` is a bounded content-search projection over the sessions visible through `session.list`: at most 20 hits, snippets of at most 240 code points, and every hit revalidated against the visible set.

### Workspaces and the session list

`session.list` and `workspace.list` are separate reconnect baselines. Blank sessions stay hidden until the first turn, archiving hides a session from grouping surfaces without touching its log, and registration deletion preserves the directory and session logs. Cold summaries verify blankness by probing a small eligible artifact; a projection-cache miss or stale hint falls back to `createdAt`, so a recently worked large session may sort lower until the next checkpoint.

### Exporting sessions

`GET /api/session.export?sessionId=…&includeDescendants=true` streams a ZIP of the session's stored artifact text verbatim, every subagent descendant under `subagents/<id>/`, and each referenced image under `media/<attachmentId>.<ext>`. `HEAD` runs the same root preparation without a body, so browsers detect pre-stream failures before handing the GET to the download manager. The response is chunked as it is produced, and `sessionExportCompressionLevel` (0–9, default 6) trades CPU and latency against archive size. Missing persistence, session-query, or attachment services answer 500, a backend without per-session raw artifacts 501, and a missing root session 404.

### Model selection, presets, commands, and configuration

`session.models` reports the current `ModelSelection` separately from provider-grouped advisory models, and `session.selectModel` saves an accepted switch as the deployment default through the shared `agent-default-model` settings section — a default naming an unavailable provider still reaches the selector as `current` instead of being silently replaced. Each access resolves an in-process selection first, then the session's latest `request/header`, then the deployment default. A logged reasoning effort marked as an adapter default remains absent from the restored selection, so the next resolution does not promote it into an explicit choice or record a false header change. `agentPreset.list` exposes the deployment's preset roster with each row's `trust` and a `broken` reason when a preset cannot compose a session; `agentPreset.select` swaps a blank session's composition and is refused once a turn has run. `skill.list` serves the composer menu with each skill's `modelInvocable` flag, and `command.execute` runs a slash command with pure admission semantics whose outcome rides the logged `command/run`/`command/done` pair. The `settings.*`, `credentials.*`, and `llm.*` domains are the configuration-page wire: `settings.describe` returns each namespace's schema and redacted layered values, `settings.mutate` is the removal path for a client holding the redacted view, secrets never ride any response, and `llm.discoverModels` interrogates a provider endpoint the page is still drafting without writing anything.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `nativeOpen` | platform-detected | Whether the deployment can hand paths to a native desktop opener |
| `sessionExportCompressionLevel` | `6` | DEFLATE level for every session-log ZIP entry, 0–9 |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-host-apiproxy) is the exhaustive source for every accepted field and its JSDoc.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The package is built on one separation: the API contract is channel-independent, and physical transports are carriers around it. Wire messages form a two-member discriminated union — `ClientRequest` (the POST `/api/<method>` body) and `ServerResponse` (that POST's response body) — decoupled from the physical channel. Responses always echo the matching request's `rpcId` and never mint a new one. Business errors ride the `RpcResult` error branch with a closed `RpcErrorDetailsMap`; HTTP status expresses only the carrier. The layering and protocol decisions are recorded in the [GUI layering and RPC protocol RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md).

### Source map

| File | Role |
|---|---|
| [`src/api/`](src/api/) | Contract layer: domain interfaces, payload types, zod schemas, `RpcMethodMap` — zero Node dependencies |
| [`src/fetch/handler.ts`](src/fetch/handler.ts) | Host carrier: `toFetchHandler`, envelope parsing, unary dispatch, session export |
| [`src/fetch/client.ts`](src/fetch/client.ts) | Client carrier: `AbstractApiClient` plus platform subclasses, `InProcessApiClient` |
| [`src/api-proxy.ts`](src/api-proxy.ts) | Gateway implementation: `createApiProxy` over the composed host context |
| [`src/session-export.ts`](src/session-export.ts) | Session-log ZIP export: raw artifact reads, media collection, fflate streaming |
| [`src/native-path-opener.ts`](src/native-path-opener.ts) | Platform opener for paths (`open`/`Invoke-Item`/`xdg-open`, WSL translation) |

### The gateway service

`ApiProxyService` provides `ctx.apiProxy` and implements the contract over the composed host context — sessions, workspace registry, directory picker, agent presets, settings, credentials, LLM, events, and downloads. The Host cwd is the default project directory. The gateway consumes `ctx.agentDefaultModel` only for the deployment metadata `host.describe` reports; `session.selectModel` (Session Controller) saves an accepted switch as the deployment default through the shared agent-default-model settings section. Product `dsh --profile headless` is a direct core entry point and does not mount this package.

### Request flow

A request enters a carrier, which parses the envelope and the business payload in two levels, dispatches per method, and returns a response echoing the request's `rpcId`. Server pushes — the session and workspace follow streams — ride the API Gateway's `/api/remote.mux` WebSocket and deliver `opened` then gap-free `event` frames the client decodes. Unary requests carry the carrier's abort signal, so caller/connection cancellation propagates to the underlying work.

### What the gateway owns

The gateway is the wire contract plus a host-side projection over services owned elsewhere: it emits no cordis events, and the session/agent event streams it projects are asserted by their owning packages' companions. The carrier holds no other domain's knowledge — each projection value already passed its unit's own schema inside the registry.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the package-level contract is not enough. They move from the layering decision to the browser-side consumption architecture and the adjacent subsystems.

- [GUI layering and RPC protocol RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md) — the layering model and the channel-independent message protocol.
- [Web client architecture RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how the browser consumes the API.
- [Browser HTTP carrier](../../client/connection/README.md) — Host/Origin checks, signed-cookie authentication, and the routes the shipped Web composition registers.
- [Web-server subsystem](../../../docs/subsystems/web-server.md) — the HTTP server the carrier rides on.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-host-apiproxy) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

None, as the wire contract and fetch carriers move already-composed messages and register nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the gateway is a poor fit; they are current package constraints, not a task backlog.

- **Forwarded Remote events ride the gateway stream framing** — the delivery path reuses the API Gateway's Remote stream mux instead of opening a third downlink, which reads as if this package owned the Remote event contract. It does not: the allowlist belongs to `dsh-api-remotes` and the consumer verb is `ctx.remote.$on` ([rationale](../../../.agents/notes/implemented/architecture/2026-08-10-remote-event-delivery.md)).
- **Pending-interaction state is host-side** — the browser's pending-interaction snapshot folds plugin-registered pending domains (user questions and approvals); the wire defines no dedicated respond route and no `RpcReceipt` type.
- **Reserved seams stay out of `RpcMethodMap`** — `prompt.mode: 'inject'`, `job.list`, and a describe `hostInstanceId` are documented reservations; model discovery uses `llm.models`. An unknown method fails loud at envelope parse rather than getting a not-implemented code.
- **No protocol version field** — client and host ship together; `host.describe` gains a version negotiation field only when an independently released client exists.
- **Search failures include provider diagnostics** — the gateway is a single-user local service; a carrier that exposes it to multiple users must replace internal search details with a public-safe diagnostic.
- **Linux native picker requires desktop tooling** — under the `native` capability, `host.pickDirectory` reports an actionable error when neither Zenity nor KDialog is installed; the browse backend is the composition-level fallback (see the [native backend README](../directory-picker-native/README.md)).
- **Cold-list hints degrade only toward visibility and older ordering** — a projection-cache miss or stale `lastPromptAt` falls back to `createdAt` unless an eligible small artifact supplies an exact fold. The [bounded blank-verification decision](../../../.agents/notes/implemented/bug-fix/2026-08-13-bounded-cold-blank-verification.md) owns this safety direction; an authoritative exact recency index remains scoped in the [last-activity-index proposal](../../../.agents/notes/proposed/architecture/2026-07-29-durable-last-activity-index.md).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above. A protocol version field waits for an independently released client; a multi-user carrier must replace provider search diagnostics with public-safe text; per-connection picker adaptivity (native for a local browser, browse for a remote one) remains an undecided direction for the host surface.

</details>
