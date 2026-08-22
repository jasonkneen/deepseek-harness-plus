# @deepseek-ai/dsh-subprocess-local

[English](README.md) | 中文

[`@deepseek-ai/dsh-subprocess`](../subprocess/README.zh.md) seam 的本地 Service Provider。`LocalSubprocessRuntime` 解析本地可执行文件，在宿主支持时为普通 Linux 与 Windows 命令建立 OS-owned managed range，并通过 `node-pty` 加平台进程检查实现终端进程。该实现没有任何配置：每项处置方式、限制、终端尺寸、宽限期与目录都来自调用方能力 seam（[`dsh-bash-local`](../../shell/bash-local/README.zh.md)、[`dsh-lsp-stdio`](../../lsp/lsp-stdio/README.zh.md) 和 [`dsh-terminal-bash`](../../terminal/terminal-bash/README.zh.md)）。

## 行为

- **signal 与 wait 使用同一个 managed range**：Linux 在 manager 支持 literal argv 与可读 scope 状态时使用 transient user-systemd scope。Windows parent 为非继承流创建 private named-pipe endpoint；runner 只打开 target 侧 handle，以 suspended 状态创建目标，把它分配给自身的 kill-on-close Job，恢复目标，发布启动事实，然后关闭这些 pipe handle。只有 runner 保留原始 target process handle 与 Job，报告 direct result，并只在 `ActiveProcesses` 归零后成功退出；parent 不打开这两个 native object。Linux scope 与 POSIX 进程组 fallback 先发送 TERM，并在 `graceMs` 后发送 KILL；Windows Job 与 `taskkill` owner 在首次请求时立即强制终止。`waitForExit()` 只在所选 owner 证明范围为空后成功，无法取得该证明时则拒绝。direct result 到达后，`.done` 会等待所有非继承输出流关闭，最长不超过 `graceMs`；到达该界限时仅强制关闭 collected stream，raw pipe 仍归调用方所有。
- **明确披露较弱 fallback**：macOS、旧版或不可用的 user-systemd，以及不可用的 Windows native 支持继续使用既有 detached PGID 或 `taskkill /T` 路径。provider 会在首个受影响命令前只告警一次。native runner 可能已经启动用户命令后绝不通过 fallback 重试。
- **按流划分的处置方式**：`'pipe'` 把原始流原样交给调用方（协议分帧仍归消费方所有）；`'inherit'` 直通父进程的描述符；收集模式（collect）在输出超过上限后于内存中保留尾部（错误与结果通常聚集在末尾，沿用 pi/OpenCode 的理由），并在配置了 spill 上限时把完整流追加到一个私有临时文件；省略 `spill` 则只保留用于诊断的尾部。某条流大于 spill 上限时，会丢弃已不完整的 spill，仅返回带截断标记的尾部；spill 文件描述符在结算时封存，最终关闭失败时则不公布路径，以免声称存在不完整的文件。spill 文件权限为 `0600`、名称随机，位于按需创建、权限为 `0700` 的每进程目录之下。
- **凭据清除 + 显式合并**：以 `process.env` 为基础，移除形似凭据的变量（`*KEY*`／`*PASSWORD*`／`*SECRET*`／`*TOKEN*`）和所有环境中已有的 `DSH_*` 名称；spec 的显式 `env` 在该清除之后合并且不做命名空间校验，因此有意提供的凭据或当前 `DSH_*` 事实会胜出，而陈旧的嵌套 harness 身份无法从环境中隐式漏入。提供的 stdin 会被写入后关闭；否则 fd 0 指向 `/dev/null`。参见 [stdin/env Agent Note](../../../.agents/notes/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-api.zh.md)与[受管环境 Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-agent-session-identity-and-log-location.zh.md)。
- **基于偏移量的读取**：收集模式的读取器按完整流的字节坐标返回增量；服务自身从不持有游标，因此消费方自有的游标（bash 的后台读取路径）与完整流重读可以共存，结算前后皆然。
- **可执行文件查找**：`resolveExecutable` 检查绝对文件，或根据平台可执行文件扩展名在清理后的有效 PATH 中搜索；含分隔符的相对路径在该 seam 处被拒绝，相对 PATH 条目从宿主进程 cwd 解析。
- **终端进程所有权**：`spawnTerminal` 分配 `node-pty`，桥接 UTF-8 终端文本，检查当前前台进程组并向其发送信号，还会公开一项须等待的终止操作，在终止顶层 shell 前后清理后代进程。每次前台检查都会保留根进程树中的精确身份；Linux 还会在 POSIX 会话 leader 退出后枚举该会话。因此，之前观察到的 macOS 后代以及同会话 Linux 成员在重新设定父进程后仍受围栏保护，pid/start 身份则防止清理跟随 PID 复用。在 Windows 上，基于 koffi 的检查器通过 Toolhelp32 枚举进程表，把 GetProcessTimes 启动身份与进程句柄零时等待结合起来判断存活状态，并把 shell pid 作为伪前台进程组（Windows 没有 POSIX 进程组）。拆卸会验证 shell 已终止，因为被外部 taskkill 的 shell 可能永远不会触发 node-pty 的退出通知。上层 PTY 后端负责提示符就绪、缓冲区与面向模型的操作。
- **先终止再等待退出的 dispose（资源释放）**：服务保留存活句柄，使自身的 dispose 能执行每个 provider-owned termination procedure 并等待其退出；完全停稳与 spawn 失败的句柄会在 managed range 或 terminal session 清理完成后离开存活集合。
- **同步宿主退出最终清理**：服务 effect 仍有效时，Node `exit` listener 会同步向存活集合中的每个普通 managed range 与可观察 terminal session 发信号。Linux 发出 scope KILL 请求；Windows runner 把 parent IPC 断开视为 Job 终止；fallback 与 terminal 路径保留 PGID、`taskkill` 和 captured-identity 行为。listener 不创建 Promise 或 timer，不改变宿主退出码与诊断，会分别包含每个目标的失败，也不会声称已经完全停稳。正常 dispose 仍使用上面的须等待 managed-range 路径。参见[宿主退出清理决策](../../../.agents/notes/implemented/bug-fix/2026-08-11-synchronous-subprocess-exit-cleanup.zh.md)。

