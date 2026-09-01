# Agent Note: 打包并更新 Electron 桌面应用

Status: implemented

[English](2026-08-25-electron-desktop-packaging-and-updates.md) | 中文

## 问题

DeepSeek Harness 需要一个复用 Web UI 的 Electron 桌面应用。该应用无需系统 Node.js 或 pnpm 即可工作，通过应用内置 pnpm 安装 dsh 与桌面插件，并通过一个面向用户的流程更新完整桌面发布。

桌面应用与通过 npm 安装的 dsh 共享 `.dsh` 数据根目录，但两者可能使用不同的 dsh 与插件版本。它们必须共享受支持的产品数据，同时不得共享可执行包、lockfile、`node_modules`、插件激活状态或包管理器配置。

当前 GUI 协议绑定 Web 客户端与后端版本。Electron 产物与其中通过 pnpm 安装的 dsh 如果独立定版本，就会产生未经验证的壳、客户端、后端与插件组合，也无法明确判断更新是否可用。

## 决策

交付一个小型 Electron 壳，其中内置上游 Node.js 可执行文件和固定版本的 pnpm。Electron 把 dsh 作为隔离子进程启动，通过两条带版本的分帧字节管道承载 Fetch 元数据及有界的原始请求与响应分块，只用 Node IPC 传递就绪、致命失败和关闭，并通过 `dsh-app://` 提供经过验证的资源；它不会打开监听端口。每个帧都包含固定标记、类型、单调 stream id、负载长度和经过验证的负载。串行 writer 遵守 pipe drain，请求或响应 stream 施加背压时 reader 会全局暂停，取消会关闭匹配的 stream，已退役 stream 的迟到响应帧保持无效。Connection 插件无需 `webServer` 即可提供与载体无关的 RPC 与 Fetch 注册表，Client Modules 则向 shell-owned carrier 提供与广告内容完全一致的组合 bundle 响应；Web 组合为两者挂载可选 HTTP route。渲染进程保留相同的 Fetch、RPC 与 Remote-stream 格式，子进程载体则避免 Base64 膨胀，也不依赖 Electron 与内置上游 Node.js 之间的 V8 序列化兼容性。该设计沿用 [GUI 分层与 RPC 协议 Agent Note](../../archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)中的 Electron 预留。

Electron 拥有保留 profile `.dsh/profiles/desktop`。其中精确的 `@deepseek-ai/dsh` 依赖同时提供后端与匹配的 Web UI。dsh 发布及其第一方依赖闭包使用同一次源码构建生成的本地 npm tarball；profile manifest 把每个核心包列为本地 `file:` 依赖，`pnpm-workspace.yaml` 再通过 overrides 重复该映射。桌面插件既是同一 profile 中来自 registry 的其他 npm 依赖，也是有序的 `dsh.profile.bundles` 条目，并从该 profile 唯一的 `node_modules` 解析。

一个 Desktop 发布号同时标识 Electron 产物及其精确 `@deepseek-ai/dsh` 依赖。发布不能在构建或运行时选择不同的 dsh 版本。因此，即使壳代码没有变化，更新 dsh 也必须产生新的 Electron 发布。

浏览器 Web UI、dsh 后端、现有 `dsh plugin` CLI、用户 npm 和用户 pnpm 都不能修改该 profile。CLI 保留 `desktop` 名称，并拒绝针对它的启动、配置 dump 和插件管理请求。Electron-only GUI 通过 preload 发送结构化安装、删除和更新请求；Electron 只调用其内置 pnpm。

## 归属

