# Agent Note: 原生 owner 收容逃逸的 subprocess 后代

Status: implemented

[English](2026-08-28-subprocess-native-containment.md) | 中文

## Problem

detached POSIX 进程组、Windows direct-parent 遍历与 PTY 后代扫描只能描述仍可通过某种进程关系观察到的成员。子进程可以调用 `setsid`、发生 reparent，或比 direct parent 存活更久并离开这些 range，因此终止表面进程树后，工作、端口或文件仍可能保持活跃。direct target result 也不能证明全部后代已经停止。

普通 subprocess 句柄无法通过发布 PID 解决这个缺口。Linux scope setup 与 Windows Job runner 会异步建立 target identity，PID 不表示完整 managed range，消费方也会被迫推断 startup 是否已经提交。因此，公共结果、range ownership、私有启动协议与打包入口需要各自明确的 owner。

## Decision

`LocalSubprocessRuntime` 会在 target 执行前选择一个 provider 私有的 managed-range owner。符合条件的 Linux 普通命令与 PTY 进入临时 user-systemd scope；符合条件的 Windows 普通命令进入由私有 runner 拥有的 unnamed kill-on-close Job。不支持的宿主使用既有较弱 fallback，并在 provider 生命周期内只警告一次。选定的 native 路径一旦可能已经执行 target，provider 绝不重放 target。

普通 `SubprocessHandle` 没有 PID 或公共 startup 状态。`.done` 报告 direct target result 或 startup／provider failure，`terminate()` 向所选 range 发送信号，`waitForExit()` 只有在同一 range 被证明为空后才成功。`SubprocessTerminalHandle.pid` 继续属于终端约定，因为 PTY identity 与前台检查需要它。

### Linux scope 与 one-shot bootstrap

每次符合条件的 Linux 普通或 PTY spawn 都会重新检查准确 runner 入口、libc `execve` 与 `fcntl` bindings、可读的 user manager 与保留 literal argv 的 transient-scope 支持。正向结果不缓存。native 路径一旦选定，scope、协议、状态查询或 pre-exec failure 都由本次启动报告，绝不切换到 fallback。

parent 创建一个 0700 目录，其中的完整 0600 `launch-request.json` 保存最终 target cwd 与环境。私有 `DSH_SUBPROCESS_RUNNER` 值负责定位该 request，runner 则从 provider cwd 与 bootstrap-safe 环境启动。`systemd-run --user --scope --quiet --collect --expand-environment=no` 先把自身进程注册到 scope，再由 one-shot bootstrap 删除并校验 request、切换到 target cwd、恢复完整 target 环境、按 target PATH 规则解析裸可执行文件、清除 fd 0 至 fd 2 的 `FD_CLOEXEC`，并使用原始 argv 调用 libc `execve()`。bootstrap 会原地成为 target 并保留继承的 stdio，不作为常驻 supervisor。

request 被消费或 manager 已观察到 unit 都能建立 scope ownership。在这两项事实出现前，unit absence 仍是未决状态；direct child 在 request 尚未消费时退出表示建立失败。建立之后，inactive、failed 或已经被 collect 卸载的 unit 可以证明 range 为空。未知状态与不可读的 manager 结果会使 `waitForExit()` reject，而不是宣称完全停稳。严格的同目录 `startup-error.json` 只承载 request／bootstrap 或 target pre-exec failure，parent 会在可观察生命周期完成时移除本次 spawn 的私有路径。

普通 target result 仍来自同一个 child process。PTY 路径复用同一 request 与 bootstrap，但不增加常驻 runner，因此 `node-pty` PID、进程组、session leader、控制终端、前台 `inputWaiting`、`/dev/tty`、readiness 与 direct terminal outcome 保留既有含义，同时 scope membership 覆盖 `setsid` 与 reparent 后代。

### Windows runner 与 Job

Windows parent 从 bootstrap cwd 与环境启动 provider runner，把原始 target argv 放在私有 `--` 分隔符之后，并通过 Node IPC 传递恰好一条 start request、幂等 terminate control 与恰好一个 result。runner 的 fd 0 至 fd 2 相互隔离，fd 3 承载 IPC，fd 4 至 fd 6 承载 target stdin、stdout 与 stderr。忽略 stdin 时，fd 4 继承平台 null-device descriptor；其他模式使用 pipe。共享 Win32 层调用 `GetStartupInfoW`，严格解码 libuv 的 `cbReserved2`／`lpReserved2` 表以取得 fd 4 至 fd 6 的 OS handle，临时启用这些 handle 的继承，并通过 `STARTF_USESTDHANDLES` 传入。`spawnCurrentTokenJobProcess` 要求单独解析的 `applicationName` 与完整 target 环境，并使用 `CREATE_UNICODE_ENVIRONMENT` 传入排序、双 NUL 结尾的 UTF-16LE 块，其中包括 `=X:` 驱动器条目，而不修改 runner 环境。suspended target 进入 Job 并恢复后，runner 只关闭 fd 4 至 fd 6，绝不改写或销毁 Node 标准流。parent 把 pipe carrier stream 作为普通句柄的 stdio 返回，用户字节绝不经过 IPC。

