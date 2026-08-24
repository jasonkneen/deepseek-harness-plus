# Agent Note: One dsh launcher for application profiles

Status: implemented

English | [中文](2026-08-22-single-dsh-application-launcher.zh.md)

## Problem

DeepSeek Harness application processes need one owner for composition, plugin resolution, environment discovery, shutdown, and user customization. A dedicated app bin with a complete `cordis.yml` creates a second lifecycle beside profile launch: plugins installed into a profile do not reach it, behavior drifts from `dsh-base`, and SDK callers learn arbitrary process argv instead of the product's composition model.

The Python SDK distributes a native executable and three platform wheels whose embedded direct-config runtime cannot change launch architecture without rebuilding and validating the complete VFS closure. That distribution needs an explicit temporary exception, not a second general Node application pattern.

## Decision

### Launch scope

Every supported Node application starts through the `dsh` CLI and one named profile. The shipped application commands are `dsh web`, `dsh --profile headless`, `dsh --profile sdk`, and `dsh --profile acp`; `dsh web` is the deliberate convenience alias for `--profile web`, not another application entry.

Vendor CLIs, build-only and test-only executables, direct in-process plugin mounting, and the private browser WebWorker preview are outside the application-launch inventory. A package app bin or root demo that launches a package entry is not an accepted extension point.

### Profile applications

`@deepseek-ai/dsh-sdk-app` and `@deepseek-ai/dsh-acp-app` compose the protocol applications over `@deepseek-ai/dsh-base`. The SDK bundle adds the JSON-RPC server plus app-owned help and stdio lifetime; the ACP bundle adds the automation-only ACP server plus the same application responsibilities. Both adopt the base model, tools, persistence, settings, credentials, policy, and environment behavior.

Profile manifests own patch reload:

| Profile | `patchReload` |
|---|---|
| `web` | `live` |
| `headless` | `startup` |
| `sdk` | `startup` |
| `acp` | `startup` |

Custom profiles default to `live`. A startup profile still applies its bundle, profile, home-level, and invocation `--patch` layers, but it does not watch them after boot. `dsh-base` inserts the module-HMR row disabled; a profile with a tested source-module reload lifecycle must enable it explicitly. None of the shipped profiles enable server module HMR: `patchReload: live` uses the launcher's config-only watcher while the startup profiles install no watcher. SDK and ACP cannot safely replace their server, agents, persistence, or tool registry inside one owned stdio connection.

The shipped protocol profiles reserve stdout for protocol frames, expose help without starting transport, and route stdin EOF and signals through bounded root disposal. ACP remains automation-only. The SDK JSON-RPC methods, notification fields, and `initialize.serverInfo.name` remain stable. Model-visible tool and persistence defaults come from `dsh-base`, and runnable snapshots own those assembled application outputs.

### TypeScript SDK customization

`@deepseek-ai/dsh-sdk-client` depends on the same-version `@deepseek-ai/dsh` package, resolves its installed CLI module, runs it through the current Node executable, and selects `sdk` by default. Both client layers expose `dshBin`, `profile`, ordered `patches`, `dshHome`, process cwd, environment, and timeouts; arbitrary command/argv launch remains an internal fake-runtime adapter.

SDK users customize plugins through profiles. `dsh plugin --profile <name> ...` manages persistent dependencies and bundle order, the profile's `cordis.patch.yml` owns persistent row changes, and launch `patches` supply ordered ephemeral overrides. A custom profile must retain `@deepseek-ai/dsh-sdk-app` or another SDK server row. Relative CLI-module, patch, explicit home, and process-cwd paths become absolute before spawn, and initialization has a finite bound whose diagnostic names the selected profile.

Direct SDK use follows normal Harness-home resolution: explicit `dshHome`, inherited `DSH_HOME`, then `~/.dsh`. `subagent-dsh-sdk` instead requires an explicit absolute home, so a nested runtime cannot discover a person's profiles, installed plugins, credentials, or sessions through the operating-system home. DSH-specific ACP child examples also pass an isolated home; the ACP backend itself remains generic for non-DSH agents.

### Python exception and names

The Python SDK's direct-config application lives in the private `packages/sdk/python-runtime` package named `@deepseek-ai/dsh-sdk-python-runtime`. Its only packaged executable entry is `lib/packaged-bin.js`, consumed by the private `dsh-sdk-python-runtime-closure` deploy root. It has no public npm bin. The runnable direct Python example is `examples/python-sdk-agent`.

Python-observable behavior remains fixed: Python API, SDK wire, default `cordis.yml`, environment variables, wheel distribution names, packaged executable names, sidecar names, explicit runtime options, zero-config behavior, and supported platforms. The stable SDK family remains `@deepseek-ai/dsh-sdk-client`, `@deepseek-ai/dsh-sdk-protocol`, `@deepseek-ai/dsh-sdk-jsonrpc-server`, and wire identity `deepseek-harness-sdk-runtime`; `@deepseek-ai/dsh-acp` remains the ACP protocol plugin. There is no compatibility package, forwarding executable, fallback parser, or SDK/ACP launcher alias.

### Enforcement

