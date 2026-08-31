# DeepSeek Harness 桌面端

[English](README.md) | 中文

桌面应用是包裹 dsh Web UI 的 Electron 壳。它不打开监听端口：内置的上游 Node.js 子进程启动已安装的 dsh 项目，带版本的分帧字节管道在没有外层 Base64 信封的情况下承载 Fetch 请求与流式响应，Node IPC 承载生命周期控制，`dsh-app://` 则提供与后端版本匹配的客户端资源。

## 关键技术决策

| 决策 | 原因 | 直接结果 |
|---|---|---|
| 发布身份 | 桌面壳 API、Web 客户端、后端与插件依赖图作为一个组合完成验证；独立版本会产生未经验证的组合，并让更新可用性含糊不清。 | Electron 与 `@deepseek-ai/dsh` 始终使用同一精确版本。即使桌面壳代码不变，升级 dsh 也必须发布新 Desktop 版本。 |
| 运行时 | Electron 的 Node.js 带有 Electron 补丁、fuse、ABI 与生命周期约束，而系统运行时和用户包管理器状态不可控。 | dsh 通过内置的上游 Node.js 运行，所有包操作都使用内置 pnpm。Electron 的 Node.js、系统 Node.js、系统 pnpm 与用户的包管理器配置都不进入执行路径。 |
| 包来源 | 必须能在发布到 npm 之前从同一次源码构建打包精确的 dsh，并支持离线安装；插件则需要保留为用户选择的普通 npm 包。 | 已签名应用携带本地打包的第一方 dsh 包与离线 seed store。桌面插件仍是从固定 Desktop registry 解析的普通 npm 依赖。 |
| Seed 传输 | 把 pnpm store 的每个文件分别放入应用，会让代码签名记录数万个不可变缓存条目并增大更新元数据；单个压缩归档又会让很小的包变化改写一大片数据块。 | 打包按路径确定性地把 store 文件分配到 16 个未压缩 tar 分片。签名只记录分片，外层安装包负责压缩，差分更新可以复用未变化的分片。 |
| 状态归属 | 共享可执行依赖图会让 CLI 与 Desktop 相互改变 dsh、Cordis、插件或原生模块版本。 | Electron 独占 `$DSH_HOME/profiles/desktop` 及其包管理器状态。CLI 与 Desktop 共享 `$DSH_HOME` 下受支持的产品数据，但绝不共享可执行包、插件激活、锁文件或 `node_modules`。 |
| 通信 | 监听 Web 服务会引入端口归属、认证、CORS 与暴露风险；Electron 与上游 Node.js 之间也需要明确的跨进程协议。 | 应用不打开 Web 端口。`dsh-app://` 承载 Web 资源和 Fetch 流量；分帧字节管道以背压传输有界请求与响应分块，Node IPC 只承载子进程生命周期控制。 |
| 激活 | 依赖解析、生命周期脚本、原生模块与插件启动都可能失败，目录替换期间进程也可能中断。 | 发布与插件变更先安装到 staging，并启动完整后端执行健康检查；只有成功后才替换活跃 profile，中断替换由事务日志和一个 rollback profile 恢复。 |
| 更新 | 桌面壳与 dsh 独立更新会重新产生版本分裂，而桌面壳未变化的数据块不应强制完整传输。 | Electron 壳、匹配的 dsh seed、Node.js 与 pnpm 组成一个已签名更新单元。平台更新产物可以复用未变化的数据块，但运行时版本选择绝不脱离 Desktop 发布。 |

[Electron 打包与更新 Agent Note](../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md)记录了这些决策背后的理由、替代方案、安全约束和发布验证要求。

## 安装归属

Electron 拥有保留 profile `$DSH_HOME/profiles/desktop`。其 manifest 通过 `dsh.profile.bundles` 列出内置与已安装插件 bundle，`node_modules` 则同时包含精确版本的 `@deepseek-ai/dsh` 和所有桌面插件。CLI 不能启动或修改该 profile。Electron 始终调用自身内置的 Node.js 与 pnpm，并把 store 固定在 `$DSH_HOME/desktop/pnpm/store`；它绝不使用系统 pnpm 或调用方的 npm/pnpm 配置。

dsh 主渲染进程只获得桌面协议标记。独立插件窗口获得结构化的列出、安装、移除、更新和更新检查操作；两个渲染进程都拿不到文件系统、原始 Electron IPC、shell 或任意 pnpm 参数。

### Seed 安装

安装包内的 seed 是安装工具包，不是可以直接运行的 `node_modules` 目录。打包过程会生成锁文件、拉取生产依赖图、用匹配的 Desktop Host 入口完成一次完整离线安装验证，然后删除 `node_modules`。签名 seed 保留发布身份、本地第一方 tarball 及其描述文件、项目元数据、锁文件、完整性清单，以及在用户机器上重复该安装所需的 pnpm store 内容。

