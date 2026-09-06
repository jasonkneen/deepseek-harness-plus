# Agent Note: 作业私有的 Windows Python runtime CI

Status: rejected — no measured throughput win; the shared pool reproduced the installed-wheel failure and the lane returned to hosted Windows

[English](2026-09-06-python-runtime-windows-selfhosted.md) | 中文

## 问题

原生 Python runtime 矩阵消耗托管 Windows 容量，但将构建原样迁移到共享常驻运行器会修改机器安装状态并复用用户级缓存。[CI 故障切换手册](../../implemented/process/2026-07-26-ci-failover-runbook.zh.md) 继续负责现有通用通道与运行器池前置条件；[原生 Windows CI 说明](../../implemented/process/2026-08-08-native-windows-pull-request-ci.zh.md) 负责独立的 Wine/原生拓扑。本提案仅覆盖 Python runtime 构建。

[只读前置条件探测](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34012679056) 发现 Windows 为原生 x64，Python 3.14.7 提供 venv/ensurepip，开发人员模式已启用，但没有 Python 工具缓存。Linux 缺少两个 manylinux 步骤都依赖的 Docker。这些观测允许开展仅针对 Windows 的实验，并不证明 runtime 构建能够通过。

## 提案

仅当 `inputs.ci && !inputs.release`、仓库为规范仓库，且事件为同仓库非 fork、非 Dependabot 的 PR（Pull Request）时，将 [runtime 工作流](../../../../.github/workflows/build-exe-for-python-sdk.yml) 的 Windows x64 目标路由到常驻运行器池。`DSH_CI_FAILOVER_WINDOWS=selfhosted` 启用此路由；未设置或其他值使通道留在托管运行器。发布/手动构建、其他事件、Linux/macOS 目标、规划作业与 SDK wheel 包作业继续使用托管运行器。吞吐量对比及并发作业/取消验收仍待完成。

[原生准备探测](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34013261224/job/101432611073) 下载 Python 3.10.20，验证命令解析与包含 pip 的冒烟 venv，断言已注册的 Python 安装与开发人员模式不变，并证明作业根目录已删除。观测到目录非空的删除失败后，Windows 递归删除使用有限重试。工作流另外在 action 后置步骤前清除导出的编译缓存路径并重置临时目录变量；定向测试固定这些赋值，它们不属于引用的探测提交。定向路由测试通过，反转故障切换条件会产生三个预期失败，随后恢复条件。首次完整原生运行成功构建可执行文件与 wheel 包，但 Python 用主机默认 GBK 编码读取 UTF-8 Session JSONL 时失败。准备脚本导出 Python UTF-8 模式与 UTF-8 标准流；本地强制 ASCII locale 的子进程复现默认解码失败并验证设置。[修复后的原生 Windows 作业](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34014942421/job/101437029350) 在 523 秒内成功完成，包括可执行文件与发布形态 wheel 包构建、安装后 wheel 包的无密钥/真实 API 测试、上传、私有根目录清理及 action 后置步骤。

[私有准备脚本](../../../../scripts/setup-python-runtime-windows.ps1) 使用预装解释器，在临时 venv 内引导安装 uv 0.11.23，再通过 `--no-bin --no-registry` 将托管 Python 3.10 下载到唯一的作业目录。它创建包含初始工具包的工具 venv，禁止进一步下载 Python。[固定版本的 uv 源码](https://github.com/astral-sh/uv/blob/3cdf50e0924f1ace7a92ddbac98b12a958b87688/crates/uv-cli/src/lib.rs#L6672-L6713) 提供这些参数；[实现](https://github.com/astral-sh/uv/blob/3cdf50e0924f1ace7a92ddbac98b12a958b87688/crates/uv/src/commands/python/install.rs#L667-L723) 禁止创建可执行文件链接与注册表登记。CI 检查开发人员模式，不负责启用它。

作业独占其 pnpm 存储、pkg/npm/node-gyp/Python/Node 缓存以及临时测试目录。依赖导入使用复制，而不是指向共享存储的链接；跳过托管缓存恢复/保存步骤。始终执行的清理步骤仅删除记录的作业根目录。检出不保留凭据。这些措施隔离资源，不能防御同一 Windows 账户下运行的恶意代码。

## 已考虑的替代方案

**独立的 Python 故障切换开关。** 对这台共享主机不采用：复用 `DSH_CI_FAILOVER_WINDOWS` 让响应者用一个开关恢复整个平台，不新增变量。代价是部署位置相互绑定：启用原生 Windows 故障切换也会把符合条件的 Python runtime 构建及其私有工具/缓存冷启动负载加到同一主机上；清除开关则让两类工作负载都回到托管池。

**使用私有工具缓存冷启动 setup-python。** 不采用：具体的 Python 3.10.11 [Windows 发布安装器](https://github.com/actions/python-versions/blob/98e79473eb342d6f43487a289ca633620404742e/installers/win-setup-template.ps1#L21-L70) 会删除匹配的机器/当前用户安装记录，并为所有用户安装。私有目录无法隔离这些注册表状态。

**由管理员预装 Python 3.10。** 强制仅使用缓存命中路径并采用私有依赖环境时可行，但观测到的运行器池并未提供它。便携 uv 避免要求修改主机安装。

**同时迁移 Linux。** 推迟到管理员批准 Docker 部署并完成 manylinux 验证之后；跳过任一 manylinux 步骤都会削弱 wheel 包兼容性检查。

## 验收标准

- 选择器测试证明发布/手动、外部仓库/fork/Dependabot 事件、非 Windows 目标及未设置或未知的开关值均使用托管路由。
- 一次可信的原生 Windows 运行构建可执行文件与发布形态 wheel 包，通过安装后 wheel 包的无密钥测试及必需的真实 API 测试，并上传 wheel 包，期间不写全局 Python 或注册表。
- 并发作业使用不同的缓存/工具根目录；成功、失败与取消路径均执行清理且不删除其他作业的路径。
- 在宣称成本或吞吐量改善之前，对比托管 Windows 的耗时与共享池负载。此前本说明保持 proposed 状态。

## 风险

私有存储与复制导入以热缓存速度和磁盘空间换取受限的修改范围。便携 Python 可能选择与 setup-python 不同的 3.10 补丁版本。下载仍依赖外部服务；运行器被强制终止可能阻止清理。共享账户信任与运行器池可用性仍是运维限制，托管回退也不能证明自托管运行器已就绪。
