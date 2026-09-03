# Agent Note: 打开大型 Session 的必需 CI 性能 gate

Status: implemented

[English](2026-09-04-session-open-performance-gate.md) | 中文

## 问题

Session format v2 的推出改变了两条成本随模型输出增长的路径：JSONL backend 在首次 `open()` 时迁移并发布 released-v0 log，Client 则 fold 每个已结算回复中嵌入的紧凑 stream。两条路径都没有可执行的性能检查，因此首次打开在 127,400 事件的合成 log 上从约 35 ms 增长到约 5 s（在 575,000 chunk 的真实 log 上从约 0.3 s 增长到 26 s，峰值 RSS 2.7 GB，并在 512 MB 堆限制下耗尽堆），以及 Client fold 随流式 delta 数而不是紧凑记录数线性增长，都未被察觉地进入了 master。单元测试使用小 log，coverage gate 只度量行数，现有的 `test:web:perf` 清单是 CI 之外的手动诊断。

## 决定

Linux pull request 运行必需的 `node 24 / benchmarks` job，执行 `pnpm run check:ci:bench` → `pnpm run test:bench` → `vitest.bench.config.ts`，后者收集 `packages/*/*/tests/**/*.bench.ts` 与 `*.bench.client.ts` 并逐文件运行。该 job 单独运行基准 lane，与其他必需 Linux worker 使用同一 runner 选择器和 failover 开关，并加入 `all checks passed` 判定。

每个基准都在进程内按固定参数合成输入：编号的 prompt、计数 token、固定时间戳。绝不使用录制的 Session，因为它们携带用户内容、在不同机器上不同，并随 fixture 重新录制而漂移。每个基准在强制执行预算的常量旁记录其预算，预算遵循三条规则：壁钟预算取目标成本的小倍数并远低于所防护的回归；内存预算把被测路径放在固定 `--max-old-space-size` 的子 Node 进程中运行，使分配回归无论 runner 物理内存多大都以 out-of-memory 退出失败；缩放断言比较同一负载的两个规模，使复杂度回归在任何主机速度下都失败。

前两个 gate 覆盖两条回归路径：

| 基准 | 负载 | Gate |
|---|---|---|
| `packages/session/session-persistence-jsonl/tests/open-generation.bench.ts` | 200 轮 ×（500 text + 125 reasoning delta）= 127,400 个 released-v0 事件，约 2.8 MB，经冻结 v0 codec 以 packed row 编码 | 迁移的首次 `open()` 在 128 MB 堆下 ≤ 2,000 ms；新进程打开已发布 current generation ≤ 500 ms；三次尝试取最小值 |
| `packages/client/ui-chat/tests/conversation-fold.bench.client.ts` | 200 个回复，每个紧凑 stream 含 2,000 text + 500 reasoning delta（1,600 条记录中 500,000 个 delta），由真实 `ConversationNodeAssembler` 经全部 Chat Definition fold | 大窗口 fold ≤ 150 ms；大窗口 fold ≤ 每回复 100 delta 的同一窗口的 3 倍 |

在引入该 gate 的提交上于参考机器测得：迁移基准耗尽 128 MB 堆，fold 基准在小窗口与大窗口之间缩放 11 倍，因此两个 gate 都在回归代码上失败，并在两条路径改为 O(records) 工作后通过。

## 考虑过的替代方案

**扩展手动 `test:web:perf` 清单。** 拒绝：它有意留在 CI 之外，测量的是简化 fold 而非已注册的 Definition，且不做任何断言。

**只用时间预算。** 拒绝：单一绝对预算要么在较慢的 runner 上失败，要么在较快的 runner 上放过回归；堆上限与缩放比给出与主机无关的判定，壁钟预算则作为用户可见症状所对应的超时保留。

**用真实录制语料做基准。** 拒绝：语料 fixture 按策略保持小体量，录制材料不得成为基准输入，且其重新录制会静默移动基线。

**把基准放进现有 gate 聚合中运行。** 拒绝：聚合在一个 runner 上并发运行各 gate，壁钟测量会继承邻居的 CPU 负载。

## 后果

每个 pull request 多付出一个几分钟的必需 Linux job，其时间主要花在安装而不是基准本身。让首次打开或 Client fold 慢于预算、重于堆限制或与流式 delta 数成正比的改动，会在引入它的 PR 中失败，并把测得的数字打印在 job 日志里。预算变更是对常量及其理由注释的受评审编辑，绝不是环境变量覆盖；新增基准必须说明它防护哪条 owner 可见路径和哪类回归。该 gate 不测量浏览器渲染、网络传输或真实录制的 Session；这些仍由手动 `test:web:perf` 清单和评审覆盖。
