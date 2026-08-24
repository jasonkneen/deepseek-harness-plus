# @deepseek-ai/dsh-client-connection

English | [中文](README.zh.md)

Protocol and connection-generation layer. The Client plugin mounts `ctx.connection`, containing the shared API client, current-page loopback state, generation-scoped observable `hostDescription`, a generic RPC carrier, and the registration point for one generation source and the connection loop. A generation publishes `hostDescription` and calls `onConnected` only after its source is ready and `host.describe` succeeds; source completion, failure, withdrawal, or an explicit stop clears that value before `ConnectionController` reconnects with backoff.

The browser uses HTTP POST for API Proxy and generic Remote unary calls. API Gateway owns the `/api/remote.mux` WebSocket and its logical streams; in-process compositions provide equivalent Remote streams through `connection.rpc.open` without opening a WebSocket. The Host half owns the sole `/api` route, Fetch bridge, and trust checks. Typert Gateway claims its Remote endpoints first, and unclaimed requests fall through to API Proxy. Loopback hostname classification remains package-internal: the Host fence and WebSocket upgrade use it directly, while other Client plugins consume `ctx.connection.isLoopback`.

The Node half keeps privileged methods (`host.pickDirectory`, `host.openPath`, the settings and credentials configuration planes, `llm.discoverModels`, and `agentPreset.read`/`copy`/`openDocument`/`remove`) loopback-only by passing an empty trust list to the fence. `agentPreset.list` and `agentPreset.select` are excluded: the roster carries only ids and trust levels, while `session.create` already selects a preset. Declared `trustedHosts` authorities can reach other methods; privileged operations remain loopback-only until a real authentication layer exists.

## /api browser-trust fence

The node half guards every entry under `/api` before bridging or upgrading (`src/api-request-trust.ts`). Every request — browser-marked or not — must present a `Host` that is a loopback authority or matches a `trustedHosts` entry: exact on `host:port` entries, any port on port-less entries, both sides compared through WHATWG normalization (DNS-rebinding defense). There is deliberately no shortcut for unmarked HTTP requests: over plain HTTP a browser attaches neither `Origin` nor Fetch-Metadata to image and navigation reads, so an unmarked request may still be a rebound browser read with a readable response, and Host is the one header rebinding cannot forge; a browser WebSocket handshake carries `Origin` and passes the same comparison. Non-browser clients pass the same fence via loopback, deployment-derived LAN IP literals, or a declared authority. When markers are present, an attached `Origin` must equal the Host authority, and an explicit `sec-fetch-site: cross-site` marker is refused. A `trustedHosts` entry that is not a bare, canonical `host[:port]` authority — one WHATWG parsing reads back exactly as written — fails the plugin load loudly: parsing would otherwise quietly authorize the hostname inside `harness.internal/path`, or broaden a dangling-colon or zero-padded port to an any-port grant. HTTP failures answer plain 403 before any RPC dispatch; upgrade failures reject the handshake before any event stream starts. Non-loopback compositions must trust their serving authorities explicitly: the Web runtime derives LAN IP literals from an all-interfaces server config, while `trustedHosts` in cordis.yml and the CLI's `--trusted-host` flag declare named authorities. `dsh web --host 0.0.0.0` is intentionally unsupported until remote access has an authentication layer. The fence is a reachability policy, not authentication; the Web carrier provides no authentication layer. Decision record: [the api browser-trust boundary Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md).

## Connection generation

API Gateway Client registers the internal `$events` logical stream as the sole generation source, independently of whether any `$on` listener exists. The Host attaches all incremental listeners in the API Remotes source factory, then sends one `{ type: 'ready' }` item before events. `ConnectionController` waits for that item and `host.describe` in parallel; `onConnected` cannot start baseline reads until both succeed, so baseline acquisition cannot race ahead of incremental observation.

An ended `$events` stream, a Remote stream error, a non-ready opening item, or a malformed event item invalidates the current generation. The controller immediately withdraws `hostDescription`, publishes `reconnecting`, and rebuilds the `$events` plus `host.describe` handshake after backoff. Gateway mux reconnects the physical WebSocket; Connection generation reopens the logical stream and establishes the next baseline starting point.

## Model Experience

None, as the wire consumer layer moves already-composed messages between browser and host; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The `/api` bridge buffers each request body in memory** — `maxRequestBodyBytes` (default 300 MiB, sized for the default 200 MiB aggregate image limit after base64 expansion plus envelope headroom) is therefore also the per-request resident bound; a streaming body path would be needed to lower it without shrinking the image limits.
