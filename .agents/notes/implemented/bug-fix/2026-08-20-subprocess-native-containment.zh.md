# Agent Note: Local subprocesses use native managed ranges where supported

Status: implemented

[English](2026-08-20-subprocess-native-containment.md) | 中文

## Problem

本地 subprocess provider 把 POSIX 进程组或 Windows direct-parent tree 当作 managed range。descendant 可以调用 `setsid`、double-fork 或活得比 direct parent 更久，导致 `terminate()` 漏掉的工作已经被 `waitForExit()` 宣布消失。direct command result 与完整 managed range 是不同的生命周期事实，不能压成一个 wrapper exit code。

## Decision

`LocalSubprocessRuntime` 会在每次符合条件的 ordinary 或 terminal 用户命令前选择 containment。Linux 会在每次 launch 时重查 live user manager；稳定的 systemd scope 与 ordinary runner 探测只在成功后按 provider 生命周期缓存，失败探测会重试，而且 terminal 选择绝不会探测 ordinary runner。Windows 同样只缓存成功的 Job runner 探测。较弱路径的告警由每个 provider 至多发出一次。Linux 只在 user manager 可读且 `systemd-run` 支持 `--expand-environment=no` 时使用 transient user-systemd scope。Windows ordinary launch 使用由 `@deepseek-ai/dsh-win32-process` 支撑的本地 runner；它以 suspended 状态创建目标，把目标分配给 kill-on-close Job，并只在分配后恢复。每次 native launch 只绑定一个提供 `signal()` 与 `waitForExit()` 职责的 package-private owner。

common spawn lifecycle 继续拥有 stdio disposition、有界收集、direct outcome、abort 处理、termination scheduling 与 host-exit 注册。Linux scope 与 POSIX 进程组 owner 先投递 TERM，并在配置的 grace 后投递 KILL；Windows Job 与 `taskkill` owner 在首次请求时立即强制终止。`.done` 来自 target process。private `0600` single-spawn request/event transport 让 Linux 或 Windows runner 分别报告 Node-shaped target spawn failure 与 target exit，不依赖 scope 或 Job 生命周期。`waitForExit()` 只在 `terminate()` 使用的同一 owner 确认 OS range 为空后成功；首次确认后，该 owner 永久忽略后续 signal。

Linux ordinary user argv 从不进入 `systemd-run` 命令行。runner 从 private request 消费 argv，以精确 cwd 和 scrubbed-plus-explicit environment 启动目标，并报告 direct result。打包载体通过[单文件运行时](../architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.zh.md)拥有的 private dispatch 重新进入自身 executable；Linux capability probe 在选择 native mode 前调用同一个 runner entry。scope TERM 会让 runner 存活足够久，以便报告 trap TERM 的目标。若 scope KILL 阻止最终 target event，Linux launch 只会在该 KILL 已尝试且 owner 证明 scope 为空后报告 `SIGKILL`；无关的 runner 或 manager failure 仍会拒绝。

Linux terminal launch 会把 `systemd-run --user --scope --quiet --collect --expand-environment=no -- <原始 argv>` 直接交给 `node-pty`；`systemd-run --scope` 会以 target 替换自身，因此 node-pty 继续观察 target PID、session leader、process group、控制终端、前台 input wait 与 prompt readiness。terminal handle 会为正常终止与 host-exit KILL 绑定同一个 scope owner，因此已 reparent 或新建 session 的 descendant 仍留在 managed range 内，无需第二个 PTY runner 或持续进程表 monitor。

Windows parent 为非继承流创建 private named-pipe endpoint，runner 只打开 target 侧 handle。该 runner 以 suspended 状态创建目标，把目标分配给自身 unnamed kill-on-close Job，恢复目标，把 target identity 追加到 private event file，并在处理 control message 前关闭自身 pipe handle。parent 会立即返回 `pid` 为 `undefined` 的 handle，并在异步 event reader 观察到该记录后发布 identity。runner 会保留原始 target process handle 与 Job，直到报告 direct exit 且 `QueryInformationJobObject` 报告 active member 归零。parent 不打开 target process 或 Job；IPC termination 与 disconnect 是进入 runner 的唯一控制路径。