## 模型体验

通过 Consumer 间接影响（目前是 `dsh-tool-bash` 背后的 bash 执行器家族）；进程输出与生命周期面向模型的全部渲染归 Consumer 所有。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **native ownership 有明确宿主条件**：Linux 需要可读的 user manager 与 `systemd-run --expand-environment=no`；旧版 systemd 使用带告警的 PGID fallback。macOS 因没有受支持的公开 persistent owner，始终使用该 fallback。
- **native launch 有同步 setup 成本**：首条 ordinary spawn 会为该 provider instance 探测一次宿主能力，每条 probe command 的上限为 5 秒。本地 native 路径会在返回前发布数值 target pid，因此每次 launch 都会同步等待 per-spawn runner 报告 target start 或 spawn failure。built runner 通常会迅速完成该握手；若 runner 始终不发布结果，调用方会等待固定的 10 秒 protocol bound。每条受支持的 native command 都会保留一个 runner process，直到 OS-owned range 为空；Windows 还会创建 private per-spawn named-pipe endpoint。handle 发布后，runner event 每 100 ms、Linux scope state 每 200 ms 异步轮询。
- **Windows Job inheritance 有明确排除项**：普通 descendant 默认继承 Job，但 breakaway process 不在保证范围。目标只在 Job 分配后启动；runner 若在 create-to-assignment 极窄区间遭外力终止，可能留下 suspended target。
- **Windows 终端信号是控制台级的**：SIGINT 以 `\x03` Ctrl-C 输入写入投递，由 conhost 转为控制台级 CTRL_C 事件；SIGTSTP 与 SIGHUP 被拒绝（不可用）；不带 `/F` 的 `taskkill` 无法终止控制台进程，因此拆卸的 TERM 档是 `/F` 升级前的宽限等待。Windows 就绪没有精确的 stdin-wait 档：prompt-marker 快路径把 shell pid 作为伪前台进程组比较，其余由静默/计时档覆盖。
- **守护化的终端后代仍可能逃出可观察边界**：在 macOS 上，子进程如果在任何前台检查快照之前重新设定父进程，将无法再从 `node-pty` 根进程发现；在 Linux 上，调用 `setsid` 的子进程会同时离开进程树与自有终端会话。本地提供方不会新增持续进程表监视器。
- **进程内清理要求退出阶段仍能执行 JavaScript**：直接 `process.exit()`、默认未捕获异常和默认未处理 rejection 会发出 Node 同步 `exit` 事件。未安装 handler 时，`SIGTERM`、`SIGINT` 或 `SIGHUP` 的默认 OS 处置不会发出该事件；应用只有安装执行正常 dispose 或调用 `process.exit()` 的 handler 才能覆盖这些信号。`SIGKILL`、fatal OOM、`process.abort()`、native crash、断电，以及任何无法运行 JavaScript 的故障，都需要外部 supervisor、容器 init 或等价的 OS 所有者负责。
- **凭据清除依赖名称启发式规则**：只匹配 `*KEY*`／`*PASSWORD*`／`*SECRET*`／`*TOKEN*`；名称不同的 secret（例如 `*PASSPHRASE*`）会继续传递，对误删变量引入白名单属于已记录的后续工作。
- **不会删除已完成的 spill 文件**：有界的完整输出恢复文件（以及每个进程的私有 spill 目录）会在 OS tmpdir 下累积，直到外部机制进行清理；超大的不完整 spill 会被丢弃并立即尝试删除，但清理失败可能留下一个有界文件。

common process handling 位于 `src/spawn.ts`；Linux scope、Windows Job 与 private runner 位于各自平台模块；`src/index.ts` 拥有选择与 service wiring。
