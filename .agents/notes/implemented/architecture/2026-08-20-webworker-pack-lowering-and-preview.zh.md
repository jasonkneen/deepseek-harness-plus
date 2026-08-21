# Agent Note：pack 期 lowering 与单构建 preview

状态：已实施

[English](2026-08-20-webworker-pack-lowering-and-preview.md) | 中文

## 问题

浏览器 worker 既不能在装载期编译模块，也不能由产品 webserver 提供页面：每个模块体必须以可直接运行的形态到达，页面必须是静态产物。两个面早期都发生过漂移。装载器曾携带一个兜底编译器，于是收集器的缺口表现为「启动变慢」而不是「镜像坏了」——而且 `acorn` 经包 barrel 混进了 `lib/worker.js`，一个只包装预 lowered 模块体的运行时根本不需要解析器。preview 曾是服务页面旁的第二份 HTML 模板，一个 served index 可以悄悄漂离的页面。

## 决定

**Lowering 只发生在 pack 期。** `@deepseek-ai/dsh-experimental-webworker-packer` 组合 profile、物化闭包、lower 每个 JavaScript 模块体；`LOWERING_VERSION` 与 `WRAPPER_PARAMS` 是 pack↔worker 的契约，与镜像布局的其余部分一起放在 `src/image-layout.ts`。装载器完全按镜像持有的形态包装模块体：仍带模块语法的模块体是一次点名镜像的拒绝，且 `startWorkerHost` 在挂载任何模块之前要求 manifest 的 `lowered` 等于本构建的契约。`lowerModuleSource` 是转换器唯一的面、packer 是它唯一的调用方；worker 图内部的 import 一律指向拥有该值的模块——绝不指向包 barrel，那正是把解析器偷运进来的那条边。

**preview 就是服务页面加一个标签。** 一次 Vite 构建产出共享全部 chunk 的 `dist/index.html` 与 `dist/preview.html`；唯一差异是前插的一个引导入口，其模块负责连接 worker host。启动随之汇于一个协议：应用注入表的一方 settle `__DSH_BOOT_READY__` deferred——served 渲染器在渲染完的行之后用尾部脚本 resolve，worker 引导段在首个 await 之前安装、末行生效后 settle——client 入口在读取任何注入状态前 await 它，因此从标准入口起的链路逐字就是 served 链路。构建使用相对 base，产物可挂载于任意静态目录；served 形态在 serve 期渲染 `<base href="/">` 锚定深层 SPA fallback 路径，磁盘上的两个页面保持字节共享。

两个包以 `@deepseek-ai/dsh-experimental-*` 名义放在 `packages/experimental/`，私有且在官方发布之外。承载产品承诺的边界仍在产品包里：注入表、`__DSH_TRANSPORT__` 与 `/plugins` bundle 字节由 `dsh-host-webserver`、`dsh-client-modules`、`dsh-client-connection` 拥有。

## 曾考虑的替代方案

**保留装载期转换器作安全网。** 它把坏镜像变成无人归因的耗时回归，并且让「这个模块体是谁 lower 的」从外部不可回答。

**契约常量留在转换器里，信任 tree shaking。** 转换函数确实被摇掉了，但 `acorn` 未声明 `sideEffects`，仅 barrel 一条边就把整个解析器带进了 worker bundle。

**独立的 preview 模板。** 已退役的 `preview.html` 模板复制了服务文档并发生漂移（语言、标题、入口接线）。在 `closeBundle` 从 built index 派生页面则彻底消灭了第二份文档。

**用顶层 await 顺序而非 deferred 去闸标准入口。** 兄弟 module script 互不等待对方的顶层 await；`??=` 安装的 deferred 使握手与求值顺序无关，且失败的握手能 reject 进 boot 页的失败呈现。

## 后果

- `lib/worker.js` 不含解析器（当刀落时为 423.5 kB → 246.3 kB，早于 shell 进程层落地）。
- `diff dist/index.html dist/preview.html` 恰为一个 script 标签；`packages/experimental/webworker-packer/tests/image-loadable.spec.ts` 钉住装载器契约的两半，`apps/web/tests/preview-boot.e2e.ts` 在 web 浏览器车道钉住 preview 可用性（boot 到可交互页面），替代已撤编的 `apps/web/scripts/preview/` 探针脚本。
- served 的 `<base href="/">` 锚存在的原因是：相对资产 URL 在 SPA fallback 深路径下会解析进请求目录；只有与相对构建 base 一起才可移除它。
- 镜像以确定性 gzip 压缩的 tar 交付（`vfs-image.tar.gz`；MTIME 0、OS 字节 0xff）：静态托管不压缩二进制 content-type（类型白名单、CDN 尺寸帽），压缩必须随制品走；worker 用浏览器原生 `DecompressionStream` 在下载的同时解压 fetch body。
