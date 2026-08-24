# Agent Note: 原生 Windows 阻断拉取请求聚合流程

Status: implemented

[English](2026-08-22-native-windows-blocks-pull-request-aggregate.md) | 中文

## 问题

Wine 能快速触达阻断性 win32 工具链路径，但无法证明依赖 NT 内核、NTFS、PowerShell、Windows 进程控制或原生插件的行为。如果 `all checks passed` 能在完整原生作业仍处于待处理或失败状态时成功，它就没有强制验证仓库所支持的 Windows 行为。

原生作业会运行完整的受支持源码覆盖率分母及其所属 Windows 验收清单。优化后的 16 核托管运行能在五分钟目标内完成，因此这项保真度更高的结果足够短，可以进入必需的拉取请求路径。

## 决策

[ci.yml](../../../../.github/workflows/ci.yml) 中的 `all-checks-passed` 作业会在 `needs` 中同时列出 `windows` 与 `windows-native`。其现有的 `if: always()` 判定会像处理其他未成功依赖项一样处理失败、取消或跳过的原生作业，因此真实 Windows 作业成功前，`all checks passed` 无法成功。

分支保护继续要求单一且稳定的 `all checks passed` 检查，而不把原生作业名称添加为另一个受保护检查。[Windows 双通道拓扑](2026-08-08-native-windows-pull-request-ci.zh.md)负责每个作业的宿主、故障转移选择器与清单；本文负责二者的阻断关系。聚合记账作业为自身运行器采用 Linux 故障转移选择器，而 `needs` 会独立等待 `DSH_CI_FAILOVER_WINDOWS` 所选池中的作业。

## 曾考虑的替代方案

**让原生 Windows 只提供信息。** 这会保留最短的聚合路径，但也允许在保真度最高的受支持 Windows 判定仍处于待处理或红灯状态时合并。

**在分支保护中直接要求 `windows node 24 / native complete`。** 这会在仓库设置中复制工作流拓扑，并使作业名称变更成为控制面迁移。现有聚合流程已经提供一个稳定的必需检查，并会对未成功的依赖项快速失败。

**从聚合流程移除 Wine。** 原生 Windows 的保真度更高，但 Wine 仍能更快返回 win32 构建与生产网站信号、保留兼容性拓扑，并在原生清单运行期间更早地为维护者提供失败证据。

## 后果

每次合并都会等待原生 Windows 运行器容量与完整原生作业结束。该作业失败、取消或跳过都会使 `all checks passed` 失败；仅 Wine 作业通过并不足够。

工作流仍然是单个拉取请求 Action，并保留一个原生 Windows 作业、不变的测试覆盖率以及该作业内不变的门禁语义。必需聚合流程会增加原生作业的实测时长，但无需新增单独管理的分支保护检查。