| Owner | 职责 |
|---|---|
| Electron 壳 | 窗口与子进程生命周期、分帧字节管道、生命周期 IPC、自定义协议、保留 desktop profile、插件 GUI、更新协调、回滚 |
| 内置 Node.js 与 pnpm | 执行 dsh 并安装桌面项目的精确依赖，不读取用户 `PATH` 或 pnpm 状态 |
| Desktop profile | 为桌面 dsh 包与桌面插件提供一个依赖图、有序 bundle 列表和一个 `node_modules` |
| 已安装 dsh 包 | 后端、匹配的 Web UI、启动 manifest、客户端包和产品行为 |
| 共享 `.dsh` owner | 会话、设置、凭据、工作区和存储，由其现有锁与格式版本保护 |
| 通过 npm 安装的 dsh | 自己的可执行安装和用户管理的 profile；不能访问保留 desktop profile 或包状态 |

渲染进程使用 `nodeIntegration: false`、`contextIsolation: true` 和 `sandbox: true`。Preload 暴露类型化 RPC、生命周期、更新与桌面插件操作，而不暴露原始 `ipcRenderer`、文件系统访问、shell 命令或 pnpm 参数。

## 文件系统布局

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

`.dsh/profiles/desktop` 是唯一活跃的 desktop profile。其 package manifest 记录内置与已安装插件 bundle 的顺序；只有 Electron 可以修改它的依赖、lockfile 和 `node_modules`。生产启动会拒绝解析到该 profile 之外的 bundle，包括 CLI 维护的 `.dsh/profiles/node_modules` fallback。desktop profile 安装的所有包内容都使用 `.dsh/desktop/pnpm/store`。

## 安装与解析

安装器绝不原地修改活跃 profile。它把 profile 元数据复制到事务暂存目录，使用内置 pnpm 应用精确依赖变更，执行完整健康检查，停止后端，把活跃 profile 移到 `rollback/profile`，把暂存 profile 移到 `.dsh/profiles/desktop`，然后重启。`pending.json` 记录文件系统移动，使启动过程可以完成或反转中断的替换。

打包种子是离线安装包，而不是可执行 dsh 目录。它包含发布身份、初始桌面项目 manifest、以 dsh 为根的第一方包闭包描述文件及不可变 tarball、lockfile、完整性清单和所需 store 子集。发布构建要求 Electron 包与根 dsh 包使用相同版本，从正式源码构建生成最终 npm tarball，选择可达的 dsh 与 vendored 包以及 Landlock 入口，并验证 dsh tarball 中的 `lib/desktop-host.js` 入口与 `config/desktop.cordis.patch.yml` overlay。该 overlay 是唯一为了 Desktop 而发布的 CLI 配置文件；示例配置仍留在 tarball 之外。这些 tarball 保持为由各包 `files` manifest 决定内容的正式 `pnpm pack` 结果；Desktop 不删除已发布的声明文件，也不建立第二套包内容策略。manifest 把每个选中的包列为本地直接依赖，关闭对等依赖自动安装，workspace 文件再把每个选中的第一方包 override 到对应本地 tarball。构建会拒绝任何通过 registry 版本解析这些包名的 lockfile。内置 pnpm 从 npm 拉取外部生产依赖，执行离线安装，检查两个 Desktop Host 文件，并在最终准备 store 前删除 `node_modules`。在复制 package set 前与离线安装后都要求两个文件，可防止 Host 入口本身能够加载、却无法组合所需 overlay 的发布进入应用签名阶段。

种子根据规范化 store 路径，把 pnpm 内容放入 16 个确定性的未压缩 tar 分片。Apple 公证会检查这些归档内的 Mach-O 代码，因此 macOS seed 在分片前会用发布 Developer ID、安全时间戳与 hardened runtime 签署每个内容寻址 Mach-O 对象。签名会改变字节：准备过程把每个对象写到新的 SHA-512 路径，并以事务方式重写 pnpm MessagePack SQLite 索引内全部基础文件和 side-effects 文件引用。第二次离线安装证明 pnpm 可以解析重写后的 store；准备过程随后完成分片、解包最终归档并再次验证签名。包路径和非原生字节保持不变；种子保留包内附带的架构变体，因为删除文件会创建 Desktop 专属的包文件集。种子完整性覆盖分片 manifest 和解包前的每个归档。启动时验证归档路径、条目类型、唯一性和数量，把所有分片解包到唯一且由 Desktop 拥有的 staging 目录，然后才把完整结果合并进 `.dsh/desktop/pnpm/store`。中断的合并可能留下有效的不可变缓存内容，但 profile 安装与激活仍必须通过 pnpm 完整性与完整健康检查。

