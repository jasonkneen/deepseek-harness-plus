---
description: "Web Session-log export for users of the Web bundle: the Session Header download button and /export command, and what to expect from the download dialog."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-log-export

English | [中文](README.zh.md)

## Summary

`dsh-session-log-export` gives the Web interface a way to download a session's full history: a `Session log` button in the Session Header and an `/export` slash command both hand the session tree — the session, its sub-sessions, and attachments — to the browser as a ZIP download. A small dialog reports preparation, download start, or failure, shared by the button and the command. The ZIP is built and streamed by `dsh-host-apiproxy`; this package adds only the browser-side button and command. The download is a browser download: the browser chooses the destination. Setup and usage come first; the implementation internals live in a collapsible developer section below.

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

Use this package when the Web bundle should let users export a session log. It is mounted only by the Web bundle, beside the host API proxy, the command registry, and the conversation UI. The common path is: mount the plugin, then click `Session log` in the Session Header or type `/export` — the browser downloads `dsh-session-<id>.zip`.

### When to choose it

Choose it for a Web deployment that needs user-facing session export with a visible download dialog. Avoid it when a programmatic or Host-side export is needed: this package produces a browser download, not a Host path write, and it requires a persistence backend that stores a per-session raw artifact (the shipped JSONL backend supports plaintext and zstd; SQLite export is not supported).

### Composition

```yaml
- id: session-log-download
  name: '@deepseek-ai/dsh-session-log-export'
```

The Web bundle mounts the package beside `dsh-host-apiproxy`, `dsh-commands`, `dsh-client-ui-commands`, and `dsh-client-ui-conversation`.

### Command contract

| Input | Result |
|---|---|
| `/export` | Records a human-command lifecycle; the submitting browser downloads `GET /api/session.export?sessionId=<id>&includeDescendants=true` |
| `/export <path>` | An error; browser downloads choose their destination through the browser's ordinary download behavior |

### What to expect

The dialog reports three phases: preparing, download started, or failed. Closing the dialog does not cancel an in-flight download, and the dialog does not reopen when that operation later settles. One session admits one active download at a time; repeated gestures share that operation. The export includes the live session's newest events: the host endpoint flushes a live root session before reading, so a slash-triggered ZIP includes the `command/run` and `command/done` pair that started the download; cold persisted sessions need no flush.

### Failures

The dialog shows a preparation error when the preflight fails before ZIP streaming starts — for example an unreachable or misconfigured host endpoint. A descendant or attachment read failure after the browser accepts the GET is reported by the browser download manager, not by the dialog.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the package wires the export control and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design split

The package has two halves. The host half ([`src/index.ts`](src/index.ts)) registers the `/export` command on `ctx.commands`; the browser half ([`src/client/index.ts`](src/client/index.ts)) provides a `SessionLogDownloadController`, contributes the Header button and shared modal to the `conversation.session.header.utilities` slot, and observes `command/executed` so a successful `/export` in the submitting browser starts the same download. Other tabs still render the durable command row without repeating the browser side effect.

### Download flow

Both entry paths issue a `HEAD` preflight to `GET /api/session.export?...`, then hand the GET URL to the browser download manager without buffering the ZIP in JavaScript. One controller owns one in-flight download per session, collapses concurrent gestures into that operation, and cancels the preflight on plugin disposal. Modal state lives in a snapshot store keyed by session, so the button and the command share one dialog per session.

The host download endpoint is owned by [`dsh-host-apiproxy`](../../host/apiproxy/README.md): it flushes a live root session before `readRaw` and streams the ZIP; ZIP generation, raw JSONL/zstd reads, descendants, attachments, backpressure, and HTTP error semantics belong there.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the Web control to the host endpoint and the surrounding command and session surfaces.

- [dsh-host-apiproxy](../../host/apiproxy/README.md) — the host-streamed ZIP download endpoint this package drives.
- [Commands subsystem reference](../../../docs/subsystems/commands.md) — the human-command registry the `/export` command registers on.
- [dsh-client-ui-commands](../../client/ui-commands/README.md) — the browser command surface that renders and acknowledges `/export`.
- [Session Query package map](../README.md) — the retrieval family this package belongs to.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/export` control

#### What the model sees

Nothing. `/export` stays on the human-command plane, and the ZIP download does not enter model history.

#### Token effect

Zero. The command creates no model turn.

#### KV Cache effect

None. The log-only command lifecycle and browser download do not change the derived request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Requires a per-session raw artifact backend** — the download endpoint needs a persistence backend with a per-session raw artifact; the shipped JSONL backend supports plaintext and zstd, and SQLite export is not supported.
- **Browser download, not a Host-path writer** — the browser chooses the local destination; no Host path or native folder action is returned.
- **Preflight reports only pre-stream failures** — a descendant or attachment failure after the browser accepts the GET is reported by the browser download manager, not by the dialog.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked pages.

#### Future: export destinations beyond the browser

The download is deliberately browser-scoped; a Host-path or native folder export would need a new endpoint contract and a decision on where the ZIP lands.

</details>