runner 是 target process handle 与 unnamed Job handle 的唯一 owner。`spawnCurrentTokenJobProcess` 以 suspended 状态创建 target，把它分配给不允许 active breakaway 的 kill-on-close Job，并只在分配后恢复。runner 轮询 direct process 获取 target exit code，并轮询 Job 获取 active-process count。只有 direct result 已通过 IPC send callback 交付且 Job 已报告零 active process 后，runner 才成功退出；parent 只把这次 clean exit 映射成成功的 `waitForExit()`。

parent 会在收到经过校验、只含数字的 `target-exit` 时立即永久锁存它，此时既有 stdout／stderr close 或有界 drain barrier 可能尚未完成。`.done` 只继续等待该 stdio barrier，随后返回已锁存的结果。后续 Job query、range settlement failure、IPC loss 或 runner 异常退出只会使 `waitForExit()` reject，不能替换 direct result。在有效 target result 到达前发生 infrastructure failure 才会使 `.done` reject。disconnect 或 result-send failure 会让 runner 停止协议工作、终止并关闭自己唯一的 Job handle，然后以非零状态退出。最后一个 Job handle 关闭会终止剩余成员，但不会把 disconnected 路径改写成成功的完全停稳证明。

### 私有分派与协议

source 启动通过 TypeScript source launcher 执行包内 runner 入口，built 启动解析 `@deepseek-ai/dsh-subprocess-local/runner` export，Python SDK 单文件可执行程序则从 `@deepseek-ai/dsh` 由打包层拥有的 `runtime-bootstrap.js` 进入。私有 selector 不存在时，该 bootstrap 导入公共 CLI；否则会删除 selector，并分派到同一 subprocess runner core。公共 `dsh` 参数解析器没有隐藏 runner mode，打包也不提供第二个 Node 可执行程序。

selector 是 per-spawn locator 或 sentinel，不是凭据或持久格式。Linux 使用一个严格 request 与一个可选严格 startup-error 文件。Windows 使用一条 IPC channel，承载闭集的 `start` 与 `terminate` request，以及恰好三个 result 分支：只含数字 `exitCode` 的 `target-exit`、携带有界 Node-shaped 字段的 `error`，以及无载荷的 `start-cancelled`；parent 会派生 `signal: null`。取消 reason 不跨 wire 传递，因此 parent 会原样保留第一个本地 reason，包括 `null` 或 `undefined`。缺失、额外、类型错误或未知字段都会 fail closed。target 环境可以包含 selector 名称及其 Windows 大小写变体，因为 provider 会单独传递 target 状态，并且只在私有选择值消费后才恢复该状态。

### Fallback 与 cleanup

准确 bootstrap、现代且可读的 user-systemd manager，或保留 literal argv 的 scope 不可用时，Linux 会在 target 执行前进入 fallback。runner 入口、Win32 bindings 或 current-token Job probe 不可用时，Windows 普通启动会进入 fallback。macOS 普通启动、Windows ConPTY 与其他不受支持的宿主保留既有 PGID、`taskkill /T` 或带身份围栏的 PTY 观察机制。warning 会明确说明：逃离这些可观察关系的后代不保证被终止，也不保证延迟 `waitForExit()`。

正常 Cordis dispose 会独立启动 direct-result 与 range observation、请求终止，并等待每个自有 range。消费方 teardown 不检查普通 PID；它会保留原始 operation 或 startup error，同时尝试 terminate 与 final wait，并按消费方既有错误顺序保留 cleanup failure。range 一旦被确认为空，就会永久禁止后续向陈旧 identity 发送信号。

在 JavaScript 可观察的 host exit 期间，`LocalSubprocessRuntime` 会同步强制终止每个仍存活的句柄，不使用 Promise 或 timer。Linux 会发送既有 direct fallback kill 与准确 scope kill；Windows 会终止 runner，使其唯一 Job handle 关闭；PTY fallback 扫描仍是 best effort。每个句柄的失败相互隔离，也不改变宿主退出结果。JavaScript 无法运行的终止形态不属于该 listener 的保证。

## Existing decisions and supersession

