---
description: "web GUI 宿主客户端共享的 API 网关：浏览器安全的 API 约定、fetch 载体，以及每种客户端形态都使用的宿主侧网关服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-apiproxy

[English](README.md) | 中文

## 概述

web GUI 宿主的每个客户端都通过 `dsh-host-apiproxy` 调用同一套类型化 API——会话与历史、工作区、目录选择、模型选择、agent preset、skill、目标、设置、凭据、LLM 目录、事件与会话导出——由 fetch 载体经由 HTTP 或进程内搬运。约定层零 Node 依赖、可从浏览器导入，因此一套类型化 API 同时服务 Web 服务器、Electron 与任何未来的客户端形态。随发行版交付的 Web 组合在 [`dsh-web-app`](../../bundle/web-app/README.zh.md) 中组装网关。选择载体、调用领域 API 与配置网关在前；协议内部细节放在下方可折叠的开发者章节中。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 GUI 宿主的客户端需要会话、工作区与配置 API 时组合网关：加载 `ApiProxyService`，把 `ctx.apiProxy` 包进一个载体，然后调用类型化的领域方法。

### 选择载体

`toFetchHandler(api)` 把网关变成纯 WHATWG fetch 函数，供 HTTP 服务器使用（随发行版交付的 Web 组合把它暴露在 `/api/…` 路由之后）；`InProcessApiClient` 则在进程内运行同一条序列化与校验路径——这是需要完整协议路径但不需要网络的调用方与测试的同构接点。

```text
const client = new InProcessApiClient(toFetchHandler(ctx.apiProxy))
const response = await client.sessions.list({})
```

HTTP 载体在分发前以 415 拒绝非 JSON 的 POST 请求体，因此跨站「简单请求」永远无法盲目执行有副作用的方法。浏览器载体对每个 Host API 方法实施相同的 Host/Origin 检查与签名 cookie 认证（[`dsh-client-connection`](../../client/connection/README.zh.md)）；各 Client 功能仍可以在非 loopback 页面上拒绝原生操作或持久化操作。

### 网关暴露什么

API 按领域分组：`sessions`（list、create、history、prompt、cancel、queue、models、selectModel、rename、fork、search、attachment）、`workspace`、`host`（describe、pickDirectory、listDirectory、createDirectory、openPath）、`skills`、`agentPresets`、`goals`、`settings`、`credentials`、`llm`、`events` 与 `downloads`。sessions、workspace 与 events 契约分别归 Session Controller、Workspace Controller 与 API Remotes 包所有；其余领域契约与 `RpcMethodMap` 位于 `src/api/`。

### 会话与历史

`session.history` 对会话的追加消息流分页（`maxMessages` 统计以追加方式进入 surface 的 `user/message` 与 `assistant/message` 事件，因此仅供模型使用的替换副本不占用配额），并让每一页保持一段连续的原始事件区间，这使压缩的仅日志摘要与引用它的替换留在同一页。尾页可选携带 `projections` 块——每个已注册投影单元的水位线快照——网关会为状态发生变化的单元推送实时的 `session/projection` 帧。`session.search` 是对 `session.list` 可见会话的有界内容搜索投影：至多 20 个命中、每个摘要至多 240 个码点，且每个命中都对照可见集合重新校验。

### 工作区与会话列表

`session.list` 与 `workspace.list` 是彼此独立的重连基线。空白会话在首轮开始前保持隐藏，归档会把会话从分组表面隐藏而不触碰其日志，注销注册则保留目录与会话日志。冷摘要通过探测一个小型合格工件来验证空白状态；projection cache miss 或陈旧提示会回退到 `createdAt`，因此最近工作过的大型会话可能在下一个 checkpoint 前排得偏低。

### 导出会话

