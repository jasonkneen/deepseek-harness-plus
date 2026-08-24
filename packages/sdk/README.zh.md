# sdk/：从另一进程驱动 Harness 运行时

[English](README.md) | 中文

本组包含用于从另一进程驱动 Harness 运行时的协议栈。TypeScript 客户端通过具名 profile 与有序 patch 启动匹配版本的 `dsh` CLI；私有 Python 载体在 Python 迁移到同一 profile 路径之前，保留当前打包后的直读配置运行时。[TypeScript SDK 决策](../../.agents/notes/implemented/feature/2026-07-27-typescript-sdk-and-sdk-subagent-backend.zh.md)负责客户端约定，[工具链移除](../../.agents/notes/implemented/simplification/2026-08-11-remove-sdk-project-toolchain.zh.md)负责产品边界。

| 包 | 职责 |
|---|---|
| [`protocol/`](protocol/README.zh.md) | 定义 SDK 运行时通信协议 |
| [`client/`](client/README.zh.md) | 通过 TypeScript 客户端 API 驱动 Harness 运行时 |
| [`server/`](server/README.zh.md) | 通过 stdio JSON-RPC 为进程外 SDK 客户端提供服务 |
| [`python-runtime/`](python-runtime/README.zh.md) | 为暂时保持不变的 Python SDK 运行时提供私有直读配置载体 |
