# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

协议与连接世代层：Client 插件挂载 `ctx.connection`，包含共享 API 客户端、当前页面的 loopback 状态、按 generation 生效的可观察 `hostDescription`、通用 RPC carrier，以及单一 generation source 与连接循环的注册面。每个 generation 只在 source 已就绪且 `host.describe` 成功后发布 `hostDescription` 并调用 `onConnected`；source 结束、失败、被撤回或显式 stop 都会清空该值，再由 `ConnectionController` 退避重连。

浏览器通过 HTTP POST 执行 API Proxy 一元调用与通用 Remote 一元调用；API Gateway 自己拥有 `/api/remote.mux` WebSocket 及其逻辑流。进程内组合通过 `connection.rpc.open` 提供等价的 Remote 流，不打开 WebSocket。Host half 拥有唯一 `/api` route、Fetch bridge 和信任校验；Typert Gateway 先认领自己的 Remote endpoint，未认领的请求再回退 API Proxy。Loopback hostname 判定留在包内：Host fence 与 WebSocket upgrade 直接使用它，其他 Client 插件消费 `ctx.connection.isLoopback`。

node 半侧的 `/api` 路由让特权方法集（`host.pickDirectory`、`host.openPath`，整个 settings 与 credentials 配置面，`llm.discoverModels`，以及 `agentPreset.read`/`copy`/`openDocument`/`remove`）以空信任表过 fence，从而钉在回环本机。`agentPreset.list` 与 `agentPreset.select` 不在其中：名单只携带 id 与信任级别，而 `session.create` 已能选择 preset。已声明的 `trustedHosts` 授权可达其余方法；在真正的认证层出现前，特权面始终只限回环。

## /api 浏览器信任栅栏

node 半侧在桥接或 upgrade 前守卫 `/api` 下的每个入口（`src/api-request-trust.ts`）。每个请求——无论是否带浏览器标记——`Host` 都必须是回环地址权威，或与某个 `trustedHosts` 条目匹配：带端口的 `host:port` 条目精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化后比较（DNS rebinding 防御）。刻意不为无浏览器标记的 HTTP 请求开捷径：明文 HTTP 下浏览器的图片与导航读取既不带 `Origin` 也不带 Fetch-Metadata，因此无标记请求仍可能是被重绑页面发起的、响应可被读走的读取，而 Host 是重绑唯一伪造不了的请求头；WebSocket 浏览器握手会带 `Origin` 并通过同一道比较。非浏览器客户端经由回环地址、部署推导的 LAN IP 字面量或已声明的权威通过同一道栅栏。当标记存在时，如附带 `Origin`，则它必须与 Host 权威完全一致；显式的 `sec-fetch-site: cross-site` 标记一律拒绝。不是纯的、规范形 `host[:port]` 权威的 `trustedHosts` 条目——即 WHATWG 解析读回后与原文不完全一致的——会让插件加载明确报错：否则解析会悄悄授权 `harness.internal/path` 这类笔误里的 hostname，或把悬空冒号、补零端口放大成任意端口授权。HTTP 失败在任何 RPC 分发之前以纯 403 应答，upgrade 失败在启动任何事件流前拒绝握手。非回环组合必须显式信任其服务权威：Web 运行时从全接口服务器配置推导 LAN IP 字面量，cordis.yml 中的 `trustedHosts` 与 CLI（命令行界面）的 `--trusted-host` flag 则声明具名权威。`dsh web --host 0.0.0.0` 在远程访问具备认证层之前有意不受支持。这道栅栏是可达性策略，而不是认证；Web 载体不提供认证层。决策记录：[api 浏览器信任边界 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md)。

## Connection generation

API Gateway Client 把内部 `$events` logical stream 注册为唯一 generation source，与有无 `$on` 订阅无关。Host 在 API Remotes source factory 同步挂好所有增量 listener 后，先发送唯一 `{ type: 'ready' }` 项，再发送事件。`ConnectionController` 并行等待该 ready 与 `host.describe`；只有两者都成功才允许 `onConnected` 启动 baseline 读取，因此 baseline 不会跑在增量 listener 前面。

`$events` 结束、返回 Remote stream error、收到非 ready 首项或畸形事件项，都会使当前 generation 失效。Controller 立即撤回 `hostDescription`、发布 `reconnecting`，并在退避后重建 `$events` 与 `host.describe` 握手。Gateway mux 自己负责重建底层 WebSocket；Connection 世代负责重建 logical stream 与 baseline 起点。

## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **`/api` 桥把每个请求体整体缓冲在内存里**：`maxRequestBodyBytes`（默认 300 MiB，按默认 200 MiB 图片总量上限经 base64 膨胀加信封余量得出）因此同时是单请求的驻留内存上界；要降低它而不缩小图片限额，需要流式请求体路径。