`GET /api/session.export?sessionId=…&includeDescendants=true` 流式输出一个 ZIP，其中每个会话的已存工件文本原样包含，每个子代理后代位于 `subagents/<id>/` 下，每张被引用的图片位于 `media/<attachmentId>.<ext>` 下。`HEAD` 在无请求体的情况下运行同样的根准备，因此浏览器能在把 GET 交给下载管理器之前检测到流前失败。响应边生成边分块输出，`sessionExportCompressionLevel`（0–9，默认 6）在 CPU 与延迟之间权衡归档大小。缺少 persistence、session-query 或 attachment 服务时回答 500，后端没有按会话原始工件时回答 501，根会话缺失时回答 404。

### 模型选择、preset、命令与配置

`session.models` 把当前 `ModelSelection` 与按提供方分组的咨询模型分开报告，`session.selectModel` 通过共享的 `agent-default-model` settings 分节把已接受的切换保存为部署默认值——指向不可用提供方的默认值仍会作为 `current` 送到选择器，而不是被静默替换。每次访问都先解析进程内选择，再读会话最新的 `request/header`，最后使用部署默认值。日志中标记为适配器默认值的推理强度不会进入恢复后的选择，因此下一次解析不会把它提升为显式选择，也不会记录虚假 header 变更。`agentPreset.list` 暴露部署的 preset 名单，每行带 `trust`，preset 无法组合会话时带 `broken` 原因；`agentPreset.select` 替换空白会话的组合，一旦跑过一轮即被拒绝。`skill.list` 为 composer 菜单提供每个 skill 的 `modelInvocable` 标志，`command.execute` 以纯准入语义运行斜杠命令，其结局由落账的 `command/run`／`command/done` 事件对承载。`settings.*`、`credentials.*` 与 `llm.*` 领域是配置页协议：`settings.describe` 返回每个 namespace 的 schema 与脱敏后的分层值，`settings.mutate` 是持有脱敏视图的客户端的删除路径，secret 绝不搭乘任何响应，`llm.discoverModels` 询问页面尚在起草的提供方端点而不写任何东西。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `nativeOpen` | 平台探测 | 部署能否把路径交给原生桌面打开器 |
| `sessionExportCompressionLevel` | `6` | 每个会话日志 ZIP 条目的 DEFLATE 级别，0–9 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-host-apiproxy)是每个受支持字段及其 JSDoc 的穷尽式真源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