`verify-application-entrypoints` scans application/package manifests, executable sources, and root demo scripts. The allowlist classifies the `dsh` product bin, vendor-excluded scope, the private WebWorker build tool, test support, and the private Python carrier. An unclassified shebang, a new package bin, or a demo wrapper that bypasses `apps/cli/src/bin.ts` fails hygiene and the primary/static CI aggregates.

## Deferred Python migration

The Python runtime follow-up must move the packaged process through `dsh --profile sdk`, preserve the wheel's closed dependency and native sidecar behavior, and delete `@deepseek-ai/dsh-sdk-python-runtime`. Only after those conditions pass on Linux x64, Linux arm64, and macOS arm64 does the executable family change from `dsh-jsonrpc-agent-pkg-<platform>-<arch>` to `deepseek-harness-sdk-runtime-<platform>-<arch>`. The temporary carrier and current artifact names make that obligation visible without weakening current Python compatibility.

## Existing decisions and supersession

This decision supersedes the application-launch and package-name facts in [profile plugin bundles](2026-08-05-profile-plugin-bundles.md), [TypeScript SDK client and subagent backend](../feature/2026-07-27-typescript-sdk-and-sdk-subagent-backend.md), [remove the SDK project toolchain](../simplification/2026-08-11-remove-sdk-project-toolchain.md), and [single-file Python SDK runtime distribution](2026-07-10-single-file-executable-sdk-runtime-distribution.md). Those notes retain independent authority for profile layering, client/wire semantics, deleted project tooling, and native packaging.

The [ACP automation-only protocol](../simplification/2026-07-23-acp-automation-only-protocol.md) remains authoritative for ACP wire and interaction scope. The [repository naming contract](2026-08-11-repository-naming-contract-and-rename-ledger.md) remains authoritative for role-based package names. No active note is fully superseded or eligible for archival.

## Alternatives considered

**Keep direct bins and state that profiles are preferred.** Rejected: documentation cannot make profiles own plugin installation, environment loading, shutdown, and tests while a supported executable bypasses them.

**Keep forwarding compatibility bins.** Rejected: a forwarding executable remains another public launch name and compatibility promise. The pre-release repository can move callers directly to profiles.

**Put complete standalone Cordis trees behind profile wrappers.** Rejected: that centralizes argv without centralizing application composition. `dsh-base` plus thin app bundles gives shared policy one owner while retaining protocol-specific negative guarantees.

**Accept inline plugins or a complete `cordis.yml` in the TypeScript constructor.** Rejected: the SDK would become another package installer and application composer. Named profiles and patch files already provide persistent and per-launch customization through one resolution model.

**Resolve `dsh` only from `PATH`.** Rejected: ordinary Node processes do not reliably inherit a project-local `.bin` path. A same-version package dependency provides a deterministic runtime.

**Enable module HMR in `dsh-base` and make unsafe profiles disable it.** Rejected: the shared base also underlies custom profiles, so an enabled default makes every new application remember to opt out of source-module replacement. A disabled base makes module HMR an explicit profile capability while leaving `patchReload: live` config watching available.

**Hot-reload protocol profiles.** Rejected: replacing a protocol server or its dependencies can invalidate pending frames and SDK-owned agents. Process restart is the adoption boundary for SDK and ACP configuration changes.

**Move the Python executable through profiles without a separate packaging proof.** Rejected: the native VFS closure, three platform wheels, ripgrep and spawn-helper sidecars, default config discovery, and clean-install behavior require their own migration evidence.

## Verification

- Source and built CLI acceptance cover `sdk` and `acp` help, transport startup, stdout purity, EOF, signals, and root disposal.
- Bundle configuration tests pin module HMR disabled in `dsh-base` and absent from shipped mode overrides; the custom live-profile e2e pins config reload through the launcher's watch-only fallback.
- Focused unit suites cover profile launch resolution, initialization bounds, SDK retries, server readiness, and nested isolated homes with 100% coverage on the changed runtime sources.
- Keyless ACP and SDK snapshots boot real `dsh` profiles and pin protocol output plus persisted logs; the nested SDK composition boots a second real profile runtime.
- The real-API workflow caps file parallelism at four because one profile e2e file can own several complete `dsh` subprocess trees; workflow tests pin that resource bound.
- The Python suite exercises exe and node carriers; all packaged-runtime scenarios, native macOS executable construction, both wheels, and clean-wheel default/MCP smokes retain the existing artifact names.
- `verify-application-entrypoints` includes invalid fixtures for package bins, executable sources, package-launching demo wrappers, and unclassified demos.

## Consequences

- A user changes an SDK application's plugin composition through a named profile and ordered patches, using the same installation and resolution model as every other dsh application.
- A custom profile receives live config watching without server module HMR and opts into source-module replacement only through an explicit row override.
- SDK and ACP share the complete base application and one set of policy and tools; snapshots present intentional assembled differences explicitly.
- Adding `@deepseek-ai/dsh` increases the TypeScript client's install size in exchange for a deterministic same-version runtime.
- Trusted user patches can add a plugin that writes to stdout and corrupt their own protocol stream; shipped profiles guarantee purity, not arbitrary third-party composition.
- Python keeps a visibly private, narrowly allowed direct-config carrier until its platform artifact migration is independently proven.
