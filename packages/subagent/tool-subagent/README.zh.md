# @deepseek-ai/dsh-tool-subagent

[English](README.md) | 中文

基于一个已配置 `ctx.subagents` 提供方、面向模型的委派工具。更换提供方只会改变传输，不会改变执行约定。

## 提供方选择与生命周期

每个插件实例把一个 subagent 传输 `provider` 绑定到一个 `toolName`；模型不能改变该传输。如需公开另一种传输，请加载另一个名称不同的实例。`enableModelSelection: true`，或 `modelSelectionSettings: true` 时已启用的 Host 偏好，都要求该提供方具备子级 `agentOptions` 能力，并且无需额外路由配置即可公开可选的子 agent LLM `provider`、`model` 与 `reasoning_effort` 字段。调用可以提供完整的提供方／模型对；当配置值、父 Agent 值或提供方持有的路由默认值能够提供生效路由时，也可以只提供推理强度。静态的 `provider.agentRouteDefaults` 在存在时构成 provider／model 基线；工具配置与模型字段会在路由相关强度合并和确切路由预检前覆盖它。没有这些默认值的提供方会从父 Agent 最新记录的请求选择中保留兼容的缺失值；首个请求之前回退到其创建选项，并保留其中配置的 `maxTokens`。如果更换提供方或模型但没有指定强度，则清除下层路由所属的强度，使所选模型解析自己的默认值。

委派工具只在其 subagent 提供方存在时注册，从而避免对同级加载顺序和提供方重新加载的依赖。启用模型选择时，即使没有 `ctx.llm`，可选字段仍然可见；选择路由的调用会在该服务缺失时失败。禁用时，schema 会省略这些字段，执行阶段也会拒绝强制传入的选择。配置的 `agentOptions` 仍是部署方所有的子级默认值，不受这个面向模型的开关影响。adapter 目录和拓扑变化不会改写或重新注册工具。工具描述遵循 `provider.inheritsParentContext`：新建子 agent（智能体）需要独立提示词，而 fork 子 agent 已能看到父级已完成轮次。

启用的定义会注册 `list_subagent_models`，它会在调用时列出已注册提供方、某个提供方公布的模型，或某个精确模型的推理强度。因为发现工具使用全局名称，一个工具作用域最多只能由一个实例启用选择；多个持有方会使注册失败。随附产品组合默认关闭主 `subagent`（`spawn`）实例，并在每个新的顶层会话完成组合时读取 Host 的 `subagent-model-selection.enabled` 偏好。启用决定记录为 `subagent/model-selection-enabled`，由子会话继承并在恢复时保留；之后修改设置不会改变运行中的会话。组合会刻意在 `subagent_fork` 上保持禁用，使 fork 继承父级的提供方与模型：更改该路由会失去继承对话前缀的提供方侧 KV Cache 复用，重新计算前缀的成本可能超过委派任务本身。即使分离发现工具的持有权，该限制也仍然成立。目录条目仍只提供建议：如果适配器接受未列出的模型 ID，启用选择的委派工具也会接受。理由与重新开放条件由[模型选择路由 Agent Note](../../../.agents/notes/implemented/feature/2026-08-18-model-selected-subagent-routes.zh.md)负责。

前台调用会让执行信号贯穿启动和执行，等待 `run.result`，并且在返回前总会等待 `run.dispose()`。只有 `completed` 会返回规范值 `{ kind: 'foreground', runId, output: JsonValue[] }`，并渲染为相同的最终文本。中止、拒绝、token 上限和其他失败都会变成出错的工具结果，其消息依次包含终止原因标题、可选的提供方 `SubagentResult.diagnostic`，以及子 agent 保留下来的部分 assistant 文本。诊断与 `SubagentResult.output` 保持分离，因此被截断的回答不会被报告为成功，也不会与基础设施说明混淆。如果结果收集与 dispose（资源释放）都 reject，出错结果会保留两项失败。

