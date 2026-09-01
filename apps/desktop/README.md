# DeepSeek Harness Desktop

English | [中文](README.zh.md)

The desktop application is an Electron shell around the dsh Web UI. It opens no listening port: a bundled upstream Node.js child boots the installed dsh project, versioned framed byte pipes carry Fetch requests and streaming responses without an outer Base64 envelope, Node IPC carries lifecycle control, and `dsh-app://` serves the matching client assets.

## Key technical decisions

| Decision | Why | Direct consequence |
|---|---|---|
| Release identity | The shell API, Web client, backend, and plugin graph are qualified as one combination; independent versions would create untested combinations and ambiguous update availability. | Electron and `@deepseek-ai/dsh` always have the same exact version. A dsh upgrade is a Desktop release, even when the shell code is unchanged. |
| Runtime | Electron's Node.js carries Electron patches, fuses, ABI, and lifecycle constraints, while system runtimes and package-manager state are uncontrolled. | dsh runs under the bundled upstream Node.js and every package operation uses the bundled pnpm. Electron's Node.js, system Node.js, system pnpm, and user package-manager configuration are outside the execution path. |
| Package sources | The exact dsh source build must be packageable before npm publication and install offline; plugins must remain ordinary user-selected npm packages. | The signed application carries locally packed first-party dsh packages and an offline seed store. Desktop plugins remain ordinary npm dependencies resolved from the fixed Desktop registry. |
| Seed transport | Apple notarization inspects code inside archives; shipping every pnpm store file separately would also make the application signature inventory tens of thousands of cache entries, while one compressed archive would amplify small package changes. | macOS packaging signs every Mach-O CAS object, rewrites its pnpm hashes, and proves another offline install before assigning store files to 16 deterministic uncompressed tar shards. The outer installer compresses them, and differential updates can reuse unchanged shards. |
| State ownership | Sharing executable dependency graphs would let CLI and Desktop change each other's dsh, Cordis, plugin, or native-module versions. | Electron exclusively owns `$DSH_HOME/profiles/desktop` and its package-manager state. CLI and Desktop share supported product data under `$DSH_HOME`, but never executable packages, plugin activation, lockfiles, or `node_modules`. |
| Transport | A listening Web service adds port ownership, authentication, CORS, and exposure concerns; Electron and upstream Node.js also need an explicit cross-process protocol. | The application opens no Web port. `dsh-app://` carries Web assets and Fetch traffic; framed byte pipes carry bounded request and response chunks with backpressure, while Node IPC carries only child lifecycle control. |
| Activation | Dependency resolution, lifecycle scripts, native modules, and plugin startup can fail, and a process can stop during directory replacement. | Release and plugin changes install in staging, boot a complete backend health check, and replace the active profile only after success; a journal and one rollback profile cover interrupted replacement. |
| Updates | Independent shell and dsh updates would recreate version splits, while unchanged shell blocks should not require a complete transfer. | The Electron shell, matching dsh seed, Node.js, and pnpm form one signed update unit. Platform update artifacts may reuse unchanged blocks, but runtime version selection never splits from the Desktop release. |

The [Electron packaging and update Agent Note](../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md) owns the rationale, alternatives, security constraints, and release qualification requirements behind these decisions.

## Installation ownership

Electron owns the reserved profile at `$DSH_HOME/profiles/desktop`. Its manifest lists the built-in and installed plugin bundles in `dsh.profile.bundles`, while its `node_modules` contains the exact `@deepseek-ai/dsh` package and every desktop plugin. The CLI cannot boot or mutate this profile. Electron always invokes its bundled Node.js and pnpm with the store at `$DSH_HOME/desktop/pnpm/store`; it never uses system pnpm or the caller's npm/pnpm configuration.

The main dsh renderer receives only the desktop protocol marker. The separate plugin window receives structured list, install, remove, update, and update-check operations; neither renderer receives filesystem access, raw Electron IPC, a shell, or arbitrary pnpm arguments.