native capability 在目标执行前不可用时，provider 只告警一次并使用既有 PGID 或 `taskkill /T` fallback。macOS 因没有受支持的公开 persistent process owner，始终进入该路径。native launch 一旦被选择，runner、manager 或 result transport 的任何失败都会直接报告；用户命令绝不会经 fallback 重放。

## Verification

Linux native 证据在 Ubuntu 24.04 x86_64、systemd 255.4 环境分别运行 ordinary 与 node-pty `setsid`/reparenting 场景，并覆盖不重放的 Node-shaped spawn failure。PTY 场景固定 node-pty PID、process group、session leader、控制终端、`/dev/tty` 输入、前台 `inputWaiting`，以及 escaped descendant 的终止。Windows native 证据运行一个默认继承 descendant 场景，并覆盖 raw stdin、direct stdout/stderr EOF、direct result 与 Job quiescence 的区别，以及 target spawn failure。shared tests 固定 literal argv、一次性 fallback warning、owner 不可读时拒绝、停稳后不再发 signal、abort 与 host-exit 路由，以及 source、built 和 packaged-executable runner entry。

## Alternatives considered

**扫描进程表寻找 escaped descendant。** 拒绝，因为 parent 与 PID snapshot 不提供持续所有权事实，还可能跟随 PID reuse。

**暴露公共 backend selector 或通用 launch framework。** 拒绝，因为调用方只需要一个 subprocess contract，而 systemd 与 Job creation 具有不同 launch mechanics；只有 signal/wait owner 是共同部分。

**把 Windows Job 或 direct-process observation 移到 parent。** 拒绝，因为 named Job、cross-process open、release handshake 或第二个 process handle 会重复 runner 已拥有的生命周期事实，却不会产生第二个用户结果。parent 只拥有公共 stdio endpoint 与 runner control。

**支持 legacy systemd argument expansion。** 拒绝，因为 shell-style expansion 会改变 user argv；缺少 literal-argument option 的宿主使用已披露的 fallback。

**使用 private macOS coalition API。** 拒绝，因为没有受支持的公开 owner 能提供所需 membership 与 settlement contract。

## Consequences

受支持的 Linux 与 Windows 宿主会在 session 变化或 reparent 后继续拥有 descendant，termination 与 settlement 读取同一个 OS-owned range。Linux 会在每个符合条件的 ordinary 或 terminal target 前执行一次 live manager 探测；稳定的 scope 与 ordinary runner 探测会在首次成功后停止，失败后则重试，每条命令的上限为 5 秒。terminal launch 绝不会运行 ordinary runner 探测。Windows 的有界 Job runner 探测也只重复到首次成功。native ordinary handle 没有每次 launch 的 target publication 握手或超时：它以 `pid` 为 `undefined` 的状态返回，再由每 100 ms 异步读取一次的 event file 发布 PID 或结算 `.done`。runner 如果保持存活却始终没有 terminal event，这些事实会保持待定，直到 runner 退出或该范围被终止。每个 native ordinary range 会保留一个 runner process 直到 settlement；Linux PTY launch 不增加 runner。Windows 还会创建 private per-spawn named-pipe endpoint，但不会创建 named Job 或 parent target-process handle。systemd state 每 200 ms 异步读取一次，不会阻塞宿主事件循环。Windows managed range 会立即终止；`graceMs` 仍用于限制 collected-pipe 排空。private runner 增加一个 built entry 和短期 private files，但不增加公共配置或 durable format。Windows breakaway descendant 仍不在保证范围；runner 在 CreateProcess 到 Job assignment 的极窄区间遭外力终止时可能留下 suspended target。fallback 宿主继续可用，但保证会被明确削弱。