启动过程先要求安装包内的发布身份等于 Electron 应用版本，再在启动后端前比较 `.dsh/profiles/desktop/desktop-release.json`、已安装 dsh 包与该发布版本。它在 staging 中通过 `pnpm install --offline --frozen-lockfile --trust-lockfile` 安装新的种子 manifest 与 lockfile。Electron 替换后，启动过程再通过一次离线 pnpm add，从桌面端现有 store 与元数据缓存恢复活跃 profile 记录的每个插件 bundle 精确版本。完整依赖图必须通过同一套健康检查才能激活。

插件 GUI 执行等价于 `pnpm add <package> --save-exact`、`pnpm remove <package>` 和精确版本更新的 registry npm 包操作。每次修改都保留本地核心包描述文件、tarball、dsh 依赖和完整 override 映射。Electron 验证已安装包 manifest，并更新 profile 的依赖与有序 bundle 条目；任何渲染进程请求都不能选择 registry、安装目录、生命周期策略或任意 pnpm flag。

后端与 Loader 把 `.dsh/profiles/desktop/package.json` 作为 profile manifest 和 npm 解析锚点。公共 profile loader 先组合其中的有序 bundle 条目，再应用 Electron 持有的 desktop overlay。dsh、Cordis、桌面插件、插件依赖和 peer dependency 均通过普通 pnpm `node_modules` 图解析。贡献 `dsh.client` 代码的桌面插件只有在完整 profile 通过健康检查后才进入启动 manifest。

## 更新与恢复

Electron 更新只使用一个 `electron-updater` 发布流和签名 `electron-builder` 产物。该版本就是 Desktop 发布版本；不存在独立 dsh manifest、兼容范围或仅更新 dsh 的操作。更新弹窗下载并安装 Electron 产物，然后重启进入新发布。

新发布在打开窗口前从安装包种子校准 dsh，同时保留已安装桌面插件。健康检查覆盖依赖解析、原生模块、壳 API 兼容性、后端启停、Web 资源和客户端启动图。不兼容插件会阻止激活，并保留上一个项目用于回滚。启动过程会明确失败，而不会运行版本不匹配的壳与 dsh。

generic 更新服务必须一起发布元数据、安装包和 blockmap。NSIS 差分包与 macOS ZIP 目标让 electron-updater 在平台支持时只下载变化的数据块；应用替换与本地 pnpm staging 事务仍是两个独立操作。

## 安全与发布策略

核心 dsh 只能来自签名 Electron 发布内经过完整性记录的本地 npm tarball；pnpm overrides 防止传递核心包回退到 registry。Store 归档经过完整性检查，并在隔离的解包目录中完成全部验证，归档文件随后才能进入可写包状态。插件安装接受桌面策略允许的 registry 包 spec，但绝不接受原始 pnpm 命令。激活前必须具备精确版本、lockfile 完整性、经过评审的 `allowBuilds` 集合、仅限用户的目录权限、遮盖后的诊断和健康检查。

Electron 产物必须签名；macOS 产物必须公证。发布自动化必须通过明确的环境变量提供应用 ID、macOS Developer ID 限定名、预期 Team ID 与一套完整的 notarytool 凭据。配置加载会拒绝缺失或格式错误的标识符和不完整的公证凭据，macOS 打包还会强制签名，避免证书发现过程静默选择其他已安装身份或生成未签名发布。Seed 准备会验证每个内嵌 Mach-O 文件的精确 Authority 与 Team ID，以及时间戳和 hardened-runtime 标记。签名后钩子会执行 Apple 的深度严格应用验证，并要求同一叶证书 Authority 与 Team ID 完全匹配，验证通过后才继续生成产物。Electron-builder 随后公证应用并钉票、签署 DMG。DMG 的 artifact-completion hook 会单独公证每个 DMG 并钉票，再要求其使用配置的身份、具备有效票据并通过 Gatekeeper；只有该 hook 成功，上传事件才会执行。macOS 更新使用签名 ZIP，因此 DMG 不生成 blockmap；否则钉票会让已经生成的 DMG blockmap 失效。自定义协议提供已安装的前端分发目录和活跃模块图点名的客户端文件，并拒绝路径穿越或访问这些根目录之外的内容。插件安装器 API 只对 Electron 拥有的管理 GUI 可用，不存在于浏览器应用或后端 RPC 中。

