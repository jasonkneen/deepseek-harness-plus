# Agent Note: Package and update the Electron desktop application

Status: implemented

English | [中文](2026-08-25-electron-desktop-packaging-and-updates.zh.md)

## Problem

DeepSeek Harness needs an Electron desktop application that reuses the Web UI, works without system Node.js or pnpm, installs dsh and desktop plugins through an application-bundled pnpm, and updates the complete desktop release through one user-facing flow.

The desktop application and an npm-installed dsh share the `.dsh` data root, but they may have different dsh and plugin versions. They must share supported product data without sharing executable packages, lockfiles, `node_modules`, plugin activation, or package-manager configuration.

The current GUI protocol binds the Web client and backend release. Independently versioning the Electron artifact and its pnpm-installed dsh would create unqualified shell, client, backend, and plugin combinations and make update availability ambiguous.

## Decision

Ship a small Electron shell with a bundled upstream Node.js executable and pinned pnpm. Electron starts dsh as an isolated child process, carries Fetch metadata and bounded raw request and response chunks over two versioned framed byte pipes, reserves Node IPC for readiness, fatal failure, and shutdown, and serves validated assets through `dsh-app://`; it opens no listening port. Each frame carries a fixed marker, type, monotonic stream id, payload length, and validated payload. Serialized writers honor pipe drain, readers pause globally when a request or response stream applies backpressure, cancellation closes the matching stream, and late response frames for a retired stream stay inert. The Connection plugin provides its carrier-neutral RPC and Fetch registries without requiring `webServer`, while Client Modules provides the exact advertised combo-bundle responses to the shell-owned carrier; Web compositions attach their optional HTTP routes for both. The renderer keeps the same Fetch, RPC, and Remote-stream formats, while the child carrier avoids Base64 expansion and V8 serialization compatibility between Electron and the bundled upstream Node.js. This follows the Electron reservation in the [GUI layering and RPC protocol note](../../archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md).

Electron owns the reserved profile at `.dsh/profiles/desktop`. Its exact `@deepseek-ai/dsh` dependency supplies both the backend and matching Web UI. The dsh release and its first-party dependency closure use local npm tarballs packed from the same source build; the profile manifest lists every core package as a local `file:` dependency, and `pnpm-workspace.yaml` repeats the mapping as overrides. Desktop plugins are additional registry npm dependencies and ordered `dsh.profile.bundles` entries in the same profile, and resolve from its one `node_modules`.

One Desktop release number identifies both the Electron artifact and its exact `@deepseek-ai/dsh` dependency. A release cannot select a different dsh version at build or runtime. Updating dsh therefore requires a new Electron release even when shell code is unchanged.

The browser Web UI, dsh backend, existing `dsh plugin` CLI, user npm, and user pnpm cannot mutate this profile. The CLI reserves the `desktop` name and rejects boot, config-dump, and plugin-management requests for it. An Electron-only GUI sends structured install, remove, and update requests through preload; Electron invokes only its bundled pnpm.

## Ownership

| Owner | Responsibility |
|---|---|
| Electron shell | Window and child lifecycle, framed byte pipes, lifecycle IPC, custom protocol, reserved desktop profile, plugin GUI, update coordination, rollback |
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

The packaged seed is an offline installation kit, not an executable dsh tree. It contains the release identity, initial desktop-project manifest, a descriptor and immutable tarballs for the first-party package closure rooted at dsh, lockfile, integrity inventory, and required store subset. The release build requires the Electron package and root dsh package to have the same version, creates final npm tarballs from the official source build, selects the reachable dsh and vendored packages plus the Landlock entry, and verifies the dsh tarball's `lib/desktop-host.js` entry and `config/desktop.cordis.patch.yml` overlay. The overlay is the only CLI configuration file published specifically for Desktop; example configurations remain outside the tarball. These tarballs remain the official `pnpm pack` results governed by each package's `files` manifest; Desktop does not remove published declarations or otherwise create a second package-content policy. The manifest lists every selected package as a local direct dependency, automatic peer installation is disabled, and the workspace file overrides every selected first-party name to its local tarball. The build rejects any lockfile that resolves one of those names by registry version. Bundled pnpm fetches external production dependencies from npm, performs an offline installation, checks both Desktop Host files, and removes `node_modules` before final store preparation. Requiring both files before copying the package set and after offline installation prevents a release whose Host entry loads but cannot compose its required overlay from reaching application signing.