本包建立在一个分离之上：API 约定与通道无关，物理传输只是围绕它的载体。协议消息构成一个二元可辨识联合——`ClientRequest`（POST `/api/<method>` 的请求体）与 `ServerResponse`（该 POST 的响应体）——与物理通道解耦。响应始终回显对应请求的 `rpcId`，绝不签发新值。业务错误由 `RpcResult` 的错误分支承载，其 `RpcErrorDetailsMap` 封闭错误码集合；HTTP 状态只表达载体层结果。分层与协议决策记录在 [GUI 分层与 RPC 协议 RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.zh.md) 中。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/api/`](src/api/) | 约定层：领域接口、payload 类型、zod schema、`RpcMethodMap`——零 Node 依赖 |
| [`src/fetch/handler.ts`](src/fetch/handler.ts) | 宿主载体：`toFetchHandler`、信封解析、一元分发、会话导出 |
| [`src/fetch/client.ts`](src/fetch/client.ts) | 客户端载体：`AbstractApiClient` 及平台子类、`InProcessApiClient` |
| [`src/api-proxy.ts`](src/api-proxy.ts) | 网关实现：基于所组合宿主上下文的 `createApiProxy` |
| [`src/session-export.ts`](src/session-export.ts) | 会话日志 ZIP 导出：原始工件读取、媒体收集、fflate 流式输出 |
| [`src/native-path-opener.ts`](src/native-path-opener.ts) | 平台路径打开器（`open`／`Invoke-Item`／`xdg-open`、WSL 转换） |

### 网关服务

`ApiProxyService` 提供 `ctx.apiProxy`，并基于所组合的宿主上下文实现约定——会话、工作区注册表、目录选择器、agent preset、设置、凭据、LLM、事件与下载。Host cwd 是默认项目目录。网关只在 `host.describe` 报告的部署元数据中消费 `ctx.agentDefaultModel`；保存已接受的切换由 Session Controller 的 `session.selectModel` 通过共享的 agent-default-model settings 分节完成。产品的 `dsh --profile headless` 是直连 core 的入口，不挂载本包。

### 请求流

请求进入载体，载体分两层解析信封与业务载荷、按方法分发，并返回回显请求 `rpcId` 的响应。服务器推送——会话与工作区 follow 流——搭乘 API Gateway 的 `/api/remote.mux` WebSocket，投递 `opened` 及之后无间隙的 `event` 帧，由客户端解码。一元请求携带载体的中止信号，因此调用方／连接的取消会传播到底层工作。

### 网关拥有什么

网关是协议约定外加一层对别处所拥有服务的宿主侧投影：它不发出任何 cordis 事件，它所投影的会话／agent 事件流由各自所属包的伴生插件断言。载体不持有其他领域的知识——每个投影值在注册表内部已经过其单元自己的 schema。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下内容。它们从分层决策进入浏览器侧消费架构与相邻子系统。

- [GUI 分层与 RPC 协议 RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.zh.md)——分层模型与通道无关的消息协议。
- [Web 客户端架构 RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)——浏览器如何消费该 API。
- [浏览器 HTTP 载体](../../client/connection/README.zh.md)——Host/Origin 检查、签名 cookie 认证，以及随发行版交付的 Web 组合注册的路由。
- [Web 服务器子系统](../../../docs/subsystems/web-server.zh.md)——载体所搭乘的 HTTP 服务器。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-host-apiproxy)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

无。该协议约定与 fetch 载体只搬运已组装好的消息，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明网关在何处不合适；它们是当前包约束，不是任务积压。

- **转发的 Remote 事件搭乘网关流帧封装**——投递路径复用 API Gateway 的 Remote 流 mux、不必新开第三条下行通道，因此读起来像是本包拥有 Remote 事件契约。并非如此：名单归 `dsh-api-remotes`，消费端动词是 `ctx.remote.$on`（[原委](../../../.agents/notes/implemented/architecture/2026-08-10-remote-event-delivery.zh.md)）。
- **待处理交互状态位于宿主侧**——浏览器的待处理交互快照由插件注册的待处理领域（用户提问与审批）折叠而成；wire 未定义专门的 respond 路由，也没有 `RpcReceipt` 类型。
- **预留 seam 不进入 `RpcMethodMap`**——`prompt.mode: 'inject'`、`job.list` 和描述字段 `hostInstanceId` 都是已记录的预留项；模型发现使用 `llm.models`。未知方法会在信封解析时直接失败，而不会返回「尚未实现」错误码。
- **没有协议版本字段**——客户端与宿主一同发布；只有出现独立发布的客户端后，`host.describe` 才会增加版本协商字段。
- **搜索失败会包含提供方诊断信息**——网关是单用户本地服务；将其暴露给多名用户的载体必须用可安全公开的诊断信息替代内部搜索细节。
- **Linux 原生选择器依赖桌面工具**——在 `native` 能力下，Zenity 和 KDialog 均未安装时，`host.pickDirectory` 会给出包含解决建议的错误提示；组合层面的回退是浏览后端（见 [native 后端 README](../directory-picker-native/README.zh.md)）。
- **冷列表提示只向“保持可见、排序偏旧”降级**——projection cache miss 或陈旧的 `lastPromptAt` 会回退到 `createdAt`，除非符合资格的小工件提供精确折叠。[有界空白验证决策](../../../.agents/notes/implemented/bug-fix/2026-08-13-bounded-cold-blank-verification.zh.md)规定了这个安全方向；权威且精确的最近时间索引仍属于[最后活动索引提案](../../../.agents/notes/proposed/architecture/2026-07-29-durable-last-activity-index.zh.md)的范围。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放方向。它明确不具权威性——已交付行为与限制见上文各节。协议版本字段等待独立发布的客户端；多用户载体必须把提供方搜索诊断替换为可安全公开的文本；按连接的自适应目录选择（本地浏览器用 native、远程浏览器用 browse）仍是宿主表面的一个未定方向。

</details>
