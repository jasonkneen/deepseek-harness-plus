# sdk/：从另一进程驱动 Harness 运行时

[English](README.md) | 中文

本组包含用于从另一进程驱动 Harness 运行时的协议栈。TypeScript 与 Python 客户端都通过具名 profile 与有序 patch 启动 `dsh`；本组没有任何包定义独立应用。[TypeScript SDK 决策](../../.agents/notes/implemented/feature/2026-07-27-typescript-sdk-and-sdk-subagent-backend.zh.md)负责客户端约定，[Python profile 运行时决策](../../.agents/notes/implemented/architecture/2026-08-23-python-sdk-dsh-profile-runtime.zh.md)负责打包后的 Python 启动。

| 包 | 职责 |
|---|---|
| [`protocol/`](protocol/README.zh.md) | 定义 SDK 运行时通信协议 |
| [`client/`](client/README.zh.md) | 通过 TypeScript 客户端 API 驱动 Harness 运行时 |
| [`server/`](server/README.zh.md) | 通过 stdio JSON-RPC 为进程外 SDK 客户端提供服务 |