打包应用会忽略开发资源和项目环境变量覆盖。只有未打包的 Electron 进程可以替换 Node.js 可执行文件、pnpm 入口、seed 或活跃项目。

在种子 store 子集之外，内置上游 Node.js 与 pnpm 预计增加约 35–50 MB 压缩体积和 120–165 MB 安装体积。分架构构建必须报告实际组件级体积增量。

## 实现

| 表面 | 实现 |
|---|---|
| 壳 | `apps/desktop` 负责 Electron 窗口、受限 preload、自定义协议、子进程生命周期、项目事务、插件 GUI、更新协调和 electron-builder 配置。 |
| 已安装运行时 | `@deepseek-ai/dsh/desktop-host` 从活跃项目启动无端口桌面组合，并通过经过验证的分帧字节管道流式传输 API 与资源响应。 |
| 包状态 | 发布种子和后续每次修改都通过内置 Node.js 与 pnpm 执行，并使用桌面端拥有的 store、config、cache、state 和 home 路径；核心包从发布 tarball 解析，插件从固定 npm registry 解析。 |
| 资格验证 | macOS 打包要求已配置的公司身份与公证凭据可用，在解包最终归档后验证每个原生 seed 对象，验证完整应用签名，并要求应用和 DMG 都完成公证且通过 Gatekeeper。Windows 签名、更新托管、跨上一版本的已安装产物测试和各平台 GUI 录制仍是发布环境门槛。 |

`dev:desktop` 会构建当前 workspace，把已构建 CLI 包及其依赖链接投影为一次性项目，使用隔离的 Harness home，打开 Main、Renderer 和 Host 调试器，并在不准备发布资源的情况下启动未打包 Electron。该模式的链接依赖图不是由 pnpm 安装的桌面项目，因此会禁用包修改。固定的 macOS arm64、macOS x64 与 Windows x64 打包命令会把同一目标传给运行时准备、seed 安装和 electron-builder；每条命令还提供未封装安装器的变体，用于在生成安装器前验证发布路径。

## 考虑过的替代方案

**使用 Electron 的 Node.js 执行 dsh。** 这可以减小包体积，但会让 dsh 耦合到 Electron 的 Node 补丁、fuse、原生 ABI、TLS 行为和进程生命周期。内置上游 Node.js 可以让 dsh 继续使用其受支持运行时。

**通过 JSON IPC 以 Base64 承载 Fetch 消息体。** JSON IPC 可以只保留一种消息机制，但会膨胀每个请求与响应消息体、在两个进程中构造大字符串、在分派前缓冲完整请求，还会再次编码 RPC JSON 中已经表示为 Base64 的图片字节。原始分帧管道保留明确的带版本协议，同时不要求 Electron 与上游 Node.js 共享 V8 序列化行为。

**把产品 Web UI 永久打包进 Electron。** 独立 UI 与后端更新需要新的版本化兼容计划。从同一个 dsh 包安装后端与 Web UI 可以保持当前发布绑定。

**复用现有 CLI 或浏览器插件安装器。** 这会跨越桌面授权与发布 scope，并可能使用用户的包管理器状态。桌面包修改完全由 Electron 拥有。

