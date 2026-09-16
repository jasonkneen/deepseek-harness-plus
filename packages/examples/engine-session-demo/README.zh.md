# @deepseek-ai/dsh-engine-session-demo

[English](README.md) | 中文

实验性的整会话引擎运行器。`dsh-engine-session` bin 启动 [engine-session leaf](../../../examples/engine-session/README.zh.md)，其组合不挂载 agent loop：整个会话通过一个委派后端运行——官方 Claude Agent SDK（`claude-code`）或官方 `codex app-server`（`codex`）——而 harness 拥有持久化会话。用户提示、引擎的最终回答与轮次结果都作为普通会话事件记录，会话在退出前刷写到持久化存储。两个引擎均通过原生 OAuth 认证；无需 API 密钥。

## 用法

```sh
dsh-engine-session [--config path] <claude-code|codex> <task...>
```

不带 `--config` 时，bin 解析同级的 `examples/engine-session/cordis.yml` leaf；`DSH_SNAPSHOT` 回放选择 `cordis.snapshot.yml` 并跳过 `.env`，避免误置的密钥触发真实引擎运行。

## 模型体验

间接地，通过组合的委派后端：引擎在自己的进程内以一次全新运行接收任务文本，使用其原生系统提示、工具与权限。bin 本身不贡献任何模型可见文本。

#### KV Cache 影响

无；每次运行都是全新的引擎进程，只有记录下来的回答进入 harness 会话日志。

## 已知限制与暂缓事项

- **每次调用一个任务**：bin 将单个轮次驱动至静止后退出；交互式多轮会话需要在后端配置行上启用 `continuation` 并重复调用。
- **引擎工具活动不可见**：会话日志只记录提示、最终回答与结果；引擎内部的工具调用不会成为会话事件。
- **原生登录是前置条件**：未登录的 `claude` 或 `codex` 会表现为运行错误；bin 不提供登录流程。