### Seed installation

The packaged seed is an installation kit, not a ready-to-run `node_modules` tree. Packaging creates the lockfile, fetches the production graph, and proves one complete offline installation with the matching Desktop Host entry. A macOS build then Developer ID signs every Mach-O object in pnpm's content-addressed store, updates every affected SHA-512 index record, and proves the rewritten store with another offline install before deleting `node_modules`. The signed seed retains the release identity, local first-party tarballs and their descriptor, project metadata, lockfile, integrity inventory, and pnpm store content required to repeat that installation on the user's machine.

| Seed content | Writable destination or use |
|---|---|
| `integrity.json` and `desktop-packages.json` | Verify every inventoried seed file, local tarball hash, and bound dsh version before package state changes. |
| `store-archives.json` and `store-archives/*.tar` | Validate the deterministic uncompressed shards, extract them into a unique Desktop staging directory, and merge the result into `$DSH_HOME/desktop/pnpm/store` without removing packages already downloaded for Desktop plugins. |
| Project metadata and `desktop-packages/` | Copy into a unique `$DSH_HOME/desktop/staging/<transaction-id>/profile` project. |
| Lockfile and local package mappings | Drive the bundled pnpm installation without resolving a packaged core name from npm. |

Startup installs or reconciles the seed as one serialized transaction:

1. Recover an interrupted activation journal, verify the complete seed inventory and local package set, and require the seed version to equal Electron's application version.
2. If the active profile already contains that release and dsh version, verify its local package set and reuse it without reinstalling.
3. Otherwise validate every archive entry, extract all store shards into a temporary Desktop-owned staging directory, merge that complete extraction into the private store, create a staging profile, and run `pnpm install --offline --frozen-lockfile --trust-lockfile` through the bundled Node.js and pnpm.
4. During an Electron upgrade, read every plugin name and exact version from the old active profile and add those versions to staging with `--offline` from existing Desktop pnpm state. A first installation has no plugin-restore step.
5. Boot the complete staged backend as a health check. Installation or plugin incompatibility before activation deletes staging and leaves the active profile unchanged.
6. Journal the directory replacement, move the active profile to `$DSH_HOME/desktop/rollback/profile`, and move staging into `$DSH_HOME/profiles/desktop`. A failed replacement restores the old profile immediately; the next launch recovers an interrupted replacement from the journal.

GUI plugin mutations use the same staging, health-check, activation, and rollback path after installing registry packages into the shared Desktop pnpm store.

## Develop

`dev:desktop` builds the current Host, client bundles, Web frontend, and Electron shell, projects the built CLI package and its workspace dependencies into a disposable desktop npm project, and launches Electron without downloading the packaged Node.js runtime or resolving dsh from npm:

```sh
pnpm run dev:desktop
```

Development Harness state defaults to `apps/desktop/.desktop-build/development/home`, the disposable npm project lives at `apps/desktop/.desktop-build/development/project`, and Electron browser data lives at `apps/desktop/.desktop-build/development/electron-user-data`. Sessions, settings, credentials, package links, and browser data therefore stay out of the user's normal Harness home. An explicit `DSH_HOME` replaces only the development Harness home. Renderer DevTools opens automatically; Main, Renderer, and dsh Host debugging listen on ports 9229, 9222, and 9230. `DSH_DESKTOP_MAIN_INSPECT_PORT`, `DSH_DESKTOP_RENDERER_DEBUG_PORT`, and `DSH_DESKTOP_HOST_INSPECT_PORT` replace those ports, while `DSH_DESKTOP_OPEN_DEVTOOLS=0` keeps the detached Renderer tools closed.

After an explicit build, `start:desktop` reconstructs the disposable project and launches the existing artifacts without building again:

```sh
pnpm run start:desktop
```

