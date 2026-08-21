# DeepSeek Harness Desktop

English | [中文](README.zh.md)

Electron desktop shell for the harness Web UI: a frameless window that keeps the
native macOS traffic lights, with opt-in macOS glass effects. This package is
**not** a Cordis plugin — it is a plain Electron app that embeds the UI served
by `dsh web`.

## What it does

- A single main process (`src/main.ts`) creates a `BrowserWindow` with
  `titleBarStyle: hiddenInset` on macOS (hidden title bar, native traffic
  lights) or `hidden` + Window Controls Overlay on Windows/Linux.
- The window loads `http://127.0.0.1:3080` — the harness Web UI. The renderer
  is always the web app, never this package's code: no preload, no
  `nodeIntegration`, no bundled assets.
- If no server already answers on the port, the app picks a server source in
  order: a `dsh` CLI on `PATH`, or — if `dsh` is missing — it **asks your
  permission to install `@deepseek-ai/dsh` via npm**, then starts it. The spawned
  server is killed with its process group on quit. **No harness source code is
  bundled with the app**; it relies on the published `dsh` CLI.

## Run

```sh
# Repo dev, server already running (any terminal):
pnpm dsh web --no-open

# Another terminal:
pnpm --filter @deepseek-ai/dsh-desktop run dev
```

```sh
# Standalone: a `dsh` CLI on PATH is used automatically; if it is missing the
# app prompts to install it (`npm install -g @deepseek-ai/dsh`) with your OK.
pnpm --filter @deepseek-ai/dsh-desktop run build
pnpm --filter @deepseek-ai/dsh-desktop run dev
```

## Environment knobs

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSH_DESKTOP_URL` | unset | External server URL; when set, nothing is spawned. |
| `DSH_DESKTOP_PORT` | `3080` | Loopback port to attach to or spawn on. |
| `DSH_DESKTOP_SERVER_CMD` | `dsh` | Server executable; extra args go in `DSH_DESKTOP_SERVER_ARGS`. |
| `DSH_DESKTOP_SERVER_ARGS` | unset | Extra arguments passed before `web --no-open --port`. |
| `DSH_DESKTOP_CWD` | `$HOME` | Working directory for the spawned server (affects profile resolution). |
| `DSH_DESKTOP_GLASS` | `off` | `off` \| `basic` (Electron vibrancy) \| `liquid` (macOS 26 Tahoe). |
| `DSH_DESKTOP_GLASS_RADIUS` | `16` | Corner radius for liquid glass, in pixels. |

## Window chrome

The traffic lights stay native; only the title bar is hidden. Because the
harness Web UI is not traffic-light aware, on macOS the wrapper injects CSS that
slides the sidebar content down into a `TRAFFIC_LANE_HEIGHT` (40px) gutter so the
sidebar background runs up behind the traffic lights, and makes the header row
draggable with its controls still clickable. The gutter height
(`TRAFFIC_LANE_HEIGHT`) and the light position (`trafficLightPosition`) are
tunable in `src/main.ts`; no web-side changes are required.

## Glass modes

- **`basic`** — Electron's `vibrancy: 'under-window'` + `transparent: true`; a
  small injected stylesheet makes the page background transparent so the
  material shows through.
- **`liquid`** — native macOS 26 (Tahoe) liquid glass via the
  [`electron-liquid-glass`](https://github.com/Meridius-Labs/electron-liquid-glass)
  addon. Requires macOS 26+, Electron 30+ (this app ships 43), and
  `transparent: true` with `vibrancy` unset — the wrapper does that. The addon
  uses private macOS APIs; on failure it falls back to basic vibrancy.

Transparent windows can leave visual artifacts on macOS and drop some window
behaviors, so glass is opt-in and off by default.

## Package (macOS)

```sh
# Unsigned dev build (no notarization; for local testing only):
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @deepseek-ai/dsh-desktop run pack
```

## Release — signed + notarized + uploaded

The release path mirrors the agensis/infinitty model: a **local** signed +
notarized build from your login Keychain Developer ID cert and a notarytool
profile is the primary path (zero CI secrets), with a tag-triggered CI workflow
as the backup.

> The app identity signs as **Developer ID Application: Jason Kneen
> (SW75ZJJ5R6)** (set in `electron-builder.yml`). If your cert differs, change
> `mac.identity` (and the `verify-sign` script) to match.

### One-time setup

1. A **Developer ID Application** cert in the login Keychain:
   `security find-identity -v -p codesigning | grep "Developer ID Application"`.
2. Notary credentials cached as a notarytool profile (`agensis` or the shared
   `infinitty` profile — same team). `desktop:ship` prompts once if neither
   exists:
   `xcrun notarytool store-credentials agensis --apple-id you@example.com --team-id SW75ZJJ5R6`.
3. `gh auth login` (for the `--upload` step).

### Cut a release (local-primary)

One command — bump version, tag `vX.Y.Z`, build/sign/notarize/upload:

```sh
pnpm --filter @deepseek-ai/dsh-desktop run desktop:release              # patch bump (0.0.0 → 0.0.1)
pnpm --filter @deepseek-ai/dsh-desktop run desktop:release -- minor
pnpm --filter @deepseek-ai/dsh-desktop run desktop:release -- 0.2.0
pnpm --filter @deepseek-ai/dsh-desktop run desktop:release -- 0.2.0 --push  # also commit + git push the tag
```

`desktop:release` bumps the shared version (desktop manifest + the workspace root,
which the constraints gate couples), tags `vX.Y.Z`, then runs `desktop:ship
-- --upload`. Or drive each step yourself:

```sh
git tag v0.1.2 && git push origin v0.1.2

