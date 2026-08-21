# Agent Note: Ordinary subprocesses use native managed ranges where supported

Status: implemented

[English](2026-08-20-subprocess-native-containment.md) | 中文

## Problem

本地 subprocess provider 把 POSIX 进程组或 Windows direct-parent tree 当作 managed range。descendant 可以调用 `setsid`、double-fork 或活得比 direct parent 更久，导致 `terminate()` 漏掉的工作已经被 `waitForExit()` 宣布消失。direct command result 与完整 managed range 是不同的生命周期事实，不能压成一个 wrapper exit code。

## Decision

`LocalSubprocessRuntime` 在首个用户命令之前只选择一次 ordinary native containment。Linux 只在 user manager 可读且 `systemd-run` 支持 `--expand-environment=no` 时使用 transient user-systemd scope。Windows 使用由 `@deepseek-ai/dsh-win32-process` 支撑的本地 runner；它以 suspended 状态创建目标，把目标分配给 kill-on-close Job，并只在分配后恢复。每次 launch 只绑定一个提供 `signal()` 与 `waitForExit()` 职责的 package-private owner。

common spawn lifecycle 继续拥有 stdio disposition、有界收集、direct outcome、abort 处理、termination scheduling 与 host-exit 注册。Linux scope 与 POSIX 进程组 owner 先投递 TERM，并在配置的 grace 后投递 KILL；Windows Job 与 `taskkill` owner 在首次请求时立即强制终止。`.done` 来自 target process。private `0600` single-spawn request/event transport 让 Linux 或 Windows runner 分别报告 Node-shaped target spawn failure 与 target exit，不依赖 scope 或 Job 生命周期。`waitForExit()` 只在 `terminate()` 使用的同一 owner 确认 OS range 为空后成功；首次确认后，该 owner 永久忽略后续 signal。

Linux user argv 从不进入 `systemd-run` 命令行。runner 从 private request 消费 argv，以精确 cwd 和 scrubbed-plus-explicit environment 启动目标，并报告 direct result。打包载体通过[单文件运行时](../architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.zh.md)拥有的 private dispatch 重新进入自身 executable；Linux capability probe 在选择 native mode 前调用同一个 runner entry。scope TERM 会让 runner 存活足够久，以便报告 trap TERM 的目标；如果 scope KILL 阻止最终 target event 写入，`.done` 会拒绝而不是虚构结果。Windows target descendant 默认继承 Job；target 创建后，runner 会在发布启动事实前释放自身持有的标准句柄副本，因此 pipe EOF 取决于 target 与实际继承该流的 descendant。runner 会一直存活到 direct result 已报告且 `QueryInformationJobObject` 报告 Job active member 归零。parent IPC 断开会在 JavaScript-observable host exit 期间终止 Job。

native capability 在目标执行前不可用时，provider 只告警一次并使用既有 PGID 或 `taskkill /T` fallback。macOS 因没有受支持的公开 persistent process owner，始终进入该路径。native launch 一旦被选择，runner、manager 或 result transport 的任何失败都会直接报告；用户命令绝不会经 fallback 重放。

## Verification

Linux native 证据已在 Ubuntu 24.04 x86_64、systemd 255.4 的 user manager 上运行，覆盖真实 `setsid` descendant、direct parent 先退出的 double-fork daemon，以及不重放的 Node-shaped spawn failure。Windows native 证据覆盖默认继承 descendant，以及 direct target 退出后仍存活的 descendant。shared tests 固定 direct exit 与 range quiescence 的区别、literal argv、一次性 fallback warning、停稳后不再发 signal、abort 与 host-exit 路由，以及 source、built 和 packaged-executable runner entry。

## Alternatives considered

**扫描进程表寻找 escaped descendant。** 拒绝，因为 parent 与 PID snapshot 不提供持续所有权事实，还可能跟随 PID reuse。

**暴露公共 backend selector 或通用 launch framework。** 拒绝，因为调用方只需要一个 subprocess contract，而 systemd 与 Job creation 具有不同 launch mechanics；只有 signal/wait owner 是共同部分。

**支持 legacy systemd argument expansion。** 拒绝，因为 shell-style expansion 会改变 user argv；缺少 literal-argument option 的宿主使用已披露的 fallback。

**使用 private macOS coalition API。** 拒绝，因为没有受支持的公开 owner 能提供所需 membership 与 settlement contract。

## Consequences

受支持的 Linux 与 Windows 宿主会在 session 变化或 reparent 后继续拥有 descendant，termination 与 settlement 读取同一个 OS-owned range。首条 ordinary spawn 会为每个 provider instance 探测一次能力，每条 probe command 的上限为 5 秒。本地 native 路径随后必须在发布 target pid 前完成每次 launch 的有界握手；runner 始终不报告时，固定上限为 10 秒，每个 native range 还会保留一个 runner process 直到 settlement。handle 发布后，event file 使用异步 100 ms 轮询，systemd state 使用异步 200 ms 轮询，不再阻塞宿主事件循环。Windows managed range 会立即终止；`graceMs` 仍用于限制 collected-pipe 排空。private runner 增加一个 built entry 和短期 private files，但不增加公共配置或 durable format。Windows breakaway descendant 仍不在保证范围；runner 在 CreateProcess 到 Job assignment 的极窄区间遭外力终止时可能留下 suspended target。fallback 宿主继续可用，但保证会被明确削弱。