Workspace development runs the current CLI package under the invoking Node.js and disables desktop package mutations. Its explicitly linked disposable profile is the only mode allowed to resolve bundles outside its own directory. Use an unpacked application to exercise the bundled Node.js, bundled pnpm, release seed, plugin installation, staging, and rollback paths.

## Package

The normal packaging path is one complete command. It performs release preparation before creating the host platform's installers; a configured release build also emits update metadata. Every target requires a reverse-DNS `DSH_DESKTOP_APP_ID`. macOS targets additionally require the electron-builder certificate qualifier in `DSH_DESKTOP_MACOS_SIGNING_IDENTITY`, its 10-character Apple Team ID in `DSH_DESKTOP_MACOS_TEAM_ID`, and one complete notarytool credential strategy. The App Store Connect API-key strategy uses these variables:

```sh
export DSH_DESKTOP_APP_ID='<reverse-DNS application ID>'
export DSH_DESKTOP_MACOS_SIGNING_IDENTITY='<certificate name without the Developer ID Application prefix>'
export DSH_DESKTOP_MACOS_TEAM_ID='<10-character Apple Team ID>'
export APPLE_API_KEY='<absolute path to the .p8 file>'
export APPLE_API_KEY_ID='<App Store Connect API Key ID>'
export APPLE_API_ISSUER='<App Store Connect issuer UUID>'
```

`prepare:desktop` is not a prerequisite:

```sh
pnpm run package:desktop
```

Release automation uses fixed target commands so runtime preparation, seed installation, and electron-builder receive the same platform and architecture:

```sh
pnpm run package:desktop:mac:arm64
pnpm run package:desktop:mac:x64
pnpm run package:desktop:win:x64
```

The macOS arm64 command requires Apple Silicon. The macOS x64 command runs on Intel macOS or Apple Silicon with Rosetta. The Windows x64 command requires Windows x64. Linux is not a supported Desktop release target.

The macOS configuration uses the required release environment instead of accepting whichever certificate appears first in a keychain. It rejects empty values, a malformed Team ID, a signing identity that includes electron-builder's unsupported `Developer ID Application:` prefix, and incomplete notarization credentials. macOS packaging requires the configured identity and its private key. Seed preparation applies that identity, a secure timestamp, and hardened runtime to every embedded Mach-O file; after signing the application, a deep strict check rejects any other leaf authority or Team ID before artifact creation. Electron-builder notarizes and staples the application before packaging and signs the DMG. The DMG artifact-completion hook then notarizes and staples it before requiring its exact identity, ticket, and Gatekeeper acceptance; only after the hook succeeds can electron-builder publish the file. The private key can come from the login keychain or electron-builder's standard `CSC_LINK` input; ambient `CSC_NAME` and certificate discovery order do not select the release owner. Notary credentials may instead use electron-builder's complete Apple ID or keychain-profile strategy. The two macOS identity variables are also required when repeating the application check manually with `pnpm --dir apps/desktop run verify:mac-signature -- <path-to-app>`.

Create a runnable application directory instead of an installer by using the matching `:dir` command, such as:

```sh
pnpm run package:desktop:dir
pnpm run package:desktop:mac:arm64:dir
```

To inspect or troubleshoot the prepared host-target resources without invoking electron-builder, stop the same pipeline after preparation:

```sh
pnpm run prepare:desktop
```

This diagnostic command is an alternative stopping point, not the first half of a two-command build. A later `package:desktop*` command repeats the official build and preparation so it cannot consume stale dsh packages, runtime files, or seed content.

