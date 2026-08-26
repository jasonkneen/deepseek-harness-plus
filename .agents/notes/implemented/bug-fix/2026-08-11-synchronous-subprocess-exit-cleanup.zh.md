# Agent Note: 宿主退出时同步清理受管子进程

Status: implemented

[English](2026-08-11-synchronous-subprocess-exit-cleanup.md) | 中文

## Problem

本地 subprocess provider拥有普通 detached进程树和 terminal session，但此前只能通过异步 Cordis dispose触及它们。致命 launcher可能在 dispose完成前调用 `process.exit()`：[fail-loud release](2026-07-31-fail-loud-releases-the-terminal.zh.md)最多等待两秒，而本地进程可以拥有更长的终止宽限期。Node进入同步退出阶段后，待处理的 Promise与升级 timer不会继续执行，因此忽略 TERM的子进程可能比宿主存活更久，继续占用 CPU、内存或端口。部分 ACP、JSON-RPC和 SDK入口也没有 root release回调。

公共 subprocess seam在正常 dispose期间承诺等待完全停稳，这项承诺是正确的。缺陷属于 seam之下另一条最终宿主退出路径，不应削弱正常生命周期，也不应让每个 launcher重复保存进程所有权。

## Decision

`LocalSubprocessRuntime`在自身 Cordis effect中安装一个同步 Node `exit` listener。只有正常 dispose成功后，同一 effect才移除该 listener。异步清理仍在等待时，普通和 terminal handle继续保留在服务已有的存活集合中，因此更短的外层退出上限仍能看到并强制终止它们。dispose会逐个释放已经成功停稳的目标；失败的目标与 listener继续由服务拥有，使后续宿主退出仍能调用同一组同步最终操作。

该 listener使用本地实现私有的最终操作；公共 `SubprocessHandle`和 `SubprocessTerminalHandle`接口不包含这些操作：

- 普通 handle在可用时同步向绑定的 native scope 或 Job runner 发信号；已披露的 fallback 会向 detached POSIX进程组发送 SIGKILL，或在 Windows运行 `taskkill /PID <pid> /T /F`。
- 具有 native Linux owner 的 terminal handle 会同步向该 scope 发送 SIGKILL。fallback terminal 则向全部已捕获及当前可观察的后代发送信号，终止 PTY root，然后再扫描一次并终止在该边界期间变得可观察的成员。
- 服务分别包含每个目标的失败并继续处理其余 handle。回调不会创建 Promise或 timer，不写诊断，也不改变原始退出码或错误。

正常 dispose继续使用[subprocess seam](../architecture/2026-07-26-subprocess-seam.zh.md)的先终止再等待退出路径：POSIX ordinary range 先接收 TERM，经过配置的宽限期后再接收 KILL；Windows ordinary range 立即终止；每个 ordinary 或 terminal 清理都会等待完全停稳。同步路径只请求最终终止，不发布完成结果，也不声称回调返回时 OS range 已经消失。远程 provider继续由其 sandbox独立拥有，不继承本地 Node listener。

| 宿主路径 | 本地 provider动作 | 完成证据 |
| --- | --- | --- |
| 正常 Cordis dispose | 协作式终止、有界升级，并等待普通／terminal清理 | dispose结算前，每个自有 handle均达到完全停稳 |
| `process.exit()`、默认未捕获异常或默认未处理 rejection | 对服务当前存活集合发送同步最终信号 | 宿主退出后的外部观察 |
| 未安装 handler 时由 `SIGTERM`、`SIGINT` 或 `SIGHUP` 默认终止；`SIGKILL`；fatal OOM；`process.abort()`；native crash；或断电 | 进程内操作无法运行 | 必须由外部 supervisor、容器或 OS 所有权负责；应用安装执行 dispose 或调用 `process.exit()` 的信号 handler 时除外 |

## Verification

父测试通过仓库 source launcher启动隔离的 TypeScript宿主，等待精确 root与后代进程身份可观察后，再允许宿主进入各条致命路径。直接退出、默认未捕获异常和默认未处理 rejection覆盖忽略 TERM的普通进程树；直接退出还覆盖真实 terminal root与后代。父测试断言原始宿主退出类别，并等待所有已记录进程消失；失败清理只针对已记录身份或已记录的 Windows进程树。

单元证据固定同步 native-owner 与 fallback 投递、native terminal owner 路由、PTY root 终止前后的 fallback terminal 扫描、重复最终清理、逐目标失败包含、正常 TERM 到 KILL dispose、dispose 等待期间保留存活集合，以及 dispose 后移除 listener。

## Alternatives considered

**只依赖 launcher release回调。** 拒绝，因为不是每个入口都会提供该回调，而且有界 release仍可能在 subprocess provider的宽限期与 timer完成前结束。

**在 `exit` listener中调用现有异步 `terminate()`。** 拒绝，因为 Node不会等待 exit listener；回调返回后，Promise、timer、输出排空与停稳轮询都无法完成。

**向公共 subprocess handle增加 raw `forceKill()`操作。** 拒绝，因为消费方只需要一项协作式终止约定。立即最终终止属于实现职责，只由本地服务的宿主退出 owner使用。

**把所有故障模式交给外部 supervisor。** 不接受将其作为唯一方案，因为 Node为几条常见致命路径提供可靠的同步回调，而 provider已经拥有精确目标。JavaScript无法运行时仍必须依赖外部所有权。

## Consequences

每个有效的本地 subprocess service都会贡献一个进程全局 exit listener。成功的 dispose会随服务 effect移除它；失败的 dispose会让它与仍需最终终止的目标一起保留。致命退出放弃宽限、输出排空与进程内停稳证明，以换取宿主消失前发出本地可用的最强终止操作。正常 dispose的保证与成本保持不变。

listener 无法覆盖不执行 JavaScript 的故障。受支持的 Linux terminal 会向[containment decision](2026-08-20-subprocess-native-containment.zh.md)所述的 scope 发出信号；fallback terminal 仍无法发现 provider 首次观察前已经逃逸的后代。