pnpm --filter @deepseek-ai/dsh-desktop run desktop:ship            # build + sign + notarize + staple
pnpm --filter @deepseek-ai/dsh-desktop run desktop:ship -- --upload # also attach DMGs to the GitHub release
```

`desktop:ship` builds with electron-builder, notarizes every `.app` and `.dmg`
with Apple via the keychain profile, staples the tickets, and fails closed on a
bad Gatekeeper signature. `--push` is a path-limited commit of only the two
manifests, so a partially staged working tree is never swept in.

> The repo versions the whole dsh family as one unit (`pnpm run release:dsh`).
> `desktop:release` bumps the desktop + root manifests for an app-focused
> release; use `release:dsh` for a full repository release.

### CI (tag-triggered backup)

`.github/workflows/desktop-release.yml` builds on a `v*` tag and uploads the
DMGs to the matching GitHub Release. It signs + notarizes only when secrets are
present. Load them once (export the cert as a single-identity `.p12` via
Keychain Access, then):

```sh
pnpm --filter @deepseek-ai/dsh-desktop run desktop:setup-signing-secrets ~/Desktop/cert.p12
```

Secrets set: `CSC_LINK`, `CSC_KEY_PASSWORD`, `CSC_NAME`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Without `CSC_LINK` the CI mac
job stays unsigned — do not ship those artifacts.

### Verify a build

```sh
pnpm --filter @deepseek-ai/dsh-desktop run desktop:verify-sign
# want: Developer ID + codesign --verify OK; spctl accepted; stapler OK

# Simulate a downloaded DMG:
xattr -w com.apple.quarantine "0083;0;Safari;" apps/desktop/release/dsh-desktop-*-mac-arm64.dmg
spctl -a -t open --context context:primary-signature -vv apps/desktop/release/dsh-desktop-*-mac-arm64.dmg
```

Drop a `build/icon.icns` before packaging; without one electron-builder uses
the default Electron icon. `npmRebuild: true` rebuilds the
`electron-liquid-glass` native addon against the packaged Electron ABI (needs a
macOS toolchain; the addon also ships prebuilt binaries for standard setups).

## Layout

```
apps/desktop/
  src/main.ts              main process (all logic)
  build/entitlements.mac.plist
  electron-builder.yml
  scripts/
    release.sh             one-command release: bump + tag + build + notarize + upload
    ship-signed.sh         local build + notarize + staple (+ optional --upload)
    desktop-verify-sign.mjs   fail-closed Developer ID signature check
    setup-signing-secrets.sh  one-time load of CI secrets
  package.json             private workspace package, not a Cordis plugin
```
