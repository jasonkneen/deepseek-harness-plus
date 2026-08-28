# Agent Note: Package and update the Electron desktop application

Status: implemented

English | [中文](2026-08-25-electron-desktop-packaging-and-updates.zh.md)

## Problem

DeepSeek Harness needs an Electron desktop application that reuses the Web UI, works without system Node.js or pnpm, installs dsh and desktop plugins through an application-bundled pnpm, and updates the complete desktop release through one user-facing flow.

The desktop application and an npm-installed dsh share the `.dsh` data root, but they may have different dsh and plugin versions. They must share supported product data without sharing executable packages, lockfiles, `node_modules`, plugin activation, or package-manager configuration.

The current GUI protocol binds the Web client and backend release. Independently versioning the Electron artifact and its pnpm-installed dsh would create unqualified shell, client, backend, and plugin combinations and make update availability ambiguous.

## Decision

Ship a small Electron shell with a bundled upstream Node.js executable and pinned pnpm. Electron starts dsh as an isolated child process, carries unary RPC and Remote streams over versioned JSON IPC with bounded Base64 request and response chunks, and serves validated assets through `dsh-app://`; it opens no listening port. The shell validates Base64 chunks with a linear scan so large client bundles cannot exhaust the main-process call stack, and removes a canceled response before notifying the child so late chunks and completion events stay inert. The Connection plugin provides its carrier-neutral RPC and Fetch registries without requiring `webServer`, while Client Modules provides the exact advertised combo-bundle responses to the shell-owned carrier; Web compositions attach their optional HTTP routes for both. The wire format avoids relying on V8 serialization compatibility between Electron and the bundled upstream Node.js. This follows the Electron reservation in the [GUI layering and RPC protocol note](../../archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md).

Electron owns the reserved profile at `.dsh/profiles/desktop`. Its exact `@deepseek-ai/dsh` dependency supplies both the backend and matching Web UI. The dsh release and its first-party dependency closure use local npm tarballs packed from the same source build; the profile manifest lists every core package as a local `file:` dependency, and `pnpm-workspace.yaml` repeats the mapping as overrides. Desktop plugins are additional registry npm dependencies and ordered `dsh.profile.bundles` entries in the same profile, and resolve from its one `node_modules`.

One Desktop release number identifies both the Electron artifact and its exact `@deepseek-ai/dsh` dependency. A release cannot select a different dsh version at build or runtime. Updating dsh therefore requires a new Electron release even when shell code is unchanged.

The browser Web UI, dsh backend, existing `dsh plugin` CLI, user npm, and user pnpm cannot mutate this profile. The CLI reserves the `desktop` name and rejects boot, config-dump, and plugin-management requests for it. An Electron-only GUI sends structured install, remove, and update requests through preload; Electron invokes only its bundled pnpm.

## Ownership

| Owner | Responsibility |
|---|---|
| Electron shell | Window and child lifecycle, IPC, custom protocol, reserved desktop profile, plugin GUI, update coordination, rollback |
| Bundled Node.js and pnpm | Execute dsh and install exact desktop-project dependencies without consulting user `PATH` or pnpm state |
| Desktop profile | One dependency graph, ordered bundle list, and `node_modules` for the desktop dsh package and desktop plugins |
| Installed dsh package | Backend, matching Web UI, boot manifest, client bundles, and product behavior |
| Shared `.dsh` owners | Sessions, settings, credentials, workspaces, and storage, guarded by their existing locks and format versions |
| npm-installed dsh | Its own executable installation and user-managed profiles; no access to the reserved desktop profile or package state |

The renderer uses `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. Preload exposes typed RPC, lifecycle, update, and desktop-plugin actions rather than raw `ipcRenderer`, filesystem access, shell commands, or pnpm arguments.

## Filesystem layout

```text
~/.dsh/
  desktop/
    staging/<transaction-id>/profile/
    rollback/profile/
    pending.json
    lock
    pnpm/
      store/
      cache/
      state/
      config/
  profiles/
    desktop/
      package.json
      pnpm-lock.yaml
      pnpm-workspace.yaml
      desktop-release.json
      desktop-packages.json
      desktop-packages/
      node_modules/
  sessions/
  storages/
