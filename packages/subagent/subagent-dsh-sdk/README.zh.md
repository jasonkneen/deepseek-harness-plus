# @deepseek-ai/dsh-subagent-dsh-sdk

[English](README.md) | 中文

SDK 提供方会在全新的子进程中把每个 subagent 作为完整的 DeepSeek Harness 运行时运行，并经由 [TypeScript SDK 客户端](../../sdk/client/README.zh.md) 通过 stdio JSON-RPC 驱动。它是 [`subagent-acp`](../subagent-acp/README.zh.md) 之外的第二个进程外后端，差异在协议格式（wire format）和子应用：ACP（Agent Client Protocol）后端能驱动任何 Agent Client Protocol agent（智能体）；本后端启动同版本的 `dsh --profile sdk` 应用，因此子进程拥有自己的 profile 与 patch 组合、会话持久化、模型路由和工具。

## 启动与所有权

`start(request)` 会在 spawn 前解析子进程工作目录与一条进程级 SDK 路由。`request.agentOptions` 中每个已声明字段（`provider`、`model`、`reasoningEffort` 或 `maxTokens`）都会覆盖对应的提供方实例默认值；省略时保留已配置的提供方／模型与可选上限，而推理强度只有在请求提供时才会出现。随后，提供方通过 `DeepSeekHarness` spawn 运行时，并在履行前完成子运行时的 `initialize` 握手，其中包括确切模型与推理强度校验。因此，履行意味着子运行时已就绪、所有权已移交给调用方。路由、spawn、握手或发布前取消失败时，只会在子进程被回收后拒绝；工作目录解析失败则会在尚未 spawn 任何内容时拒绝。

工作目录的解析与 ACP 后端完全一致，并使用 seam 共享的进程外辅助工具（[`dsh-subagent`](../subagent/README.zh.md)）：设置了 `cwd` 覆盖值时使用该值（加载时校验一次），否则使用发起委派的父会话 cwd，绝不使用服务器进程自身的 cwd。解析出的路径同时成为子进程 cwd 和其 SDK 会话的工作区 cwd。`dshHome` 必须另外指定为绝对路径，使嵌套运行时不会意外共享父运行时的 profile、插件安装或会话存储。

返回的 run id 在父级命名空间中生成；子运行时的会话 id 只存在于子进程内部。发布后，提供方拥有一段 SDK 活动，并从子会话事件中读取答案：最后一条完整且非空的 `assistant/message`（记录 usage 的空内容消息会被跳过）；若没有这类消息，则取累积的 `text-delta` 流。取消或发生错误后，部分输出仍然可用。

`dispose()`（资源释放）是幂等的：先在本地把结果确定为 `aborted`（协议层面没有提示词取消机制），再关闭运行时，即先发出一次有界的协议 `shutdown` 请求，随后通过共享的 stdin-EOF → SIGTERM → SIGKILL 阶梯使进程实际退出。

## 停止原因映射

SDK 客户端返回自有子活动，而不是提示词结果。提供方读取该活动内最后一个已持久化的 `turn/end`，并将其映射为 seam 词汇：`completed` → `completed`，`max-tokens` → `max-tokens`，`aborted` → `aborted`；其余情况，包括 `error`、`interrupted`、`disposed`、未来变体或不含轮次的活动，均映射为 `error`，因此非正常停止绝不会报告为成功。发布后的传输层失败会通过 `onError` 诊断接收器（连接到 `ctx.logger.warn`）压平为 `stopReason: 'error'`；seam 约定禁止 `result` 被拒绝。

## 能力与上下文

