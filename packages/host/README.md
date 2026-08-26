---
description: "Package map for the web GUI host half: the shared API gateway, the HTTP server it rides on, the SPA dist server, the workspace-directory picking seam, and the plugin inventory projection."
kind: "package-group"
---

# host/ — web-GUI host half

English | [中文](README.zh.md)

## Summary

The `host/` group is the web GUI host half: the API gateway every client shape shares, the plain HTTP server it rides on, the SPA dist server that serves the built Web shell, the workspace-directory picking seam with its native, browse, and adaptive composition packages, and the read-only plugin inventory projection. All eight packages are product packages; the browser half that consumes the gateway lives in [`client/`](../client/README.md), and the composed application is [`apps/cli`](../../apps/cli/README.md) booting the [`dsh-base` bundle](../bundle/base/cordis.patch.yml) that serves the web app under `apps/web/`. The gateway contract is transport-independent, and the picker backends replace one another behind the shared seam.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Eight packages play the host roles; each package README owns its contract and configuration.

| Package | Role | ctx key |
|---|---|---|
| [`apiproxy/`](apiproxy/README.md) | Shared API gateway: the typed client↔host contract, fetch carriers, and the gateway service | `ctx.apiProxy` |
| [`webserver/`](webserver/README.md) | Browser HTTP server: named routes, upgrades, index taps, and the fallback seat | `ctx.webServer` |
| [`frontend-static/`](frontend-static/README.md) | SPA dist server on the webserver fallback seat | consumes `ctx.webServer` |
| [`directory-picker/`](directory-picker/README.md) | Workspace-directory picking seam: capability contract and error vocabulary | `ctx.directoryPicker` |
| [`directory-picker-native/`](directory-picker-native/README.md) | Native-OS-chooser backend for operators at the host display | registers `ctx.directoryPicker` |
| [`directory-picker-browse/`](directory-picker-browse/README.md) | In-app directory-browser backend, including for remote clients | registers `ctx.directoryPicker` |
| [`directory-picker-auto/`](directory-picker-auto/README.md) | Host-adaptive chooser that mounts the matching backend at boot | mounts a backend |
| [`plugin-inventory/`](plugin-inventory/README.md) | Read-only projection of current Loader entries | Remote `pluginInventory/list` |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem references for the transport and the workspace records, then the layering decision behind the gateway.

- [HTTP server subsystem](../../docs/subsystems/web-server.md) — the webserver's routes, matching order, and config.
- [Workspace subsystem](../../docs/subsystems/workspace.md) — the workspace records the directory picker feeds.
- [GUI layering and RPC protocol RFC](../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md) — why the gateway contract is channel-independent.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
