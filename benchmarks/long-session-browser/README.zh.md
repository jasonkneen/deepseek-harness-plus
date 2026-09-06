# 长 Session 浏览器基准

[English](README.md) | 中文

本文说明 [long-session.bench.ts](long-session.bench.ts) 中必需的 Chromium 工作流。它打开一个合成的 240 轮 Session，加载所有更早的分页，访问 Trajectory，返回 Chat，并在流式回复期间输入下一条草稿。随产品维护的 Web scaffold 拥有隔离的主目录、持久化、重放适配器和回环监听器；Chromium 加载构建后的 Web 产物，而非替代开发服务器。

## 运行

`pnpm run test:bench` 先构建 library、worker 和 Web 产物，再串行运行基准清单。产物已构建时，通过 `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/long-session-browser` 选择此目录。首次运行前，通过 benchmark workspace 安装 Chromium。

## 测量

三个全新浏览器进程与 scaffold 环境产生原始样本及中位数判定。打开和分页在预期对话状态出现且经过两次动画帧后结束；这包含一次渲染机会，而非硬件显示时间戳。分页报告每一页，并对各样本最慢分页时间的中位数执行预算检查。流式报告首段可见回复、真实草稿键入、完整回复壁钟时间和 Chromium 主线程任务时间。发送控件查找限定在 composer seat；回复标记查找与输入事件文本证据仅读取最新 Assistant step，避免重复扫描全部历史文本与无障碍属性。实际首个输入事件必须观察到未完成的回复；完成测量在 Host 结算后等待新 turn-tail 渲染。强制 GC 后的 heap 与 DOM 数量仅供诊断，不作为泄漏预算。

fixture（测试前置数据）包含混合语言提示、正文、推理、20 个代码块和 40 个合成工具结果。每条历史 Assistant 都含紧凑 stream，由生产 accumulator 从匹配的推理、文本、工具参数、usage 和 finish chunk 构建。其内容不来自模型、工具、外部网络、录制 Session 或私有 Harness 主目录。流式回复以 8 ms 重放间隔发送 120 个文本 delta，经过真实输入框、agent loop（智能体循环）、传输与持久化。

[决策记录](../../.agents/notes/implemented/testing/2026-09-06-frontend-performance-budgets.zh.md)拥有校准、排除项与替代方案。更大规模的[手动诊断](../../apps/web/tests/complex-history.perf.ts)保持独立。
