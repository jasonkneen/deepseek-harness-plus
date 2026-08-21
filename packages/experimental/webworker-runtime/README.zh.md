# `@deepseek-ai/dsh-experimental-webworker-runtime`

[English](README.md) | 中文

浏览器 worker 宿主：整棵 harness 插件树跑在一个 dedicated Web Worker 里，用于预览部署与打包回归（[experimental 定位](../../../.agents/notes/implemented/architecture/2026-08-20-webworker-pack-lowering-and-preview.zh.md)）。worker 边下载边解压打包好的 VFS 镜像并挂载进内存，经 CommonJS 包装加载器装载模块，并通过一条讲纯 HTTP 的 postMessage 隧道服务页面。

一条 tsdown 管线出三个产物：

- **`lib/index.js`（装配库）**——`createWorkerHost`/`startWorkerHost` 挂载镜像（`storage/`）、安装模块加载器（`module-system/`）与 `process` shim、经镜像自带的 `dsh-app-boot` 启动插件树，并把服务缝隙交给隧道。镜像布局契约（`image-layout.ts`：虚拟根、config/manifest 路径、空目录、`lowered` 包装契约门）与 packer 共享。boot patch 强制部署形态行：关前端静态服务、JSONL 会话日志走明文、preset 根指向镜像内 `config/agent-presets`。
- **`lib/worker.js`（worker 束）**——装配库加本包的 Node 兼容层，合成一个自含 ES module。模块代理表（`module-proxies.ts`）是唯一平台叉口：`node:*` 内建走 VFS/隧道/浏览器原语，浏览器做不到的走结构化 stub（调用即 console 报错并抛出），外部包整体替换。AsyncLocalStorage 经 pack 时降低注入的 snapshot/restore 面在 `await` 间携带同步栈因果。worker 不带编译器：packer 未降低的镜像在挂载时被拒（[note](../../../.agents/notes/implemented/architecture/2026-08-20-webworker-pack-lowering-and-preview.zh.md)）。
- **`src/shell/`（worker 自己的进程层）**——浏览器 worker 无法 fork，所以 `node:child_process` 不是 stub 而是实现：`spawn` 把命令放进它自己的 Web Worker——就是这同一个束，由首帧告诉它「你是 shell 进程」——并以 subprocess 服务消费的 `ChildProcess` 面报告结果。命令不占宿主线程，`SIGKILL` 不管它在干什么都能终止它，而它只能靠消息触达 VFS（由宿主应答这些帧）。语法来自 `@yarnpkg/parsers` 的 `parseShell`；求值器（管道、`&&`/`||`、子 shell、重定向、展开、glob）与命令表由本包自持，而命令表就是这里唯一存在的 `/bin`——表里没有的名字报 `command not found`，`execSync`/`fork` 依然拒绝，因为它们需要真进程。
- **`lib/client.js`（页面半）**——`connectWorkerHost(worker, { image? })` 完成 pre-Cordis 握手：开局 `init` 帧携带镜像 URL（唯一部署形态输入），boot 载荷送达结构化 index 注入表，`applyIndexInjections` 在壳入口运行前逐行执行。隧道暴露 fetch 形传输、API 客户端与壳启动缝隙用的 `loadBundle`。

验收在 `apps/web/tests/preview-boot.e2e.ts`：静态服务真实构建页面，在 headless Chromium 里驱动 worker 启动。

## 模型体验

无：本包只在浏览器 worker 里承载插件树并应答它的 `node:*` 调用；所有面向模型的注册都属于它启动的那些插件。

#### KV Cache 影响

无：本包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

- **worker 组合写明文会话日志**（`compression: 'none'` boot patch）：不带 Zstandard 编解码器，导出日志是 `.jsonl`，不会是 `.jsonl.zstd`。
- **worker 里的技能目录从不缓存**——`skill-filesystem` 用 `node:fs.watchFile` 监听各个根，而本包拒绝该调用，于是每轮发现都返回不完整观测并重新扫描。发现本身仍然正确，代价是每轮都要重扫。
- **`node:vm`、`node:net`、`node:sqlite`、`node:worker_threads` 是结构化 stub**：每次调用在 console 报告拒绝并抛出。需要真进程或真 realm 隔离的行在此无法运行。
- **bash 工具只在 `danger-full-access` 下可用**：浏览器没有内核可以约束命令，因此在其余权限档位下 `ctx.sandbox.confine` 会响亮失败、命令根本不会启动。该档位是部署本身的用户面开关，不是 worker 特有的组合差异。
- **worker 束钉住了 `@yarnpkg/parsers` 的包内路径**——构建解析到该包自己的 `lib/shell.js` 而非包根，因为包根 barrel 还 re-export 了 Syml 解析器，会把 js-yaml 拖进一个从不解析该格式的束（约 175 kB，外加 worker 启动时的模块体求值）。该路径由包 manifest 派生，包内布局一变即构建期失败、不会静默退回 barrel；升级这个依赖时须复核 shell 解析器是否仍在那里。
- **这个 shell 不是 bash**：没有循环、函数、`case`、作业控制或进程替换——语法止步于管道、`&&`/`||`、子 shell、group、重定向与展开。`&` 会就地把命令跑完，`sed` 只接受替换脚本，模式是 JavaScript 正则，命令表只有 coreutils（没有 `git`，没有网络工具）。
- **shell 进程没有同步文件面**：它靠消息读写宿主的 VFS，因为阻塞等待回帧需要 `SharedArrayBuffer`，而那要求 GitHub Pages 给不了的跨源隔离。因此目录遍历类命令每个条目一次往返，并发的两条命令写入可以交错。
- **transport、worker-host、页面半的覆盖需要浏览器级 harness**——这些模块未达 per-file 覆盖门；单测覆盖 storage、ALS、transform 与 stub 契约。
