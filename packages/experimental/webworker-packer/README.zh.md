# `@deepseek-ai/dsh-experimental-webworker-packer`

[English](README.md) | 中文

VFS 镜像打包器：把一份合成 profile 变成浏览器 worker 挂载为文件系统的 gzip 压缩基础 tar，并把不透明数据目录变成按序应用的 overlay tar（[experimental 定位](../../../.agents/notes/implemented/architecture/2026-08-20-webworker-pack-lowering-and-preview.zh.md)）。不做任何源码编译——基础镜像携带仓库真实构建产物，预览部署调试的正是 served 部署交付的字节。

打包是三层标准栈：

1. **Roster**——合成 profile 的插件行（标准 YAML 解析、Include 方言、`!!js` 原样保留），加上 CLI 在 `package.json` `dsh.configTrees` 里声明的每棵配置树（agent presets）的行，按 Node 式依赖闭包物化。外部包的 peer 边不追，workspace peer 保留在链上。
2. **发布视图**——每个 workspace 包贡献 npm 会发布的切片（`files` 走 picomatch），再减去 `src/rules.ts` 的规则表（无源码、无 workspace `dist/`；外部包保留整棵减同一套 exclude glob）。
3. **可达性 sweep**——用运行时加载器自己的解析，从全部 workspace 导出面加 worker 装配种子（`IMAGE_ENTRY_SEEDS`）出发，pack 时把每个可达模块降低到包装契约。页面资产（`./client` 导出背后的 `lib/client.js`）原样直发；自家代码的不可解析请求打包即失败，第三方的容忍到 require 时 fail loud。

`repository.ts` 拥有仓库形态输入（`vendor/`、`packages/`、`native/landlock-run/packages/` 与 `apps/` 的 workspace 扫描；经真 CLI dump 路径合成 profile）；`pack.ts` 一概不拥有，同一库换参即可打另一棵树。Native 扫描使 Landlock 入口包成为普通发布视图依赖，其可执行文件仍由 Worker 平台实现。CLI 为 `dsh-pack-vfs-image --out <file> [--profile web]`；`apps/web` 的 `build:preview` 在预览壳构建后运行它。

仓库适配层还声明 `webworker-runtime/tests/fixtures/` 下仅用于 preview 的 fixture tree。CLI 会把每套具名 fixture 打成一份独立的确定性 overlay 归档，并写出浏览器可读的 manifest。Overlay 文件绕过 NPM 发布视图和模块可达性排除规则，因此点目录与示例源码会完整保留；其挂载位置仅限 `home/` 与 `workspace/`。`pack.ts` 把它们视为不透明字节；Session 与 Workspace 的解释仍归拥有这些格式的 runtime 包。

## 模型体验

无：本包在构建期运行并写出镜像文件，其产物本身不进入任何模型请求。

#### KV Cache 影响

无：本包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

- **规则表是判断题**（`rules.ts`：exclude glob、页面资产模式、入口种子），由 `tests/` 钉住；worker 需要触达的新资产类别应加表行，而不是改扫描器。
- **vendored 包源码（`src/*.ts`）被排除**——运行时无人解析它们；未来若有 worker 内源码巡检功能需要专门的 include 规则。
- **打包器假定构建产物 `lib/` 是新鲜的**：它从不编译，工作区构建过期就打包过期字节。先跑仓库构建。
