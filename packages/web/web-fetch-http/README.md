# @deepseek-ai/dsh-web-fetch-http

English | [中文](README.zh.md)

An anonymous public HTTP(S) `WebFetchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It retrieves a concrete URL and returns a status code plus bounded decoded content.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the key and it does not register a model-facing tool. It is a function/namespace plugin (`inject: ['web']`).

## Responsibility split

The provider owns **safe resource retrieval**: URL validation, public-address resolution and connection pinning, HTTP transport, redirect policy, a resource-backstop timeout, abort propagation, byte caps, charset decoding, content-type classification, and binary rejection. `@deepseek-ai/dsh-tool-web` owns **presentation** (HTML→markdown, truncation formatting). A non-2xx HTTP response is a *result* (status code + decoded body), not an error; `WebError` is reserved for failures to safely retrieve or represent the resource.

The provider's `timeoutMs` is a resource backstop for direct `ctx.web.fetch()` callers and misconfigured deployments, not the model-facing tool-call budget. [`dsh-tool-call-timeout-policy`](../../guard/timeout-policy/README.md) owns the `web_fetch` tool-call budget by arming `exec.signal`.

A shipping web-tool deployment sets the provider backstop above the tool budget, so model calls normally return `TOOL_TIMEOUT`. If the outer deadline reaches the provider first, the provider reports `WEB_ABORTED` and the outer policy replaces it with `TOOL_TIMEOUT`. `WEB_FETCH_TIMEOUT` therefore identifies a direct service caller whose provider budget elapsed.

## Transport hygiene

- Accepts only `http:` and `https:` URLs; rejects credentials in URLs (`WEB_BLOCKED_URL`) and URLs over the fixed 2,048-character security limit or otherwise malformed (`WEB_INVALID_URL`).
- Resolves each hostname once, rejects the complete answer set if any IPv4 or IPv6 destination is not public unicast (`WEB_BLOCKED_URL`), and pins the connection to that validated set. For IPv6 answers it discovers the active DNS64 prefix through `ipv4only.arpa` and rejects NAT64 translations to non-public IPv4. This blocks loopback, private, link-local, carrier-grade NAT, multicast, reserved, transition, translation, and private IPv4-mapped IPv6 destinations without resolving the target hostname twice.
- Enforces the URL limit, response byte cap (`WEB_FETCH_TOO_LARGE`), decoded body character cap, timeout (`WEB_FETCH_TIMEOUT`), and redirect hop cap.
- Propagates the caller's abort signal (`WEB_ABORTED`) into the network request and the streaming read.
- Follows only **same-origin** redirects; each followed hop repeats public-address resolution and pinning, while a cross-origin redirect fails with `WEB_REDIRECT_BLOCKED` and requires a fresh tool call (the model of Claude Code's WebFetch).
- Sends an explicit product `User-Agent`, never a browser disguise.
- Rejects unsupported (e.g. binary) content types with `WEB_UNSUPPORTED_CONTENT_TYPE`.

Direct `HttpFetchProvider` construction may inject an `HttpFetchResolver` for alternate trusted assemblies and deterministic tests. That resolver must reject every non-public destination before returning addresses; the shipped plugin always uses the built-in public-address resolver.

## Config

| Key | Default | Meaning |
|---|---|---|
| `maxResponseBytes` | `5_000_000` | Maximum response body size in bytes. |
| `maxBodyChars` | `100_000` | Maximum decoded body length in characters. |
| `timeoutMs` | `30_000` | Fetch timeout within Node's timer range — a resource backstop for direct `ctx.web.fetch()` callers, not the model-facing tool-call budget (that is `dsh-tool-call-timeout-policy`). |
| `maxRedirects` | `5` | Maximum same-origin redirect hops (`0` follows none). |
| `userAgent` | `deepseek-harness/…` | `User-Agent` header. |

The configurable numeric limits are validated at plugin construction: every cap except `maxRedirects` must be a positive finite number, and `maxRedirects` must be a non-negative integer. An invalid value throws rather than silently constructing a provider with nonsensical limits.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which places this provider's `maxBodyChars`-bounded decoded text or markdown-shaped HTML under its fetch-result wrapper and retains provider failures while redirects, headers, and transport mechanics remain hidden.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Only textual content decodes** — html/xhtml and `text/*`-plus-JSON/XML families; a missing `Content-Type` or any binary type throws `WEB_UNSUPPORTED_CONTENT_TYPE`, and text-extractable PDF decoding is named deferred work.
- **Charset comes only from the `Content-Type` header** (UTF-8 default) — an HTML `<meta charset>` declaration is ignored, and a declared-but-unrecognized charset label throws rather than falling back.
