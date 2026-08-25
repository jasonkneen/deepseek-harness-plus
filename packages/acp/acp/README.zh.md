# @deepseek-ai/dsh-acp

[English](README.md) | 中文

通过 JSON-RPC stdio 提供的仅面向自动化的 [Agent Client Protocol](https://agentclientprotocol.com) v1 服务器。受信任的程序化客户端可以发现标准配置、创建或恢复持久化的 harness Agent、挂载 MCP 服务器、提示和取消工作、接收语义执行更新，并在不影响其他会话的情况下关闭单个会话。

此包不是 UI 集成。它只发出标准 ACP 语义数据，绝不发出 DSH 展示卡片、终端视图、diff、位置、计划、标题、todo、自定义方法、自定义能力标记或 DSH 专用 `_meta`。客户端 `_meta` 仅作为协议元数据接收，不具有 DSH 私有含义。

## 插件

`apply(ctx, config)` 在 stdin/stdout 上打开 ACP SDK agent app，并驱动 `ctx.agents`。Stdout 专用于协议帧。完整生命周期支持要求挂载 `ctx.sessionPersistence`。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `provider` | 无 | 每个新建或恢复 Agent 的初始提供方路由。 |
| `model` | 无 | 每个新建或恢复 Agent 的初始确切模型。 |
| `sessionListPageSize` | `100` | 单个 `session/list` 页面返回的摘要数量上限，必须为正数。 |

当另一个 Agent 请求监听器提供初始路由时，可以省略 `provider` 和 `model`。可运行 ACP 组合同时要求两者。

<a id="standard-acp-v1-surface"></a>

## 标准 ACP v1 接口

| 方法或通知 | 行为 |
|---|---|
| `initialize` | 协商稳定 ACP v1。公布标准 `session/list`、`session/resume`、`session/close` 和 Streamable HTTP MCP 支持。只有持久附件存储和配置的确切路由都支持图片时，才公布图片提示词能力。 |
| `authenticate` | 空操作，因为服务器不公布身份验证方法。 |
| `session/new` | 使用绝对主 `cwd` 创建一个 Agent；在公布 Agent 前校验并挂载标准 stdio 或 HTTP MCP 服务器；显式实体化其持久 header；返回完整配置选项状态。 |
| `session/list` | 按创建时间从新到旧，确定性分页返回已持久化且可恢复的顶层会话。摘要只包含 `sessionId` 和绝对 `cwd`；cursor 是不透明的 keyset token。可选绝对 `cwd` 过滤器会在路径存在时比较物理目录身份。活动会话以及 subagent／fork 后代不会出现。 |
| `session/resume` | 拒绝活动 id；在组合 Agent 前校验持久化会话的规范工作区；恢复日志但不向客户端重放；挂载该请求的 MCP 服务器；返回完整配置选项状态。 |
| `session/close` | 取消活动工作、drain 有序更新和可继续后代、flush 持久化，并只释放该 Agent scope。持久化状态仍可供 `session/list` 和 `session/resume` 使用。 |
| `session/set_config_option` | 设置已公布的 `model` 或 `reasoning_effort` 值，并返回完整结果状态。无效 id 或值以 invalid params 拒绝。 |
| `session/prompt` | 准入有序文本、资源链接和受支持图片；每个会话只允许一个进行中的提示词；只在 Agent 空闲且有序更新交付完成后结算。 |
| `session/cancel` | 通过提示词自有取消路径取消指定的准入或轮次。没有 ACP 提示词进行时取消自主工作；未知 id 为空操作。 |
| `$/cancel_request` | 取消 `session/prompt` JSON-RPC 请求时，使用与 `session/cancel` 相同的提示词自有路径。 |
| `session/update` | 发出下文所述的已提交消息、思考、通用工具生命周期、配置和上下文用量更新。 |
| `session/request_permission` | 在引用的 `tool_call` 通知交付后，请求一次标准的一次性允许或拒绝决定。 |

未支持的接口不会出现在能力中，或在被调用时拒绝：`session/load`、`session/delete`、`session/fork`、附加目录、SSE 和 ACP 传输 MCP、模式、命令、计划、终端、客户端文件系统操作以及 elicitation。

## 会话配置

每个新建或恢复的会话都会返回标准 select 选项：

- `model` 根据建议性 LLM catalog 按提供方分组。值是不透明字符串，携带确切的提供方／模型对；客户端必须原样返回。
- `reasoning_effort` 来自所选确切模型；该模型未声明推理选项时省略。如果 adapter 公开选项但保留提供方自身默认值，`Provider default` 选项表示不显式指定 effort。

ACP 插件的 `provider` 和 `model` 配置建立初始选择。Adapter 拓扑变化会发送包含完整当前状态的 `config_option_update`。每个会话会串行处理配置变更。

已接受的提示词会在异步图片准入前快照所选路由。Per-session 模块会把该快照与已识别 inbox 消息关联到 claim 时刻，再把同一提供方、模型和 reasoning effort 固定到图片校验、提示词变量以及该轮次中的每个模型步骤。并发配置变更从下一个 ACP 轮次开始生效。

## MCP 信任与隔离

ACP 客户端是受信任的自动化控制器。stdio 声明授权 DSH 在会话 `cwd` 中执行其绝对命令，并使用所给参数和环境项。HTTP 声明授权向其绝对 HTTP(S) URL 发送带所给 header 的请求。DSH 不重新解释客户端元数据，也不增加私有 cwd、超时或传输字段。

服务器名称会经过校验并转换为稳定的 DSH MCP namespace；重复的规范化名称会在 Agent 公布前拒绝。环境变量名／值和 HTTP header 会被校验，其中 header 重复检查不区分大小写。标准 stdio 与 Streamable HTTP 客户端使用 `dsh-mcp-client` 现有的工具调用超时和重连默认值。初始连接和工具发现必须成功，因此任何失败都会回滚尚未公布的 Agent。

每个 Agent scope 拥有自己的 MCP 注册和连接。因此，独立 ACP 会话可以使用相同服务器 namespace，而同一会话内的重复仍会失败。会话关闭、连接丢失和插件释放都会移除 scoped 工具和传输。

## 语义更新

每个会话会串行交付更新，并在提示词完成前 drain：

| 持久 DSH 事实 | 标准 ACP 更新 |
|---|---|
| 已提交 assistant 文本或图片 | 携带持久消息 id 的 `agent_message_chunk` |
| 已提交 reasoning | 携带持久消息 id 的 `agent_thought_chunk` |
| 持久工具调用 | `tool_call`：使用 DSH call id、规范 DSH 工具名作为 `title`、通用 `other` kind，并在参数为有效 JSON 时提供解析后的输入 |
| 持久工具结果 | `tool_call_update`：使用相同 call id、completed／failed 状态和标准内容块 |
| 已知上下文容量和已测上下文压力 | `usage_update` |
| LLM adapter 拓扑变化 | 包含全部选项的 `config_option_update` |

原始模型 delta、重试尝试、展示数据和不受支持的核心内容绝不会进入 ACP wire。已提交图片在以内联 base64 交付前会重新读取并校验完整性。已提交图片缺失或损坏会使关联提示词失败，而不会产生占位符。

## 生命周期与结果

一个连接可以拥有多个独立会话。事件和权限路由会校验确切 Agent 身份。每个 per-session 模块拥有自己的 Agent handle、MCP 挂载、未来选择和轮次固定的模型选择、提示词槽位、更新链以及记忆化关闭操作。

显式关闭、连接丢失和插件释放使用同一个完全停稳的 teardown。Teardown 会停止新工作、取消提示词准入和 Agent 活动、drain 已提交更新、按 child-first 顺序释放可继续后代、flush 会话，并释放每个 Agent scope。只有在所有自有 teardown 工作结算后才报告失败；共享该 Context 的其他前端不受影响。

提示词结算优先级依次为显式取消、已提交输出失败、区间内 Agent 失败、关联轮次结束。标准结果包括 `end_turn`、`max_tokens` 和 `cancelled`；关联模型失败成为标准 JSON-RPC error。不会返回额外 DSH 结果对象。

## 运行

`pnpm --dir /path/to/deepseek-harness dsh --profile acp` 启动仓库的自动化服务器 profile。通用 keyless conformance 测试通过 `dsh` 启动此 profile，并只使用 ACP SDK 驱动它，覆盖模型选择、MCP 挂载、关闭、进程重启、列出／恢复和取消。

## 模型体验

### 提示词内容

#### 模型看到的内容

`session/prompt` 产生普通的已记录用户消息。文本／图片顺序会保留；相邻文本会拼接；资源链接会变成带方括号的 `[resource_link name=… uri=…]` 引用。内联图片 base64 在持久准入后即被丢弃。协议元数据、客户端能力、权限选择、会话 id 和 ACP 配置对象不会进入模型请求。

#### Token 影响

提示词内容、工具调用／结果和持久图片引用会保留在该会话中直到 compaction。并发会话保留独立上下文。

#### KV Cache 影响

当所选路由和已组装前缀不变时仅追加。模型变更会让下一个 ACP 轮次使用新路由。

## 已知限制与暂缓事项

- 只支持一个主 workspace。附加目录仍不受支持。
- 提示词图片只支持 PNG、JPEG、WebP 和 GIF，并受附件存储和确切模型路由约束。
- MCP resource 和 prompt 没有 DSH consumer；ACP 挂载只公开 MCP 工具。
- 会话删除、fork、通过 `session/load` 重放 transcript、模式、命令、计划、终端、客户端文件系统操作和 elicitation 仍不属于此自动化接口。
