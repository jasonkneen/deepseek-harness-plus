# Agent Note: 让受支持平台的测试聚焦语义

Status: implemented

[English](2026-07-22-cross-platform-test-fixtures.md) | 中文

## 问题

单元测试与覆盖率测试套件会在 Windows、macOS 和 Linux 上运行，但平台无关行为可能被平台特有的 fixture（测试前置数据）掩盖。字面 POSIX 路径在 Windows 上会变成相对于驱动器的路径；带主机名的 `file:` URI 在 Windows 上可能是有效的 UNC 路径；子进程管道关闭或事件循环调度在不同宿主上的稳定时点也不一致。FIFO、可执行模式位和目录搜索权限位等仅存在于 POSIX 的文件系统状态，在 Windows 上没有可直接构造的 fixture。

把 fixture 语法当成产品行为，要么会误报回归，要么会促使生产代码引入抹去原生路径语义的归一化。

## 决策

测试平台无关行为时，使用宿主的 `node:path` 和 `node:url` API 构造绝对路径与 `file:` URI，再根据约定要求断言原生绝对输出或稳定的工作区相对输出。无效 URI fixture 使用一种在所有受支持平台上都会被 `fileURLToPath()` 拒绝的编码形式。

传输故障测试会注入连接的消息写入器，并传入与真实 Node 流相同的异步写入回调错误。生产写入器仍会把分帧消息写入子进程 stdin。这种方式让真实子进程保持存活，使测试无需触及平台特有的管道句柄，也能确定性地区分传输故障与进程退出。

语言服务器的资源清理会委托给 subprocess provider 的 managed range：受支持的本地 Linux 使用 user-systemd scope，Windows 使用 kill-on-close Job；明确的 fallback 才使用负数进程组 ID 或同步 `taskkill /T /F`。参见[普通子进程 native containment 决策](../bug-fix/2026-08-20-subprocess-native-containment.zh.md)。Windows fallback 把所有 taskkill 结果都视为 best-effort，并忽略命令、权限、进程树不存在及其他状态失败。只读的提供方查询仅在选定的池化传输于该次查询开始前或执行期间失效时重试一次；服务器仍存活时返回的错误不会触发重试。终端测试会等待可观察的渲染输出，不假设一次事件循环轮转已经足够。

对于真正仅存在于 POSIX 的原语，测试只在该用例上排除 Windows。相邻的跨平台用例仍会固定拒绝非普通文件、不可用命令和无法访问的工作目录的行为。Windows 上受支持的路径仍受逐文件覆盖率门禁约束，不会随测试文件一起排除。

## 曾考虑的替代方案

**将所有路径和 URI 归一化为 POSIX 字符串。**这会使断言保持一致，但也会改变正确的 Windows 行为：外部路径是原生绝对路径，UNC 文件 URI 有效，而且已配置的主目录会按照宿主路径规则解析。

**操纵子进程管道内部状态，直至写入失败。**CRT 描述符与 libuv 句柄在不同宿主和 Node 版本上的所有权不同，因此这种做法测试的是未文档化的 fixture 机制，而非连接的写入失败约定。

**在 Windows 上跳过整个测试文件或包。**过宽的排除会隐藏受支持的行为。只排除无法在 Windows 上构造相应状态的单项 fixture；相关约定仍保持覆盖。

## 后果

可移植 fixture 需要更显式地构造，因为预期路径要从共享的原生常量派生，传输故障则通过狭窄的写入器钩子注入。仅适用于特定平台的排除项必须配有相邻的跨平台断言，以继续覆盖相应的产品行为。受支持的原生 Windows 宿主使用 Job 所有权；fallback Windows 的资源清理则在协议级优雅关停失败后同步发出一次 best-effort `taskkill`。该调用的结果会被忽略，因此 fallback 既不报告 taskkill 失败，也不证明清理返回前后代进程已经退出。