**让 desktop profile 使用 CLI 管理的包或插件。** 任一产品都可能改变另一方的依赖图、Cordis 版本、插件版本或原生模块。因此 desktop profile 持有完整 `node_modules`，并拒绝通过 CLI profile fallback 解析 bundle。

**把 dsh 与插件安装到不同桌面项目。** 这会产生第二解析锚点和 peer dependency 回退。一个普通 npm 项目已经提供所需安装与解析模型。

**从 registry 包删除非目标 Mach-O 文件。** 架构裁剪可以节省少量 seed 空间，但包可能有意附带多个架构变体，调用方也可以观察安装后的文件集。签署每个实际携带的 Mach-O 对象，无需发明 Desktop 专属包布局就能满足公证要求。

## 结果

- 没有系统 Node.js 或 pnpm 的干净离线机器把种子安装进 `.dsh/profiles/desktop`，并启动可工作的 dsh 会话。
- 已签名应用记录固定少量的 seed store 分片，而不是记录每个 pnpm 缓存文件；macOS 分片内每个 Mach-O 对象都带有发布 Developer ID、安全时间戳与 hardened runtime，安装后的私有 store 仍保持普通 pnpm 布局。
- `.dsh/profiles/desktop/node_modules` 包含并解析桌面 dsh 包和每个 GUI 安装的桌面插件。
- 每个桌面 pnpm 操作都使用内置可执行文件和 `.dsh/desktop/pnpm/store`；不读取用户 `PATH`、配置、store 或 profile `node_modules`。
- Electron-only GUI 安装、删除和更新普通 npm 插件包，而不暴露原始 pnpm 参数。
- 后端与浏览器应用不能修改桌面包。
- npm/CLI dsh 与 Electron 绝不从对方的 `node_modules` 解析或安装插件。
- 在产品窗口打开前，活跃后端与 Web UI 报告相同 dsh 版本和兼容壳 API。
- 安装、健康检查或更新失败后，当前 profile 仍然可用，或在重启后恢复 `rollback/profile`。
- 一个 Desktop 版本绑定 Electron 与 dsh；每次 dsh 更新都通过一个 Electron 更新弹窗交付，并产生一次用户可见的重启。
- 共享 `.dsh` 数据在迁移或修改前拒绝不兼容的读取方。
- 不打开回环监听端口，沙箱渲染进程不能访问任意文件系统或 Electron API。
- Workspace 开发无需下载发布资源即可运行当前已构建代码，未封装安装器的应用验证仍保留生产安装路径。
- 每个发布阻断平台上的签名已安装产物均能从上一个受支持版本成功更新。

## 评审决策

| 决策 | 建议 |
|---|---|
| 首次启动 | 打包离线种子 store 子集，并通过 pnpm 安装 |
| Desktop profile | 一个包含精确 dsh 与插件依赖、由 Electron 持有的保留 profile |
| 插件管理 | Electron-only GUI 与包服务；没有 CLI、后端或浏览器安装路径 |
| 激活 | 暂存项目、完整健康检查、记录式目录替换和一个回滚副本 |
| 初始平台 | macOS arm64/x64 与 Windows x64；Linux 尚无受支持的发布目标 |
| 更新行为 | 后台检查，差分下载与重启前显式确认，启动时校准 dsh |

## 风险

插件生命周期脚本会执行第三方代码。在 GUI 安装功能交付前，获准 registry、包策略、精确版本、完整性、`allowBuilds` 和诊断都需要安全评审。

更新绑定的 dsh 可能使插件 peer dependency 或原生模块失效。pnpm 解析与完整项目健康检查必须在替换活跃项目前拒绝暂存项目。

通过 npm 安装的 dsh 与桌面 dsh 可能在共享持久化数据时使用不同版本。每个共享 owner 都必须在读取、迁移或写入前执行格式版本与进程锁。

不同操作系统的目录替换行为不同，而且可能中断。激活记录与已安装产物故障测试必须证明每次文件系统移动都可以恢复。

代码签名、公证和更新托管需要生产发布基础设施。只运行仓库测试不能完成这些认证。
