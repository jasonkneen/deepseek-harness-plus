# DeepSeek Harness Desktop

[English](README.md) | 中文

Electron 桌面外壳，承载 harness Web UI：一个保留下方 macOS 原生红绿灯按钮的无边框窗口，并可选 macOS 玻璃效果。本包**不**是 Cordis 插件——它是一个普通的 Electron 应用，内嵌由 `dsh web` 提供的 UI。

## 它做什么

- 单个主进程（`src/main.ts`）创建 `BrowserWindow`：macOS 上 `titleBarStyle: hiddenInset`（隐藏标题栏、保留原生红绿灯按钮），Windows/Linux 上 `hidden` + Window Controls Overlay。
- 窗口加载 `http://127.0.0.1:3080`——harness Web UI。渲染器永远是 web 应用，而非本包代码：无 preload、无 `nodeIntegration`、不打包任何前端资源。
- 若端口上尚无服务器应答，应用按序选择服务器来源：`PATH` 上的 `dsh` CLI；或——若 `dsh` 缺失——**经用户许可后通过 npm 安装 `@deepseek-ai/dsh`**，再启动它。被启动的服务器随其进程组在退出时一并终止。**应用不打包任何 harness 源码**，只依赖已发布的 `dsh` CLI。
- 安装器从 PATH **以及** 常见 Node 安装位置（nvm、Homebrew）解析 `npm`/`dsh`，因为从 DMG 启动的应用运行在 launchd 的最小 PATH 下，会遗漏这些目录——因此无需 shell 即可完成常规 `npm install -g` 与检测。

> **Provider 集合 / Claude Code。** 本应用是中性外壳：它只呈现所连接 `dsh` 服务器提供的内容。你 fork 中的 Claude Code / multi-provider 追加（`dsh-llm-engine` 与 `dsh-multi-provider` 两个包）**不**在本 Electron 应用中，也**不**在已发布的 `@deepseek-ai/dsh` 里（那是 upstream）——它们只随你 fork 构建的 harness 一起提供。有三种方式取得：(1) 运行你 fork 的 `dsh web --no-open` 并让应用附加（开发，现成可用）；(2) 把 `DSH_DESKTOP_DOWNLOAD_URL` 指向由 `scripts/publish-fork-server.sh` 构建、托管在 fork 的独立服务器二进制；(3) 发布 fork 的 CLI 到 npm 并用 `DSH_DESKTOP_PACKAGE` 指向它。

## 运行

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

## 环境变量

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `DSH_DESKTOP_URL` | 未设置 | 外部服务器 URL；设置后不再启动任何进程。 |
| `DSH_DESKTOP_PORT` | `3080` | 附加或启动用的回环端口。 |
| `DSH_DESKTOP_SERVER_CMD` | `dsh` | 服务器可执行文件；额外参数放在 `DSH_DESKTOP_SERVER_ARGS`。 |
| `DSH_DESKTOP_SERVER_ARGS` | 未设置 | 在 `web --no-open --port` 之前传入的额外参数。 |
| `DSH_DESKTOP_CWD` | `$HOME` | 被启动服务器的工作目录（会影响 profile 解析）。 |
| `DSH_DESKTOP_PACKAGE` | `@deepseek-ai/dsh` | 按需安装的 npm 包；fork 可指向其自己发布的 CLI。 |
| `DSH_DESKTOP_DOWNLOAD_URL` | 未设置 | 独立 fork 服务器二进制的基础 URL（应用会追加 `-<platform>-<arch>` 并运行它）。 |
| `DSH_DESKTOP_GLASS` | `off` | `off` \| `basic`（Electron vibrancy）\| `liquid`（macOS 26 Tahoe）。 |
| `DSH_DESKTOP_GLASS_RADIUS` | `16` | liquid glass 的圆角半径（像素）。 |

## 窗口 chrome

红绿灯按钮保持原生，仅隐藏标题栏。由于 harness Web UI 不感知红绿灯按钮，macOS 上外壳注入 CSS，把侧栏内容下移进 `TRAFFIC_LANE_HEIGHT`（40px）的通道，使侧栏背景一直延伸到红绿灯按钮后方，并让标题行可拖动且其控件仍可点击。通道高度（`TRAFFIC_LANE_HEIGHT`）与按钮位置（`trafficLightPosition`）均可在 `src/main.ts` 中调整；无需改动 web 端。

## 玻璃模式