Every package command performs the official repository build, packs the dsh and vendored package families, and packs the Landlock entry before preparing release resources. `prepare:packages` selects the first-party production closure rooted at `@deepseek-ai/dsh`, verifies that its tarball contains both `lib/desktop-host.js` and `config/desktop.cordis.patch.yml`, copies the selected tarballs into the seed input, and records their sizes and SHA-512 integrity. The overlay is the only CLI configuration file published specifically for Desktop; example configurations remain outside the tarball. These are the official `pnpm pack` outputs, so each package's `files` manifest controls its published contents: Desktop adds no second filter, retains published declarations such as `lib/types`, and neither strips nor adds source maps independently. Registry resolution, package paths, manifests, and non-native bytes remain npm-owned. For macOS, `prepare:seed` replaces each Mach-O CAS object with the company Developer ID signed bytes, writes them at their new SHA-512 paths, and transactionally rewrites every base or side-effects index reference; it preserves the package file set, including bundled architecture variants. The root dsh package and Electron package must have the same version, but dsh does not need to be published to npm before the Desktop application is built. `prepare:runtime` downloads Node.js 24.17.0 from the official Node.js release service, verifies its SHA-256 entry before extraction, and executes the prepared binary on a compatible build host to verify its reported version. It copies the pnpm version declared by the desktop package and records both runtime versions in the release seed. `prepare:seed` generates local core-package mappings, uses bundled pnpm to fetch external production dependencies from npm, proves the graph installs offline and contains both Desktop Host files, performs the macOS rewrite when applicable, proves the rewritten store with another offline installation, removes temporary pnpm project registrations, and replaces the loose store with 16 deterministic uncompressed tar shards. It extracts those final shards and verifies every embedded macOS signature before inventory generation. Later GUI plugin operations retain the local core mappings while resolving plugin packages and their external dependencies from the fixed Desktop npm registry. `electron-builder` emits platform artifacts under `apps/desktop/.desktop-build/artifacts`.

An unpacked artifact contains four independent size contributors: Electron, the offline seed store shards and local dsh tarballs, the upstream Node.js and pnpm runtime, and the small shell application. The shards are uncompressed so the outer DMG, ZIP, or NSIS compressor and differential updater can operate on stable ranges. Filesystem size is not installer download size, so measure both separately. First packaged startup also extracts the seed store into `$DSH_HOME/desktop/pnpm/store` before installing the writable profile, so release qualification must measure both application and Harness-home disk use.

## Updates

A packaged application checks its configured release stream ten seconds after the main window opens; the **检查更新…** menu item triggers the same check manually. An available release opens one native confirmation dialog. Accepting it downloads and verifies the signed Desktop release, stops the dsh child, and hands installation plus restart to electron-updater. The next launch reconciles the version-bound seed before reopening the product window. A build without updater configuration performs no network update request and reports that it is current.

Release builds set `DSH_DESKTOP_SHELL_UPDATE_URL` to the generic update server used by electron-updater. With this setting, electron-builder emits the channel metadata that must be published with the update blockmaps and installers; an unconfigured local build omits that metadata. NSIS differential packages and the macOS ZIP target allow electron-updater to reuse unchanged blocks; the manually installed DMG is notarized without a blockmap because it is not a macOS updater payload. The seed and shell still form one signed Desktop release. Windows signing and macOS notarization credentials use electron-builder's standard environment; the required Desktop release environment selects the application and macOS signature identities that the build verifies.

## Low-level development overrides

`DSH_DESKTOP_NODE_BINARY`, `DSH_DESKTOP_PNPM_ENTRY`, `DSH_DESKTOP_SEED_DIR`, and `DSH_DESKTOP_DEV_PROJECT_DIR` select explicit resources for an unpackaged Electron process. Packaged applications ignore these variables and resolve signed resources from `process.resourcesPath`.

## Known limitations

- Release signing, notarization, update hosting, and previous-version installed-artifact qualification require the production release environment.
- Desktop plugins with dependency lifecycle scripts are rejected unless their package appears in the desktop project's reviewed `allowBuilds` policy.
- The desktop shell shares sessions, settings, credentials, workspaces, and storage under `$DSH_HOME` with CLI dsh, while executable packages, plugin activation, lockfiles, and package-manager state remain separate.