The seed stores pnpm content in 16 deterministic uncompressed tar shards selected by normalized store path. Apple notarization inspects Mach-O code inside those archives, so macOS seed preparation signs every Mach-O content-addressed object with the release Developer ID, a secure timestamp, and hardened runtime before sharding. Signing changes the bytes: preparation writes each object at its new SHA-512 path and transactionally rewrites every base and side-effects file reference in pnpm's MessagePack SQLite index. A second offline installation proves that pnpm resolves the rewritten store; preparation then shards it, extracts the final archives, and repeats signature verification. Package paths and non-native bytes remain unchanged, and the seed retains bundled architecture variants because removing files would create a Desktop-specific package file set. Seed integrity covers the shard manifest and every archive before extraction. Startup validates archive paths, entry types, uniqueness, and counts, extracts every shard into a unique Desktop-owned staging directory, and only then merges the complete extraction into `.dsh/desktop/pnpm/store`. An interrupted merge may leave valid immutable cache content, but profile installation and activation still require pnpm integrity and the complete health check.

Startup requires the packaged release identity to equal Electron's application version, then compares `.dsh/profiles/desktop/desktop-release.json` and the installed dsh package with that release before launching the backend. It installs the new seed manifest and lockfile with `pnpm install --offline --frozen-lockfile --trust-lockfile` in staging. After Electron replacement, it restores every plugin bundle recorded in the active profile at its exact installed version through one offline pnpm add from the existing desktop store and metadata cache. The complete graph must pass the same health check before activation.

The plugin GUI performs registry npm-package operations equivalent to `pnpm add <package> --save-exact`, `pnpm remove <package>`, and exact-version update in staging. Every mutation retains the local core-package descriptor, tarballs, dsh dependency, and complete override map. Electron validates the installed package manifest and updates the profile's dependency and ordered bundle entries; no renderer request can choose the registry, install directory, lifecycle policy, or arbitrary pnpm flags.

The backend and Loader use `.dsh/profiles/desktop/package.json` as their profile manifest and npm resolution anchor. The shared profile loader composes its ordered bundle entries, then the Electron-owned desktop overlay. dsh, Cordis, desktop plugins, plugin dependencies, and peer dependencies resolve through the ordinary pnpm `node_modules` graph. A desktop plugin contributing `dsh.client` code enters the boot manifest only after the complete profile passes health checking.

## Updates and recovery

Electron update uses one `electron-updater` release stream and signed `electron-builder` artifacts. Its version is the Desktop release version; there is no independent dsh manifest, compatibility range, or dsh-only update operation. The update dialog downloads and installs the Electron artifact, then restarts into the new release.

Before the new release opens a window, startup reconciles dsh from its packaged seed while retaining installed desktop plugins. The health check covers dependency resolution, native modules, shell API compatibility, backend startup and shutdown, Web assets, and the client boot graph. An incompatible plugin blocks activation and leaves the previous project available for rollback. Startup fails visibly rather than launching a shell and dsh version that do not match.

The generic update provider publishes metadata, installers, and blockmaps together. NSIS differential packages and the macOS ZIP target let electron-updater download changed blocks when supported; application replacement and the local pnpm staging transaction remain separate operations.

## Security and release policy

Core dsh comes only from integrity-recorded local npm tarballs inside the signed Electron release; pnpm overrides prevent transitive core packages from falling back to a registry. Store archives are integrity-checked and fully validated in an isolated extraction directory before their files can enter writable package state. Plugin installation accepts registry package specs allowed by desktop policy but never raw pnpm commands. Exact versions, lockfile integrity, a reviewed `allowBuilds` set, user-only directory permissions, redacted diagnostics, and health checking are required before activation.