提供方声明 `agentOptions: true`，同时保持 `outputSchema`/`depthLimit`/`toolFilter`/`persona` 为 false，并且 `inheritsParentContext: false`。不可变的 `agentRouteDefaults` 会在模型覆盖与确切路由预检前，把配置的 provider／model 基线公开给 `dsh-tool-subagent`；`start()` 则为直接调用方与 maxTokens 独立应用同一份 Config 默认值。Agent 路由值通过显式白名单跨越 SDK 协议；子进程仍是另一进程里的全新运行时，唯一从父 Agent 本身派生的值是工作区 cwd。基于本提供方的 `dsh-tool-subagent` 部署应设置 `maxDepth: 'provider-managed'`——子 harness 拥有自己的递归预算。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `providerName` | `dsh-sdk` | `ctx.subagents` 上的注册名。 |
| `dshBin` | SDK 同版本依赖 | 显式 dsh CLI 模块覆盖；相对路径在 plugin 加载时解析，且必须指向已有文件；普通部署应省略。 |
| `profile` | `sdk` | 为每个子进程启动的具名 dsh profile；该 profile 必须包含 SDK app。 |
| `patches` | `[]` | 有序的逐次启动 profile patch 文件；相对路径在 plugin 加载时解析，每个路径都必须指向已有文件。 |
| `dshHome` | 必填 | 嵌套运行时的绝对隔离 dsh home，用于 profile、已安装插件和会话数据。 |
| `cwd` | 父会话 cwd | 工作目录覆盖；校验规则与 [`subagent-acp`](../subagent-acp/README.zh.md) 相同。 |
| `provider` | `deepseek-official` | 写入子进程 `initialize` 的提供方路由。 |
| `model` | `deepseek-v4-flash` | 写入子进程 `initialize` 的模型。 |
| `maxTokens` | 适配器／提供方路由默认值 | 写入子进程 `initialize` 的单次请求输出 token 上限；对子运行时的根 agent 及其进程内后代生效。 |
| `env` | `{}` | 在凭据擦除后的父环境之上叠加的显式子环境，例如子进程自己的 `DEEPSEEK_API_KEY`。 |
| `shutdownTimeoutMs` | `1000` | dispose 期间协议 `shutdown` 交换的时限。 |
| `disposeEofGraceMs` | `6000` | stdin EOF 之后、平台终止之前的宽限。 |
| `disposeGraceMs` | `3000` | 终止后的退出确认窗口；POSIX 在 SIGTERM 之后、SIGKILL 之前也等待同样时长。 |

请求 `agentOptions` 会分别覆盖 `provider`、`model` 与 `maxTokens`。`reasoningEffort` 没有提供方实例默认值：请求省略时保持缺省，由所选子模型解析自身默认值。面向模型的 subagent 工具可在每次调用时选择提供方／模型／推理强度；`maxTokens` 仍由工具配置或本提供方默认值在部署侧控制。

```yaml
- id: subagent-dsh-sdk
  name: '@deepseek-ai/dsh-subagent-dsh-sdk'
  config:
    providerName: dsh-sdk
    profile: sdk
    patches: ['./profiles/research-child.cordis.yml']
    dshHome: !!js dshHomePath('children')
    maxTokens: 49152
    env:
      DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config: { provider: dsh-sdk, toolName: subagent, maxDepth: 'provider-managed' }
```

## 进程边界

子进程环境以 [`dsh-subprocess`](../../subprocess/README.zh.md) seam 的 `scrubbedParentEnv()` 为基础，先移除疑似凭据和名称为 `DSH_*` 的环境变量，再合并显式 `config.env` 值。子进程由 SDK 客户端 spawn，而不是经由 `ctx.subprocess` spawn（这是 subprocess README 中记录的 SDK 托管传输例外），因此本后端会自行执行环境清理。JSON-RPC 协议格式才是真正的序列化边界。

本包没有默认导出。否则 Cordis loader 解包会隐藏具名 `inject` 元数据；见[事故复盘（postmortem）0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)。

## 模型体验

### 子 agent 请求

#### 模型看到的内容

子运行时的模型会收到作为用户消息的独立任务，以及该运行时自身配置的系统提示词、工具和全新会话。它不会收到父级对话。父级工具调用可以为本次运行选择子级提供方、模型与推理强度；所选路由和部署持有的可选输出上限会固定到这个新子进程。persona、工具过滤、深度强制与结构化输出仍不受支持，并会被拒绝而不是静默省略。

#### Token 影响

子运行时会为独立的完整上下文及其多步骤历史消耗 token。这些 token 绝不会进入父级上下文。

#### KV Cache 影响

与父级请求缓存相互独立。每个 SDK 子进程只能复用其自身提供方、模型、组合和历史均相同时的前缀；除此之外，子 agent 的步骤仅追加增长。

### 父级工具结果（间接）

#### 模型看到的内容

经由 `dsh-tool-subagent`，父级只会收到子运行时最终的 assistant 文本（或累积的部分文本），或该消费方给出的精确停止原因错误；不会收到中间消息或工具流量。

#### Token 影响

父级输入只增加最终结果或错误，其大小取决于数据，并保留到压缩（compaction）为止。本提供方自身不会向父级添加任何 schema。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与暂缓事项

- **每次运行都使用全新的运行时进程**：不使用进程池；harness 运行时需要启动完整的插件树，因此每次运行的 spawn 成本高于 ACP 后端通常使用的子进程。
- **不支持路由之外的启动时能力**：父级可以选择子 Agent 路由，但无法在子进程内强制执行 `outputSchema`、深度限制、工具过滤或 persona；应改为配置所选子 profile 及其有序 patch。
- **子进程的 transcript（文本记录）保留在其自身的会话根目录中**：父级日志只记录委派工具调用／结果（seam 的子级隔离规则）；流式 `session.event` 通道只用于提取输出，不会桥接到父级日志中。
- **仅支持本地子进程**：解析出的 cwd 是本地路径；远程运行时需要独立的后端。