| Seed 内容 | 可写目标或用途 |
|---|---|
| `integrity.json` 与 `desktop-packages.json` | 在修改包状态前验证清单记录的每个 seed 文件、本地 tarball 哈希和绑定的 dsh 版本。 |
| `store-archives.json` 与 `store-archives/*.tar` | 验证确定性的未压缩分片，把它们解包到唯一的 Desktop staging 目录，再把完整结果合并到 `$DSH_HOME/desktop/pnpm/store`，且不移除已经为 Desktop 插件下载的包。 |
| 项目元数据与 `desktop-packages/` | 复制到唯一的 `$DSH_HOME/desktop/staging/<transaction-id>/profile` 项目。 |
| 锁文件与本地包映射 | 驱动内置 pnpm 完成安装，且不会从 npm 解析已打包的核心包名。 |

启动过程把 seed 安装或校准为一个串行事务：

1. 恢复中断的激活事务日志，验证完整 seed 清单与本地包集，并要求 seed 版本等于 Electron 应用版本。
2. 如果活跃 profile 已包含该发布与 dsh 版本，则验证其中的本地包集并直接复用，不重新安装。
3. 否则验证每个归档条目，把全部 store 分片解包到 Desktop 拥有的临时 staging 目录，把完整解包结果合并进私有 store，再创建 staging profile，并通过内置 Node.js 与 pnpm 执行 `pnpm install --offline --frozen-lockfile --trust-lockfile`。
4. Electron 升级时，从旧活跃 profile 读取每个插件的名称和精确版本，再通过现有 Desktop pnpm 状态以 `--offline` 把这些版本加入 staging。首次安装不执行插件恢复。
5. 启动完整的 staging 后端执行健康检查。在激活前发生安装错误或插件不兼容时，删除 staging 并保持活跃 profile 不变。
6. 记录目录替换事务，把活跃 profile 移到 `$DSH_HOME/desktop/rollback/profile`，再把 staging 移到 `$DSH_HOME/profiles/desktop`。替换失败时立即恢复旧 profile；替换中断时，下次启动会根据事务日志恢复。

GUI 插件修改会在把 registry 包安装到共享 Desktop pnpm store 后，使用相同的 staging、健康检查、激活与 rollback 路径。

## 开发

`dev:desktop` 会构建当前 Host、客户端 bundle、Web 前端和 Electron 壳，把已构建的 CLI 包及其 workspace 依赖投影为一次性桌面 npm 项目，然后直接启动 Electron；这条路径不下载安装包内的 Node.js，也不从 npm 解析 dsh：

```sh
pnpm run dev:desktop
```

开发 Harness 状态默认写入 `apps/desktop/.desktop-build/development/home`，一次性 npm 项目位于 `apps/desktop/.desktop-build/development/project`，Electron 浏览器数据则位于 `apps/desktop/.desktop-build/development/electron-user-data`。因此，会话、设置、凭据、包链接和浏览器数据都不会进入用户正常使用的 Harness home；显式 `DSH_HOME` 只会替换开发 Harness home。Renderer DevTools 默认自动打开，Main、Renderer 和 dsh Host 调试端口依次为 9229、9222 和 9230。`DSH_DESKTOP_MAIN_INSPECT_PORT`、`DSH_DESKTOP_RENDERER_DEBUG_PORT` 与 `DSH_DESKTOP_HOST_INSPECT_PORT` 可以替换这些端口，`DSH_DESKTOP_OPEN_DEVTOOLS=0` 则保持 Renderer 调试窗口关闭。

显式构建完成后，`start:desktop` 会重新生成一次性项目，并跳过构建直接启动已有产物：

```sh
pnpm run start:desktop
```

Workspace 开发使用调用命令的 Node.js 运行当前 CLI 包，并禁用桌面包修改；只有该模式明确链接的一次性 profile 可以从自身目录外解析 bundle。需要验证内置 Node.js、内置 pnpm、发布 seed、插件安装、staging 和 rollback 时，应运行未封装安装器的应用目录。

## 打包

正常打包只需执行一条完整命令。该命令会先准备发布资源，再生成宿主平台的安装包；配置发布信息后还会生成更新元数据。无需提前执行 `prepare:desktop`：

```sh
pnpm run package:desktop
```

发布自动化使用固定目标命令，确保运行时准备、seed 安装与 electron-builder 接收相同的平台和架构：

```sh
pnpm run package:desktop:mac:arm64
pnpm run package:desktop:mac:x64
pnpm run package:desktop:win:x64
```

macOS arm64 命令要求 Apple Silicon。macOS x64 命令可以在 Intel macOS 或带 Rosetta 的 Apple Silicon 上运行。Windows x64 命令要求 Windows x64。Desktop 尚不支持 Linux 发布目标。