Electron artifacts are signed; macOS artifacts are notarized. Release automation must supply the application ID, macOS Developer ID qualifier, expected Team ID, and one complete notarytool credential strategy through explicit environment variables. Configuration loading rejects missing or malformed identifiers and incomplete notarization credentials, while macOS packaging requires signing so certificate discovery cannot silently select another installed identity or emit an unsigned release. Seed preparation verifies the exact Authority and Team ID plus the timestamp and hardened-runtime flags on every embedded Mach-O file. An after-sign hook performs Apple's deep strict application verification and requires the same leaf Authority and Team ID before artifact creation continues. Electron-builder then notarizes and staples the application and signs the DMG. The DMG artifact-completion hook separately notarizes and staples every DMG before requiring the configured identity, a valid ticket, and Gatekeeper acceptance; the upload event runs only after that hook succeeds. DMG blockmaps are disabled because macOS updates consume the signed ZIP, and stapling would otherwise invalidate an already-generated DMG blockmap. The custom protocol serves the installed frontend distribution plus client files named by the active module graph and rejects traversal or access outside those roots. The plugin installer API is available only to the Electron-owned management GUI and is absent from the browser application and backend RPC.

Packaged applications ignore development resource and project environment overrides. Only an unpackaged Electron process can replace the Node.js binary, pnpm entry, seed, or active project.

The bundled upstream Node.js and pnpm are expected to add about 35–50 MB compressed and 120–165 MB installed before the seed store subset. Architecture-specific builds must report actual component-level size deltas.

## Implementation

| Surface | Implementation |
|---|---|
| Shell | `apps/desktop` owns Electron windows, restricted preloads, the custom protocol, child lifecycle, project transactions, the plugin GUI, update coordination, and electron-builder configuration. |
| Installed runtime | `@deepseek-ai/dsh/desktop-host` boots the portless desktop composition from the active project and streams API and asset responses over validated framed byte pipes. |
| Package state | The release seed and every later mutation run through bundled Node.js and pnpm with desktop-owned store, config, cache, state, and home paths; core packages resolve from release tarballs while plugins resolve from the fixed npm registry. |
| Qualification | macOS packaging requires the configured company identity and notary credentials, verifies every native seed object after final archive extraction, verifies the completed application signature, and requires notarization plus Gatekeeper acceptance for both the application and DMG. Windows signing, update hosting, previous-version installed-artifact tests, and platform GUI recordings remain release-environment gates. |

`dev:desktop` builds the current workspace, projects the built CLI package and its dependency links into a disposable project, uses an isolated Harness home, opens the Main, Renderer, and Host debuggers, and starts unpackaged Electron without preparing release resources. Package mutation is disabled in this mode because its linked dependency graph is not a pnpm-installed desktop project. Fixed macOS arm64, macOS x64, and Windows x64 package commands pass one target through runtime preparation, seed installation, and electron-builder; each also has an unpacked-directory variant for release-path verification before installer generation.

## Alternatives considered

**Use Electron's Node.js for dsh.** This saves package size but couples dsh to Electron's Node patches, fuses, native ABI, TLS behavior, and process lifecycle. A bundled upstream Node.js keeps dsh on its supported runtime.

**Carry Fetch bodies through JSON IPC as Base64.** JSON IPC keeps one message mechanism but expands every request and response body, constructs large strings in both processes, buffers each request before dispatch, and double-encodes image bytes already represented as Base64 inside RPC JSON. Raw framed pipes retain an explicit versioned protocol without relying on Electron and upstream Node.js to share V8 serialization behavior.

**Bake the product Web UI into Electron.** Independent UI and backend updates would require a new versioned compatibility program. Installing backend and Web UI from the same dsh package preserves the current release binding.

**Reuse the existing CLI or browser plugin installer.** That crosses the desktop authorization and release scope and can use the user's package-manager state. Desktop package mutation remains exclusively Electron-owned.

**Let the desktop profile use CLI-managed packages or plugins.** Either product could change the other's dependency graph, Cordis version, plugin version, or native module. The desktop profile therefore owns a complete `node_modules` and rejects bundle resolution through the CLI profile fallback.

**Install dsh and plugins into separate desktop projects.** This creates a second resolution anchor and peer-dependency fallback. One ordinary npm project already provides the required installation and resolution model.

**Remove non-target Mach-O files from registry packages.** Architecture pruning saves a small amount of seed space, but packages can deliberately ship several architecture variants and callers can observe their installed file set. Signing every shipped Mach-O object satisfies notarization without inventing a Desktop-specific package layout.

## Consequences

- A clean offline machine with no system Node.js or pnpm installs the seed into `.dsh/profiles/desktop` and starts a working dsh session.
- The signed application inventories a fixed small set of seed store shards instead of every pnpm cache file; every Mach-O object inside the macOS shards has the release Developer ID, secure timestamp, and hardened runtime, while the installed private store retains the ordinary pnpm layout.
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
