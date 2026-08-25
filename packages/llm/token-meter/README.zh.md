# @deepseek-ai/dsh-token-meter

[English](README.md) | 中文

通过单例 `ctx.tokenMeter` 服务进行具备回放感知能力的 token 测量。它从持久日志为每个会话推进一个隔离 fold，因此压缩（compaction）与其他压力敏感插件可以共享计量，无需依赖 `CompactionEngine`。

## 配置

估算器没有配置项。它有意使用一项固定启发式规则：每个 token 按四个字符估算，再加上角色、块与请求 envelope 字段的结构开销。任何配置键都会被拒绝；模型容量属于拥有精确提供方／模型路由的适配器，可通过 `ctx.llm.resolveModelInfo().context` 获取。

## 测量约定

`ctx.tokenMeter` 直接公开两个操作：

- `measure(session, requestHeader?)` 在同一个已消费日志 revision 上返回请求压力与当前已计价表层。
- `estimateMessage(message)` 使用固定启发式规则为一条消息计价。

`measure()` 会同步一次，并返回一个独立且深度不可变的快照。`totalTokens` 是请求与响应压力，`surfaceTokens` 是表层的路由定价总量，等于 `nodes[].tokens` 之和。`requestHeader` 覆盖会选择计价路由并影响压力字段；节点集合仍描述当前会话。每次调用都会克隆带位置的节点，因此测量是 O(surface)。

fold 跟踪完整请求标头快照、步骤边界、表层追加与替换、成功 assistant 消息、提供方用量，以及每条 assistant 消息引用的分片 seq。每次计量都会通过可选的 `llm` 服务把生效 envelope 的 provider/model 解析为该路由声明的请求图片定价：图片出现处按路由请求实际发送的视觉 token 加模型可见文本计价，未声明定价的路由与组合保持固定启发式规则。每个节点还携带与路由无关的固定价格 `heuristicTokens`，供影子价协议为替换计价。只有当最新成功调用的规范请求 envelope 与已测量 envelope 匹配，且其总量不低于该调用的完整路由定价锚点时，才会复用提供方用量；后续成功会替换较早锚点。否则会对当前 envelope 与表层进行完整估算。表层变更保持相对于匹配锚点（按同一路由重新定价）的带符号值，包括缩减替换后的负 delta。

用量计量会求和不重叠的输入、cache-read、cache-write 与输出 bucket；不会再次添加推理（reasoning）。每次成功调用都会记录一个 assistant 锚点，包括无内容调用。显式的空 `sourceEventSeqs` 列表表示已知空提供方流；遗留记录缺少该列表时，fold 会保守地将持久 assistant 输出视为提供方输出。

## 会话投影

当组合提供 `ctx.sessionProjections` 时，token-meter 会通过一个可选子 fiber 注册三个单元。

`tokenUsage` 携带完整持久日志中的 `uncachedInputTokens`、`outputTokens`、`cacheReadTokens` 和 `cacheWriteTokens`。即使请求随后失败，用量分片仍会计入；最终 assistant 消息用量会替换同一次模型 attempt 的流式样本，而不是重复计数。匹配的 `llm/retry-started` 边界会结束该替换作用域，因此复用同一 `(turn, step)` 的重试会贡献一次新的计费 attempt。推理仍是输出的一个细分项。只保留单个最新样本，依赖的是会话日志的一条顺序性质：一旦某个更晚的步骤报告了用量，合法日志就绝不会再为更早的步骤报告用量。

token-meter 还拥有一份可安全用于浏览器的纯 fold，将一个完整 Turn 的持久事件归并为精确的 attempt 与 Turn 用量。`step/start` 与 `llm/retry-started` 打开真实 attempt；最终消息用量替换该 attempt 的流式样本；终止失败、重试与步骤边界关闭它。缺少生命周期证据、计数不安全或精确总量矛盾时一律 fail-closed。展示消费方只选择完整 Turn 窗口并渲染结果，不再定义第二套记账状态机。

`contextPressure` 携带可选的 `pressureTokens`（提供方报告的最新提示词规模，为未缓存输入加缓存读取与写入之和）、可选的 `projectedTokens`，以及来自最新一条 `request/context` 记录的可选 `contextWindow`。提供方报告用量前两个数字都保持缺失；路由适配器未公布容量时容量也保持缺失。输出不计入其中，因此轮次流式输出期间 `pressureTokens` 保持不动，等到下一个请求报告用量时才前进。