`backgroundMode` 同时选择后台路由与省略 `run_in_background` 时的默认行为。`one-shot` 默认在前台等待；显式传入 `true` 时，它会注册一个归父级所有的普通 Task，并返回规范值 `{ kind: 'background', jobId }`，渲染为 `started background subagent job <id>`，即使提供方支持可继续子 agent 也不例外。通用 Task 工具负责其后续状态、收集、取消和通知；失败 Task 的 detail 会保留终止原因与同一份可选提供方诊断。`continuable` 在参数省略或为 `true` 时于后台运行；显式传入 `false` 时则在前台等待结果。其后台路由要求提供方具备 `prepareContinuable` 能力，调用 `ctx.subagents.startContinuable()`，并返回 `{ kind: 'continuable', subagentId }`，渲染为 `started subagent <childId>`。该路由在 inbox 接受时结算：子 agent 自此拥有自己的轮次，因此该调用既不等待也不收集结果。通过该 id 查看其 transcript（文本记录）仍是其详细输出的来源，可选的全局 `send_message` 工具则向其发送更多工作。每当子 agent 的 Activation 结束，继续执行服务都会投递一条结算通知，其中包含结束结果及可能存在的最终 assistant 消息，且这项投递不依赖 `report`。启动可继续工作不要求加载 `send_message`。见[后台 subagent Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-background-subagent-tasks.zh.md)、[可继续的 subagent Agent Note](../../../.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.zh.md)和[后台优先委派 Agent Note](../../../.agents/notes/implemented/feature/2026-08-11-background-first-continuable-delegation.zh.md)。

