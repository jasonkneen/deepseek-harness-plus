# `@deepseek-ai/dsh-sdk-minimal`

[English](README.md) | 中文

供 `dsh --profile sdk-minimal` 使用的独立极简 SDK 应用组合包。它的单个 insert 构成完整 Cordis 树：SDK stdio 启动与 JSON-RPC 对外服务、一个由环境配置的 DeepSeek 适配器、无执行器的 agent 主干、本地子进程与不受限文件系统提供方、按平台选择的持久 shell PTY、字符串替换编辑器，以及位于 `$DSH_HOME/sessions` 的未压缩 JSONL 会话持久化。它刻意不包含 [`dsh-base`](../base/README.zh.md)、Web、settings、托管凭据、遥测、压缩（compaction）、workspace 指令、skills、jobs 工具、subagent 或任何其他面向模型的工具。

该 profile 仍遵循普通 launcher 与分层模型。组合包提供完整默认树；profile patch、home patch 与有序 `--patch` 文件可以在其上替换配置项或插入外部组合包。`dsh plugin --profile sdk-minimal` 管理持久依赖。随附模板仅在启动时应用 patch，因此一个 stdio 连接不会观察到服务器或 agent 依赖在运行中被替换。

`DEEPSEEK_API_KEY` 提供适配器凭据。SDK 初始化请求是唯一模型选择；即使该模型 id 不在适配器的建议目录中，适配器也会接受它。`DSH_CONTEXT_WINDOW` 为这类模型设置后备容量，`DSH_SYSTEM_PROMPT` 替换默认 persona。进程工作目录同时作为沙箱策略 workspace 与本地文件系统根目录。该组合包设置 `danger-full-access`；其持久 shell 与编辑器可以修改进程可访问的任何路径。

运行时会按平台恰好挂载一套持久 shell：Linux／macOS 使用 Bash，Windows 使用 PowerShell。两者都使用 300 秒超时与一个 agent 自有终端；另一平台的配置项保持禁用。

## 模型体验

### 极简 coding agent 组合

#### 模型看到的内容

系统提示词取 `DSH_SYSTEM_PROMPT`，未设置时使用 `You are a helpful software engineer assistant.`。对外公布的工具只有 Linux／macOS 上 agent 所有的持久 `bash` 或 Windows 上的 `pwsh`，外加 `str_replace_editor`；运行时上下文、workspace 指令、skills、jobs 控制、compaction 与 Harness 身份均不存在。

#### Token 影响

一个稳定 persona 加两个工具 schema。工具结果与普通对话历史随会话增长。

#### KV Cache 影响

当 persona、平台、提供方、模型与组合包 patch 栈固定时保持稳定。Profile 变更在下一个进程生效。

## 已知限制与待办工作

- **该组合刻意省略共享产品服务** — 需要 settings、托管凭据、权限策略预设、遥测、Web 工具或完整默认工具清单时，请选择 `dsh --profile sdk`。
- **用户 patch 可以扩展配置树并破坏 stdout** — profile 自定义属于受信任的应用组合；向 stdout 写入普通文本的插件会破坏 JSON-RPC 分帧。