```

`.dsh/profiles/desktop` is the only active desktop profile. Its package manifest records the built-in and installed plugin bundle order; Electron alone mutates its dependencies, lockfile, and `node_modules`. Production startup rejects a bundle resolved outside this profile, including the CLI-maintained `.dsh/profiles/node_modules` fallback. Package content installed for the desktop profile uses `.dsh/desktop/pnpm/store`.

## Installation and resolution

The installer never mutates the active profile in place. It copies profile metadata into a transaction staging directory, applies an exact dependency change with the bundled pnpm, performs a full health check, stops the backend, moves the active profile to `rollback/profile`, moves staging into `.dsh/profiles/desktop`, and restarts. `pending.json` journals the filesystem moves so startup can complete or reverse an interrupted replacement.

The packaged seed is an offline installation kit, not an executable dsh tree. It contains the release identity, initial desktop-project manifest, a descriptor and immutable tarballs for the first-party package closure rooted at dsh, lockfile, integrity inventory, and required store subset. The release build requires the Electron package and root dsh package to have the same version, creates final npm tarballs from the official source build, selects the reachable dsh and vendored packages plus the Landlock entry, and verifies the dsh tarball's `lib/desktop-host.js` entry. These tarballs remain the official `pnpm pack` results governed by each package's `files` manifest; Desktop does not remove published declarations or otherwise create a second package-content policy. The manifest lists every selected package as a local direct dependency, automatic peer installation is disabled, and the workspace file overrides every selected first-party name to its local tarball. The build rejects any lockfile that resolves one of those names by registry version. Bundled pnpm fetches external production dependencies from npm, performs the offline installation once, checks the Host entry again, and removes `node_modules` before inventory generation.

The seed stores pnpm content in 16 deterministic uncompressed tar shards selected by normalized store path. This reduces the signed application resource inventory without changing npm package bytes, lets the outer installer provide compression, and limits differential-update churn to shards containing changed paths. Seed integrity covers the shard manifest and every archive before extraction. Startup validates archive paths, entry types, uniqueness, and counts, extracts every shard into a unique Desktop-owned staging directory, and only then merges the complete extraction into `.dsh/desktop/pnpm/store`. An interrupted merge may leave valid immutable cache content, but profile installation and activation still require pnpm integrity and the complete health check.

Startup requires the packaged release identity to equal Electron's application version, then compares `.dsh/profiles/desktop/desktop-release.json` and the installed dsh package with that release before launching the backend. It installs the new seed manifest and lockfile with `pnpm install --offline --frozen-lockfile --trust-lockfile` in staging. After Electron replacement, it restores every plugin bundle recorded in the active profile at its exact installed version through one offline pnpm add from the existing desktop store and metadata cache. The complete graph must pass the same health check before activation.

The plugin GUI performs registry npm-package operations equivalent to `pnpm add <package> --save-exact`, `pnpm remove <package>`, and exact-version update in staging. Every mutation retains the local core-package descriptor, tarballs, dsh dependency, and complete override map. Electron validates the installed package manifest and updates the profile's dependency and ordered bundle entries; no renderer request can choose the registry, install directory, lifecycle policy, or arbitrary pnpm flags.

The backend and Loader use `.dsh/profiles/desktop/package.json` as their profile manifest and npm resolution anchor. The shared profile loader composes its ordered bundle entries, then the Electron-owned desktop overlay. dsh, Cordis, desktop plugins, plugin dependencies, and peer dependencies resolve through the ordinary pnpm `node_modules` graph. A desktop plugin contributing `dsh.client` code enters the boot manifest only after the complete profile passes health checking.

## Updates and recovery

Electron update uses one `electron-updater` release stream and signed `electron-builder` artifacts. Its version is the Desktop release version; there is no independent dsh manifest, compatibility range, or dsh-only update operation. The update dialog downloads and installs the Electron artifact, then restarts into the new release.

Before the new release opens a window, startup reconciles dsh from its packaged seed while retaining installed desktop plugins. The health check covers dependency resolution, native modules, shell API compatibility, backend startup and shutdown, Web assets, and the client boot graph. An incompatible plugin blocks activation and leaves the previous project available for rollback. Startup fails visibly rather than launching a shell and dsh version that do not match.

The generic update provider publishes metadata, installers, and blockmaps together. NSIS differential packages and the macOS ZIP target let electron-updater download changed blocks when supported; application replacement and the local pnpm staging transaction remain separate operations.

## Security and release policy

Core dsh comes only from integrity-recorded local npm tarballs inside the signed Electron release; pnpm overrides prevent transitive core packages from falling back to a registry. Store archives are integrity-checked and fully validated in an isolated extraction directory before their files can enter writable package state. Plugin installation accepts registry package specs allowed by desktop policy but never raw pnpm commands. Exact versions, lockfile integrity, a reviewed `allowBuilds` set, user-only directory permissions, redacted diagnostics, and health checking are required before activation.

Electron artifacts are signed; macOS artifacts are notarized. The custom protocol serves the installed frontend distribution plus client files named by the active module graph and rejects traversal or access outside those roots. The plugin installer API is available only to the Electron-owned management GUI and is absent from the browser application and backend RPC.

Packaged applications ignore development resource and project environment overrides. Only an unpackaged Electron process can replace the Node.js binary, pnpm entry, seed, or active project.

The bundled upstream Node.js and pnpm are expected to add about 35–50 MB compressed and 120–165 MB installed before the seed store subset. Architecture-specific builds must report actual component-level size deltas.

## Implementation

| Surface | Implementation |
|---|---|
| Shell | `apps/desktop` owns Electron windows, restricted preloads, the custom protocol, child lifecycle, project transactions, the plugin GUI, update coordination, and electron-builder configuration. |
| Installed runtime | `@deepseek-ai/dsh/desktop-host` boots the portless desktop composition from the active project and streams API and asset responses over validated Node IPC. |
| Package state | The release seed and every later mutation run through bundled Node.js and pnpm with desktop-owned store, config, cache, state, and home paths; core packages resolve from release tarballs while plugins resolve from the fixed npm registry. |
| Qualification | Production signing, notarization, update hosting, previous-version installed-artifact tests, and platform GUI recordings remain release-environment gates. |

`dev:desktop` builds the current workspace, projects the built CLI package and its dependency links into a disposable project, uses an isolated Harness home, opens the Main, Renderer, and Host debuggers, and starts unpackaged Electron without preparing release resources. Package mutation is disabled in this mode because its linked dependency graph is not a pnpm-installed desktop project. Fixed macOS arm64, macOS x64, and Windows x64 package commands pass one target through runtime preparation, seed installation, and electron-builder; each also has an unpacked-directory variant for release-path verification before installer generation.

## Alternatives considered

**Use Electron's Node.js for dsh.** This saves package size but couples dsh to Electron's Node patches, fuses, native ABI, TLS behavior, and process lifecycle. A bundled upstream Node.js keeps dsh on its supported runtime.

**Bake the product Web UI into Electron.** Independent UI and backend updates would require a new versioned compatibility program. Installing backend and Web UI from the same dsh package preserves the current release binding.

**Reuse the existing CLI or browser plugin installer.** That crosses the desktop authorization and release scope and can use the user's package-manager state. Desktop package mutation remains exclusively Electron-owned.

**Let the desktop profile use CLI-managed packages or plugins.** Either product could change the other's dependency graph, Cordis version, plugin version, or native module. The desktop profile therefore owns a complete `node_modules` and rejects bundle resolution through the CLI profile fallback.

**Install dsh and plugins into separate desktop projects.** This creates a second resolution anchor and peer-dependency fallback. One ordinary npm project already provides the required installation and resolution model.

## Consequences

- A clean offline machine with no system Node.js or pnpm installs the seed into `.dsh/profiles/desktop` and starts a working dsh session.
- The signed application inventories a fixed small set of seed store shards instead of every pnpm cache file, while the installed private store retains the ordinary pnpm layout.
- `.dsh/profiles/desktop/node_modules` contains and resolves the desktop dsh package and every GUI-installed desktop plugin.
- Every desktop pnpm operation uses the bundled executable and `.dsh/desktop/pnpm/store`; none reads user `PATH`, config, store, or profile `node_modules`.
- The Electron-only GUI installs, removes, and updates ordinary npm plugin packages without exposing raw pnpm arguments.
- The backend and browser application cannot mutate desktop packages.
- npm/CLI dsh and Electron never resolve or install plugins from each other's `node_modules`.
- The active backend and Web UI report the same dsh version and a compatible shell API before the product window opens.
- Failed installation, health checking, or update leaves the current profile usable or restores `rollback/profile` after restart.
- One Desktop version binds Electron and dsh; every dsh update arrives through one Electron update dialog and one user-visible restart.
- Shared `.dsh` data rejects incompatible readers before migration or mutation.
- No loopback listener is opened, and the sandboxed renderer cannot access arbitrary filesystem or Electron APIs.
- Workspace development runs current built code without downloading release resources, while unpacked-package verification retains the production installation path.
- Signed installed artifacts update successfully from the previous supported release on each release-blocking platform.

## Review decisions

| Decision | Recommendation |
|---|---|
| First launch | Bundle an offline seed store subset and install it through pnpm |
| Desktop profile | One Electron-owned reserved profile containing exact dsh and plugin dependencies |
| Plugin management | Electron-only GUI and package service; no CLI, backend, or browser installation path |
| Activation | Staging project, complete health check, journaled directory replacement, one rollback copy |
| Initial platforms | macOS arm64/x64 and Windows x64; Linux has no supported release target |
| Update behavior | Background check, explicit confirmation before differential download and restart, startup dsh reconciliation |

## Risks

Plugin lifecycle scripts execute third-party code. The allowed registry, package policy, exact versions, integrity, `allowBuilds`, and diagnostics require security review before GUI installation ships.

Updating the bound dsh can invalidate plugin peer dependencies or native modules. pnpm resolution and full-project health checking must reject the staged project before replacing the active one.

An npm-installed dsh and desktop dsh may have different versions while sharing durable data. Each shared owner must enforce its format version and process lock before reading, migrating, or writing.

Directory replacement differs across operating systems and can be interrupted. The activation journal and installed-artifact fault tests must prove recovery at every filesystem move.

Code signing, notarization, and update hosting require production release infrastructure. Repository tests alone cannot complete that qualification.