`toolFilter` 会改变子 agent 的全局工具层，但不是从父级派生的权限上限。见 [agent 作用域的安全非目标](../../../.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.zh.md#security-and-authority-are-non-goals)。

## 配置

| 键 | 含义 |
|---|---|
| `provider`（必填） | 提供方名称（`spawn`、`fork`、`acp` 等）。 |
| `toolName` | 面向模型的名称，默认 `subagent`；每个已加载实例必须不同。 |
| `enableModelSelection` | 公开并接受面向模型的子级 LLM 选择字段，同时注册共享的 `list_subagent_models` 工具；默认为 `false`。它要求 subagent 提供方具备 `agentOptions` 能力。一个工具作用域最多只能由一个实例启用；即使没有 `ctx.llm`，发现 schema 仍保持注册，而发现调用和所选路由调用会在该可选服务可用前失败。禁用此开关时仍可配置 `agentOptions`。 |
| `modelSelectionSettings` | 组合 Agent 时读取 Host 的 `subagent-model-selection` 偏好，把启用决定记录进其 Session，并让子 Session 继承该决定。默认为 `false`；与 `enableModelSelection` 互斥，且只能用于 Agent 作用域组合。该偏好默认关闭，只影响之后组合的新顶层 Session。 |
| `enableRunInBackground` | 公开后台模式，默认 `true`；禁用时也会拒绝强制后台调用。 |
| `backgroundMode` | 后台生命周期策略，默认 `one-shot`。`one-shot` 默认前台调用；`continuable` 默认后台调用，要求提供方具备 `prepareContinuable` 能力，并返回持久化子 agent ID，且不要求加载后续消息工具。 |
| `agentOptions` | 配置的子 agent LLM `provider`、`model`、adapter 自有 `reasoningEffort` 与正整数 `maxTokens`；要求 subagent 提供方具备 `agentOptions` 能力。静态提供方路由默认值在存在时会先于工具配置与模型覆盖合并；否则进程内提供方会把显式值合并到父 Agent 最新记录的请求选择之上，首个请求之前则合并到其创建选项之上。只有生效提供方／模型路由不变时才会保留继承的推理强度；改变路由但不显式提供强度时，由所选模型提供默认值。即使调用省略模型选择字段，配置的提供方、模型或强度也会在创建子 agent 前通过可选 `ctx.llm` 服务进行校验；服务缺失或值无效都会拒绝调用。 |
| `persona` | 每个子 agent 独立的 persona；要求提供方具备 `persona` 能力。 |
| `toolFilter` | 每个子 agent 独立的全局工具限制；要求提供方具备 `toolFilter` 能力。 |
| `maxDepth` | 绝对委派深度上限，默认 `3`（`0` 禁止委派）；数值上限要求 `depthLimit` 能力，缺失时挂载失败。对于预算由子 harness 拥有的进程外提供方，`'provider-managed'` 不发送上限。工具在达到上限时仍然可见；每次尝试启动都会检查调用 agent 的当前深度，被拒绝时返回出错的工具结果。 |

## 并发

前台调用和后台调用均并发安全：同一条 assistant 消息中的同级委派会在循环的滚动池（`maxParallelToolCalls`）下重叠执行，结果仍按模型顺序提交。子 agent 在各自的会话中工作，一次运行绝不变更父会话；一次性后台形态对父级拥有状态的唯一写入是注册一个 Task——这是一次同步、可交换、能容忍并发分发的插入，因此重叠的后台调用按分发竞态顺序获得各自的 job id。协调同级工作区效果由模型负责，正如模型已经对后台和可继续子 agent 所承担的那样。见 [并行 subagent Agent Note](../../../.agents/notes/implemented/feature/2026-08-09-parallel-subagent-delegations.zh.md) 和 [并行工具调用 Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.zh.md)。

## 模型体验

### 工具 schema

#### 模型看到的内容

当提供方存在时，以当前实例配置的名称公开已生成的默认 [`subagent` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent)。`enableModelSelection` 会添加 `provider`、`model` 与 `reasoning_effort`，以及继承和选择指引；提供方必须支持 `agentOptions`。提供方是否继承上下文会改变工具描述和提示词描述。启用后台模式会添加 `run_in_background`：可继续模式会记录其默认值为 `true`、运行时结算通知与显式前台覆盖；一次性模式会记录其默认值为 `false`，以及用 `job_output` 收集或用 `job_kill` 停止的 job id。当工具在本次组装的作用域中可见时，一个 `tool:<toolName>` 系统提示词 section 会指示模型同时启动相互独立的可继续委派、在它们运行时继续工作，并且仅当下一步动作依赖结果时选择前台；工具限制会同时移除其 schema 和这段指引。

#### Token 影响

每个父级请求都会产生固定的 schema token 开销；启用模型选择会增加三个参数。每个 subagent 提供方实例增加一个 schema，每个可继续实例还会增加一个简短的系统提示词 section。

#### KV Cache 影响

只要 subagent 提供方实例及其配置不变，前缀就保持稳定。adapter 目录变化不会改变定义。具备继承能力的实例如果覆盖路由，可能阻止子 agent 复用继承的父级前缀。

### 模型选择与发现

#### 模型看到的内容

静态配置 `enableModelSelection: true` 的实例，或 Session 决定为启用的 settings 控制实例，会公开子级 LLM 选择字段与 `list_subagent_models`。可选 `ctx.llm` 服务不可用时，调用会失败。无参数调用发现工具会返回已注册提供方的 ID 和名称；提供 `provider` 时返回该适配器公布的模型；同时提供 `provider` 和 `model` 时解析精确模型，并返回其公布的推理强度和默认值。结果是只读的运行时元数据，不是授权列表。

#### Token 影响

随附组合会包含一个固定工具 schema。只有模型调用该工具时，目录内容才会进入 transcript。

#### KV Cache 影响

adapter 注册和目录变化不会改变 schema 的前缀稳定性。每次结果都追加在可复用前缀之后。

### 前台结果

#### 模型看到的内容

调用会保留描述和提示词。成功时只包含子 agent 的最终文本；其他结果会变为 `Error: <终止原因>`，随后在存在时附上安全的提供方诊断，再附上任何部分 assistant 文本。子 agent 中间步骤不会进入父级。

#### Token 影响

提示词和结果会留在父级历史中，直到上下文压缩（context compaction）；子 agent 工作上下文留在子 agent 中。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 后台结果

#### 模型看到的内容

在配置的可继续模式下，启动时返回内容恰为 `started subagent <childId>`；在配置的一次性模式下，则返回 `started background subagent job <id>`。一次性模式下，通用 Task 接口提供后续状态、最终输出、取消响应和通知；若结果携带提供方诊断，失败状态的 detail 会包含它。可继续模式下，本工具不返回自己的结果；子 agent 的结算会以[服务负责的通知](../subagent/README.zh.md#settlement-notice)到达父级，独立加载的 `send_message` 工具会投递后续消息，而通过其 id 查看子 agent 的 transcript 即是其详细输出来源。

#### Token 影响

确认消息会被保留；一次性最终输出只在收集或注入时进入父级历史，而可继续子 agent 的输出绝不会通过本工具返回——其结算通知独立于任何工具结果到达。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与暂缓事项

- **后台运行不通过本工具公开结果**：一次性任务的最终输出通过通用 Task 接口收集，可继续子 agent 的输出留在其自身会话中，按其 subagent id 读取。结算通知会说明该子 agent 如何结束，并携带可能存在的最终 assistant 消息，但它不是本次调用的返回值，也无法在此等待。
- **等待中的一次性实例较晚才发现重复名称**（`TODO(subagent-dup-toolname)`）：可继续实例会在插件应用期间预留提示词 section 名称，但若要阻止等待中的一次性实例回滚提供方注册，仍需要一份预期名称注册表。
- **随附 fork 工具无法选择子级 LLM 路由**：它们会继承父级的提供方与模型，使复制的对话前缀仍可供 KV Cache 复用。只有在路由变化仍能保留复用，或接口能公开一项有界的重算成本时，才重新启用这些字段。
- **每个实例的非路由子 agent 策略固定**：其他 persona、工具过滤器或深度上限都需要另一个名称不同的工具。LLM 提供方／模型／推理强度选择要求静态启用或每 Session 偏好已启用，并要求 subagent 提供方声明 `agentOptions`；ACP、Codex 与 Claude Code 会拒绝它，而不是忽略它。
