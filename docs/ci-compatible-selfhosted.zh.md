# Node 兼容性 CI 运行器

[English](ci-compatible-selfhosted.md) | 中文

## 摘要

三个 Node 兼容性作业可以使用现有的 Linux 自托管池，而不改变其版本、必需检查或 master 调度。[CI](../.github/workflows/ci.yml) 拥有运行器选择逻辑；[决策记录](../.agents/notes/implemented/process/2026-09-06-node-compatibility-selfhosted.zh.md) 解释隔离和取舍。

## 目录

- [运行器选择](#runner-selection)
- [安装与清理](#installation-and-cleanup)
- [验证](#verification)

<a id="runner-selection"></a>

## 运行器选择

Node 22.19、24.9 和 26 仅在 `DSH_CI_FAILOVER_LINUX=selfhosted`，且 PR（Pull Request）作者不是 Dependabot、头部仓库与当前仓库相同、头部仓库不是 fork 时选择 `[self-hosted, linux, x64, vm-backup]`。其余情况均选择 `ubuntu-latest`。Python SDK 作业仍使用托管运行器。

每个矩阵条目一次运行一个仓库门禁。矩阵保留独立作业，不会因某个版本失败而取消其他版本。运行器注册实例共享主机资源；注册数量不等于独立机器数量。

<a id="installation-and-cleanup"></a>

## 安装与清理

自托管 Node 安装使用 `runner.temp` 下的工具缓存。pnpm 设置使用运行器和运行私有的目标目录。Node 编译缓存和 node-gyp 头文件也保留在运行器临时目录下；pnpm 内容寻址 store 保持持久化。托管作业保留其常规工具缓存和 pnpm 缓存。自托管作业不恢复或上传托管软件包缓存。

运行器负责作业之间的临时目录清理。这些作业不安装系统软件包，也不修改全局 Node 符号链接。共享镜像必须已提供原生 npm 软件包所需的编译器和 Python 依赖。冷的临时 Node 缓存需要重新下载所选运行时。

<a id="verification"></a>

## 验证

`pnpm exec vitest run scripts/ci-compatible-selfhosted.spec.ts scripts/ci-workflow.spec.ts` 检查路由、托管回退、矩阵保留、缓存路径和实际执行的环境设置。自托管主机上的真实 Node 矩阵仍是必需的平台验证；本地工作流测试不能证明原生运行时兼容性或并发 PR 负载下的容量。

## 开发备注

无。