本 Note 拥有当前 native containment 机制。它局部更新了[subprocess seam](2026-07-26-subprocess-seam.zh.md)中的 provider 与 no-PID 事实、[持久化 PTY 会话](../feature/2026-07-16-persistent-pty-sessions.zh.md)中的 Linux teardown 事实、[宿主退出同步清理](../bug-fix/2026-08-11-synchronous-subprocess-exit-cleanup.zh.md)使用的 native target、[共享 Win32 process primitives](2026-08-19-shared-win32-process-primitives.zh.md)的 ordinary 消费方，以及[Python SDK profile 运行时](2026-08-23-python-sdk-dsh-profile-runtime.zh.md)选择的私有入口。每份 Note 都保留其余决策并继续处于 active 状态。

## Verification

- provider 与 Linux 协议测试套件固定同步 NUL 拒绝发生在启动副作用之前、严格 request／error 解码、target cwd 与完整环境恢复、私有变量碰撞、保留 argv 且对 symlink 敏感的 PATH 遍历、为继承 stdio 清除 close-on-exec、pre-exec error ownership、三种 scope 建立状态，以及 PTY managed-owner 恰好一次 cleanup。
- Windows 协议与 Win32 测试套件固定恰好三个 result 分支、只含数字的 target exit、原样本地 cancellation reason、access denied 到 `EPERM`／`-4048` 的映射、显式排序的 target 环境块及 `=C:` 保留和双 NUL 结尾、严格的 `GetStartupInfoW` libuv 描述符表解码、null-device ignored-stdin carrier 与非 ignore stdin pipe、result-send 与 IPC-disconnect failure、stdio settlement 前的 direct-result 锁存、active-process 完全停稳，以及唯一 handle cleanup。
- 真实 Linux user-systemd 测试会分别通过生产入口运行一条普通命令与一条 `node-pty` `setsid`／reparent 场景。它们证明 scope signalling 与 collection、裸可执行文件查找、逃逸后代终止、range settlement，以及不变的 PTY PID、session、控制终端、前台输入、`/dev/tty`、readiness 与 startup-failure 语义。
- native Windows 测试证明 suspended creation、resume 前 Job assignment、继承 stdio、默认后代继承、direct result、termination、active-process zero、异常／disconnected runner cleanup、kill-on-close 与同步 host-exit termination。source、built 与 Python packaged 冒烟测试进入同一 runner core。
- 公共 seam 类型、local 与 E2B provider、LSP 与 subagent 消费方、shell fixture、README、Cordis catalog 与 keyless subprocess API snapshot 都不包含普通 PID；terminal PID 保留。

## Alternatives considered

**保留 PID、把它改成可选值，或增加公共 `started` Promise。**不予采用，因为这些表示都会暴露不表示 managed range 的异步 provider identity，并诱导消费方从错误事实推断 startup 或完全停稳。

**扩展进程组、session、parent tree 或 PID 扫描。**不予采用，因为进程可以离开每一种观察关系；当 PTY helper 与 launcher 共用 session 时，更宽的 SID signalling 还可能命中无关进程。native OS membership 会持续存在，并且可以独立查询。

**让 parent 拥有或重新打开 Windows Job。**不予采用，因为复制 handle、named Job、`OpenJobObject`、process-handle handoff 与 completion port 会制造多个 lifecycle owner，却不能改善 direct-result 约定。一个 runner 可以统一拥有 target creation、Job membership、result production 与最终 handle closure。

**在 Windows 上通过 target stdio 或文件传递 control／result。**不予采用，因为用户字节与 EOF 必须继续以既有 Node stream 为权威，而 result file 或 polling 会制造第二个 result owner。一条 IPC channel 可以把 control 与 target stdio 分开。

**在公共 CLI 中解析隐藏 runner 参数，或发布另一个 Node 可执行程序。**不予采用，因为前者扩张公共应用语法，后者扩张分发面。packaging-only bootstrap 保留一个物理可执行程序与两个私有逻辑入口。

**缓存成功的 native probe，或在 native launch 失败后重放命令。**不予采用，因为 user-manager、入口与 Job availability 可以在两次 spawn 之间变化，而一次含糊 failure 之后的 replay 可能执行命令两次。

## Consequences

受支持的 Linux 普通与 PTY 启动、Windows 普通启动会在后代逃离进程组或 direct parent 退出后继续拥有它们，同时 direct target result 与 range 完全停稳保持独立。代价是每次 spawn 都需要一个 Linux scope／request 或 Windows runner／IPC／Job 生命周期，而且所选 owner 无法证明 settlement 时会显式失败。

fallback 宿主继续运行命令，但携带可见的较弱保证。Windows ConPTY、macOS native containment、active breakaway 后代、旧版或缺失的 user-systemd 环境、target replay、持久 runner recovery，以及 JavaScript 无法执行的终止路径均不属于本决策。
