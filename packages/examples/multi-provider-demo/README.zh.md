# @deepseek-ai/dsh-multi-provider-demo

[English](README.md) | 中文

多 provider 包演示应用。`dsh-multi-provider-demo` bin 启动 [multi-provider leaf](../../../examples/multi-provider/README.zh.md)——agent spine 加上 [`dsh-multi-provider`](../../bundle/multi-provider/README.zh.md) 包——然后要么列出已注册的 LLM provider 及其模型目录，要么通过选定的 provider 运行一个任务并打印最终的助手文本。

## 用法

```sh
dsh-multi-provider-demo [--config path] providers
dsh-multi-provider-demo [--config path] run --provider <name> [--model <id>] <task...>
```

`providers` 列表无需密钥且输出确定。`DSH_SNAPSHOT` 回放选择同级 `cordis.snapshot.yml` 并跳过 `.env`，避免误置的密钥触发真实模型调用；`run` 需要环境或 `.env` 中存在匹配的 provider 密钥。

## 模型体验

间接地，通过组合的 spine 与 pack：选定的 provider 适配器拥有请求，spine 的提示与工具插件拥有模型可见文本。bin 本身不贡献任何内容。

#### KV Cache 影响

无；每次 `run` 都启动一个全新的 agent 与会话。

## 已知限制与暂缓事项

- **每次 `run` 一个任务**：bin 将单个全新 agent 驱动至静止后退出；没有交互式会话或恢复。
- **密钥在运行时决定行为**：缺失的 provider 密钥会让 `run` 命令在第一次模型调用时失败；列表无法证明某个 provider 可用。