`projectedTokens` 是「下一个请求的提示词要花多少」：在该样本之上，加上自取样以来表层增减部分的启发式重新计价，并将下界钳制为零。它在 `surface-projection.ts` 中的 O(1) 折叠会跟踪追加，并消费紧邻替换之前记录的影子价；在完整计量的日志上，它无需保留逐节点价格也能与测量服务的带位置 plan/commit 折叠一致。只有增量部分是估算的，因此这个数字既锚定在提供方读数上，又能在内容落地——或压缩遮蔽一段区间——的瞬间做出反应。最后这种情况正是该字段存在的理由：压缩通过直连的 `ctx.llm.stream()` 调用生成摘要，自身不追加任何用量，所以仅凭 `pressureTokens` 会一直报告压缩前的提示词规模，直到再完成一整个轮次为止。占用率展示读取 `projectedTokens`。

`contextBreakdown` 携带启发式的 `systemTokens`、`toolsTokens` 与 `messageTokens`，描述上下文的组成而非提供方计费规模。envelope 数字在每条 `request/header` 上按后者胜重新计价；消息数字重放与 `contextPressure` 相同的 O(1) 影子价折叠，因此在完整计量的日志上，它在每个事件边界都等于 `measure().nodes[].heuristicTokens` 之和，压缩会按记录的影子价缩小该值。路由定价的 `measure().surfaceTokens` 在路由模型重新为图片计价时会与该值不同。若替换前没有紧邻的影子价声明，这个有界投影会保持不变，因为它无法重建被替换区间。三个数字都使用测量服务的固定启发式规则，属于估算值。它们加起来不等于 `projectedTokens`，后者的提供方锚点体现了这些明细行仍然带有的误差（按「4 字符 ≈ 1 token」计价时，CJK 文本与 JSON schema 会被严重低估）。请把它们当作近似的**组成**呈现，而不是总量。

三个单元都使用标准的投影基线、实时帧、seq 高者胜值仓和 JSON 检查点路径。卸载 token-meter 会移除这三个键。不带投影 seam 的组合会保留测量服务的既有行为。

### 上下文占用率是刻意为之的近似值

这些占用率字段各自后者胜、彼此独立，**不是**对单个请求的一次原子观测。切换模型时，新容量会与上一路由的样本配对，直到下一个请求报告用量为止；而 `pressureTokens` 描述的是最后一个请求，不是此刻的表层——`projectedTokens` 把该样本沿表层的增减推进到当下，但它的锚点仍然是那个较早的请求。

这是刻意的选择。占用率百分比是面向用户的参考数字，既不是计费记录，也不是门控输入：harness 中没有任何环节依据它做决策，压缩改为直接读取 `measure()`。UI 用测得的压力除以为所选模型单独解析出的容量来计算占用率。

[Agent Note](../../../.agents/notes/implemented/architecture/2026-07-29-projected-token-usage-and-request-context.zh.md) 记录了否决「让这对值保持原子」方案的那次对比。需要同一边界精确数字的消费方应在自己的请求边界调用 `measure()`，而不是读取该投影。

## 组合

```yaml
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compaction-basic'
```

两个插件都有可用默认值。meter 只消费可选的 `llm` 服务，且仅用于解析路由声明的请求图片定价；压缩保持可选。部署会在 LLM（大语言模型）适配器上配置容量与图片定价，并在 `dsh-compaction-basic` 上配置压缩策略。

## 模型体验

通过 `dsh-compaction-basic` 等消费方间接影响；该服务自身不添加提示词、消息、schema、工具或模型调用。

#### KV Cache 影响

不会直接失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **固定启发式规则是近似值**：没有可复用提供方用量的文本按字符数加结构开销计价，而不是使用精确提供方 tokenizer 或请求 serializer；只有声明了定价的路由上的图片出现处携带提供方精确的视觉 token。
- **每次测量都会克隆当前表层**：一致且不可变的快照使读取成为 O(surface)，包括低于阈值的压力检查。
- **提供方用量只能为完全相同的规范 envelope 复用**：提示词、前缀、工具、提供方、模型或调用配置变更都会有意回退到完整启发式估算。
- **保守处理缺少源事件 seq 的遗留记录**：没有 `sourceEventSeqs` 的 assistant 消息无法区分提供方输出与 listener 改写，因此 fold 不会声称已知空流或精确分片流。