- **`basic`** — Electron 的 `vibrancy: 'under-window'` + `transparent: true`；注入一行样式让页面背景透明，使材质透出。
- **`liquid`** — 通过 [`electron-liquid-glass`](https://github.com/Meridius-Labs/electron-liquid-glass) 插件的原生 macOS 26（Tahoe）liquid glass。要求 macOS 26+、Electron 30+（本应用为 43），且 `transparent: true`、不设 `vibrancy`——外壳已照做。该插件使用私有 macOS API；失败时回退到 basic vibrancy。

透明窗口在 macOS 上可能留下视觉残影并削弱部分窗口行为，因此玻璃效果按需启用，默认关闭。

## 打包（macOS）

```sh
# Unsigned dev build (no notarization; for local testing only):
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @deepseek-ai/dsh-desktop run pack
```

## 发布——签名 + 公证 + 上传

发布路径沿用 agensis/infinitty 模式：**本地**用登录 Keychain 的 Developer ID 证书 + notarytool profile 做签名 + 公证是主路径（无需 CI secrets），tag 触发的 CI workflow 作为备份。

> 应用身份签名为 **Developer ID Application: Jason Kneen (SW75ZJJ5R6)**（在 `electron-builder.yml` 中设置）。若证书不同，请改 `mac.identity`（以及 `verify-sign` 脚本）。

### 一次性设置

1. 登录 Keychain 中有 **Developer ID Application** 证书：
   `security find-identity -v -p codesigning | grep "Developer ID Application"`。
2. 公证凭据已缓存为 notarytool profile（`agensis` 或共享的 `infinitty` profile——同一团队）。若两者皆无，`desktop:ship` 会提示一次：
   `xcrun notarytool store-credentials agensis --apple-id you@example.com --team-id SW75ZJJ5R6`。
3. `gh auth login`（用于 `--upload` 步骤）。

### 发布（以本地为主）

一条命令——bump 版本、打 `vX.Y.Z` tag、build/签名/公证/上传：

```sh
pnpm --filter @deepseek-ai/dsh-desktop run desktop:release              # patch bump (0.0.0 → 0.0.1)
pnpm --filter @deepseek-ai/dsh-desktop run desktop:release -- minor
pnpm --filter @deepseek-ai/dsh-desktop run desktop:release -- 0.2.0
pnpm --filter @deepseek-ai/dsh-desktop run desktop:release -- 0.2.0 --push  # also commit + git push the tag
```

`desktop:release` 会先 bump 共享版本（桌面清单 + workspace 根，二者被 constraints gate 耦合），打 `vX.Y.Z` tag，再运行 `desktop:ship -- --upload`。也可逐步执行：

```sh
git tag v0.1.2 && git push origin v0.1.2

pnpm --filter @deepseek-ai/dsh-desktop run desktop:ship            # build + sign + notarize + staple
pnpm --filter @deepseek-ai/dsh-desktop run desktop:ship -- --upload # also attach DMGs to the GitHub release
```

`desktop:ship` 用 electron-builder 构建，经 keychain profile 对每个 `.app` 与 `.dmg` 做 Apple 公证并加 staple，且在 Gatekeeper 签名异常时失败关闭。`--push` 是只包含两个清单的 path-limited commit，因此部分暂存的工作树不会被卷入。

> 仓库以整体为单位对 dsh 家族做版本（`pnpm run release:dsh`）。`desktop:release` 仅 bump 桌面 + 根清单，用于以应用为中心的发布；完整仓库发布请用 `release:dsh`。

### CI（tag 触发的备份）

`.github/workflows/desktop-release.yml` 在 `v*` tag 上构建并上传 DMG 到对应 GitHub Release。只有当 secrets 存在时才签名 + 公证。一次性加载（先在 Keychain Access 导出单身份的 `.p12`，然后）：

```sh
pnpm --filter @deepseek-ai/dsh-desktop run desktop:setup-signing-secrets ~/Desktop/cert.p12
```

设置的 secrets：`CSC_LINK`、`CSC_KEY_PASSWORD`、`CSC_NAME`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。没有 `CSC_LINK` 时 CI 的 mac job 保持未签名——不要分发这些产物。

### 验证构建

```sh
pnpm --filter @deepseek-ai/dsh-desktop run desktop:verify-sign
# want: Developer ID + codesign --verify OK; spctl accepted; stapler OK

# Simulate a downloaded DMG:
xattr -w com.apple.quarantine "0083;0;Safari;" apps/desktop/release/dsh-desktop-*-mac-arm64.dmg
spctl -a -t open --context context:primary-signature -vv apps/desktop/release/dsh-desktop-*-mac-arm64.dmg
```

打包前放入 `build/icon.icns`；否则 electron-builder 用默认 Electron 图标。`npmRebuild: true` 会针对打包后的 Electron ABI 重建 `electron-liquid-glass` 原生插件（需要 macOS 工具链；该插件也为标准环境提供预编译二进制）。

## 目录结构

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
