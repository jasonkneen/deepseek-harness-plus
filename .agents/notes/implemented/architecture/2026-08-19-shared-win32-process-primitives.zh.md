# Agent Note：Windows sandbox process primitives 只有一个低层 owner

Status: implemented

[English](2026-08-19-shared-win32-process-primitives.md) | 中文

## Problem

Windows ACL sandbox 拥有 restricted token、SID、DACL、grant 与 workspace policy，但其进程启动路径还同时承载通用 Koffi ABI、命令行引用、匿名管道、继承 stdio、Job 设置、wait 与 HANDLE 清理。第二个 Windows process consumer 否则只能依赖 sandbox policy 或复制 native resource 逻辑，而 allocation 与失败清理修复也必须在多份实现间保持同步。

## Decision

`@deepseek-ai/dsh-win32-process` 拥有 `sandbox-windows-acl` 与 ordinary subprocess Job runner 消费的可复用 Win32 process ABI 与 native resource 操作。该包惰性加载 `kernel32.dll` 和 `advapi32.dll`，核验 x64 `STARTUPINFOW` 与 `PROCESS_INFORMATION` 布局，为 `CreateProcessAsUserW` 或 `CreateProcessW` 引用 argv，并提供带检查的 anonymous pipe、继承 stdio、Job、wait、polling、termination 与 handle 操作。

Windows ACL sandbox 继续唯一拥有 restricted-token 创建、SID 与 DACL policy、grants、可写路径裁定、临时目录 policy 和公共 sandbox child result。它通过共享 binding context 扩展 policy-specific API，提供 primary token，组合 pipe drain 与 wait，并在自己的生命周期边界关闭调用方拥有的 Job。

每项 native allocation 与 HANDLE 在各个 shared operation 内只有一个 owner。process operation 会释放 Koffi out-parameter，并在受控失败前关闭它已经取得的每个 pipe、thread、process 或 Job handle。anonymous pipe 创建成功时，把 process 与 stdout/stderr read handles 返回给 sandbox。ordinary runner 临时恢复自身标准句柄的可继承位，通过 `STARTF_USESTDHANDLES` 原样传递这些句柄，并在目标创建后销毁自身的 Node/libuv 标准流，使目标退出可以让 parent 观察到 EOF。restricted 与 ordinary 创建都会以 suspended 状态启动目标，把它分配给 kill-on-close Job，并只在分配后恢复，因此目标代码不会在 Job 外运行。sandbox 保留既有 pipe-drain 与 direct-wait 生命周期；[原生收容 runner](2026-08-28-subprocess-native-containment.zh.md)唯一保留 ordinary direct-process handle 与 unnamed Job，轮询 direct exit 和 active-process count，并只在 Job 为空后关闭它。

current-token API 直接命名为 `CurrentTokenProcessSpawnOptions` 与 `spawnCurrentTokenJobProcess`；不保留语义含糊的 `Ordinary*` 或 `Unrestricted*` 别名。current-token spawn 单独接受由 provider 解析的 `applicationName`，同时保留原始命令行 argv 项；executable resolution 仍由 provider 拥有。该包只导出两个生产消费方已使用的操作。IPC、公共 process handle 以及后端选择仍留在外部。该包是 library，不是 Cordis service 或公共 Windows SDK。

## Verification

shared suite 覆盖 x64 ABI 值、命令行引用、binding extension、anonymous-pipe EOF 与 drain allocation 复用、继承的 ordinary 标准句柄、restricted 与 current-token process 创建、suspended 创建后的 Job 分配与恢复、blocking 与 zero-time exit 读取、Job-empty probe 与 termination、native allocation 释放，以及已取得资源的失败路径。sandbox 测试保留 restricted-token、fail-closed、pipe/inherit、result 与 disposal 组合行为，不重复低层矩阵。已提交的 header probe 与 Windows package 测试覆盖 native 路径；Wine 提供模拟 Windows package 与组合信号。

## Alternatives considered

**把 process primitives 留在 sandbox package。** 拒绝，因为 process consumer 将被迫继承 ACL/token policy，或复制 native ABI 与清理路径。

**为每个 consumer 复制 Koffi 实现。** 拒绝，因为 struct layout、错误捕获与局部失败清理会出现多个 owner。

**在当前 consumer 出现前发布 ordinary-runner operations。** 拒绝，因为未使用的操作会冻结推测性义务。ordinary CreateProcess、polling 与 Job control 只随实际 runner consumer 一起加入。

## Consequences

sandbox 保持公共行为，而通用 Win32 resource ownership 只有一个 package 与一个测试归属。该 package boundary 增加一个 workspace dependency 和发布 library；调用方必须显式拥有 policy、调度、result 组合与返回 HANDLE 的关闭责任。suspended 创建保证目标代码只在 Job 分配后启动，但不会让 runner 的 create-to-assignment 区间对外部终止具备原子性。后续 process consumer 只在其生产路径存在时扩展低层 package。