使用对应的 `:dir` 命令可以生成可直接运行的应用目录，而不是安装包，例如：

```sh
pnpm run package:desktop:dir
pnpm run package:desktop:mac:arm64:dir
```

需要检查或诊断为宿主目标准备的资源而不调用 electron-builder 时，可以让同一流水线在准备完成后停止：

```sh
pnpm run prepare:desktop
```

这条诊断命令是另一种停止位置，并非两条命令构建流程的前半段。之后执行 `package:desktop*` 时仍会重新完成正式构建与准备，避免使用陈旧的 dsh 包、运行时文件或 seed 内容。

每条打包命令都会先执行仓库的正式构建，打包 dsh 与 vendored 包族，并打包 Landlock 入口，然后再准备发布资源。`prepare:packages` 选择以 `@deepseek-ai/dsh` 为根的第一方生产依赖闭包，验证 dsh tarball 包含 `lib/desktop-host.js`，把选中的 tarball 复制到种子输入，并记录其大小与 SHA-512 完整性。这些 tarball 是正式的 `pnpm pack` 输出，因此各包的 `files` manifest 决定发布内容：Desktop 不增加第二套过滤规则，会保留 `lib/types` 等已发布声明，也不会独立删除或增加 source map。Registry 包同样在 pnpm 内容寻址 store 中保留其发布的包字节。根 dsh 包与 Electron 包必须使用同一版本，但构建 Desktop 应用前不再要求 dsh 已发布到 npm。`prepare:runtime` 从 Node.js 官方发行服务下载 Node.js 24.17.0，在解压前验证其 SHA-256 条目，并在兼容的构建宿主上执行准备完成的二进制文件以验证其报告版本。它复制桌面包声明的 pnpm 版本，并把两个运行时版本记录进发布种子。`prepare:seed` 生成本地核心包映射，使用内置 pnpm 从 npm 拉取外部生产依赖，证明完整依赖图可以离线安装并包含匹配的 Host 入口，删除 `node_modules` 和临时 pnpm 项目注册，再把松散 store 替换为 16 个确定性的未压缩 tar 分片，然后生成清单。后续 GUI 插件操作保留本地核心包映射，同时从固定的 Desktop npm registry 解析插件包及其外部依赖。`electron-builder` 把平台产物写到 `apps/desktop/.desktop-build/artifacts`。

未压缩产物包含四块相互独立的体积：Electron、离线 seed store 分片与本地 dsh tarball、上游 Node.js 与 pnpm 运行时，以及很小的桌面壳应用。分片不压缩，使外层 DMG、ZIP 或 NSIS 压缩器与差分更新器可以处理稳定的数据区间。文件系统占用不等于安装包下载大小，因此必须分别测量。打包应用首次启动时还会先把 seed store 解包到 `$DSH_HOME/desktop/pnpm/store`，再安装可写 profile，因此发布验证必须同时测量应用与 Harness home 的磁盘占用。

## 更新

打包应用会在主窗口打开十秒后检查已配置的发布流；**检查更新…** 菜单项会手动触发同一检查。发现可用版本时，应用打开一个原生确认弹窗。用户确认后，应用下载并验证已签名的 Desktop 发布、停止 dsh 子进程，并把安装与重启交给 electron-updater。下次启动会先校准版本绑定的 seed，再重新打开产品窗口。没有 updater 配置的构建不会发起网络更新请求，并会报告当前已是最新版本。

发布构建通过 `DSH_DESKTOP_SHELL_UPDATE_URL` 配置 electron-updater 使用的 generic 更新服务。设置该变量后，electron-builder 会生成需要与 blockmap 和安装包一起发布的频道元数据；未配置的本地构建不会生成该元数据。NSIS 差分包与 macOS ZIP 目标让 electron-updater 可以复用未变化的数据块；seed 与桌面壳仍属于同一个签名 Desktop 发布。代码签名与 macOS 公证凭据使用 electron-builder 的标准环境变量。

## 底层开发覆盖项

`DSH_DESKTOP_NODE_BINARY`、`DSH_DESKTOP_PNPM_ENTRY`、`DSH_DESKTOP_SEED_DIR` 和 `DSH_DESKTOP_DEV_PROJECT_DIR` 可以为未打包 Electron 进程选择明确的资源。打包应用会忽略这些变量，并从 `process.resourcesPath` 解析签名资源。

## 已知限制

- 发布签名、公证、更新托管和跨上一版本的已安装产物验证需要生产发布环境。
- 依赖包含 lifecycle script 的桌面插件，只有其包名进入桌面项目经过评审的 `allowBuilds` 策略后才能安装。
- 桌面壳与 CLI dsh 共享 `$DSH_HOME` 下的会话、设置、凭据、工作区和存储，但可执行包、插件激活、锁文件与包管理器状态彼此隔离。
