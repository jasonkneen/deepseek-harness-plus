# terminal/：持久 PTY 能力家族

[English](README.md) | 中文

`PTY` 的全称是 **pseudo-terminal（伪终端）**。这项能力提供持久且限定所有者范围的终端会话，适用于需要跨工具调用保留状态或使用交互式 stdin 的工作流。PTY 是单次 bash 与文件系统工具的补充，不会取代后两者更严格的逐操作约定。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`pty`](terminal/README.zh.md)（`@deepseek-ai/dsh-terminal`） | 后端注册表、品牌化 id、精确的 Agent 所有权、会话操作与等待完成的清理 | `ctx.terminals` |
| `terminal-bash`（`@deepseek-ai/dsh-terminal-bash`） | `ctx.subprocess.spawnTerminal` 之上的 shell 后端：就绪检测、有界终端状态、沙箱策略与会话操作 | 注册到 `ctx.terminals` |
| `tool-terminal`（`@deepseek-ai/dsh-tool-terminal`） | 6 个面向模型的工具，并为后台发送集成通用任务 | 注册到 `ctx.tools` |

[终端子系统参考](../../docs/subsystems/terminal.zh.md)负责记录 id、后端与会话约定、发送就绪条件和有界读取。[持久 PTY Agent Note](../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.zh.md)负责记录设计理由与暂缓边界。
