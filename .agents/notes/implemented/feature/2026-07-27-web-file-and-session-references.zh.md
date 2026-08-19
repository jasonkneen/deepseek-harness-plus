# Agent Note: Web 文件与会话引用

Status: implemented

[English](2026-07-27-web-file-and-session-references.md) | 中文

## 问题

Web 输入框已有可复用的斜杠命令／引用触发流水线，但它的 `@` source 只是不会产生实际作用的 subagent 标签文本。Web 需要由宿主提供工作区路径发现和结构化跨会话快照，同时避免在浏览器中扫描宿主文件系统或把会话身份绑定到显示标签。

## 决策

Web 通过 `@deepseek-ai/dsh-client-ui-reference` 暴露一个合并的 `@file` 与 `@session` 菜单。每次处理未加引号的查询时，它会并发启动两项 Remote 发现调用，以确定性顺序把文件排在会话之前，并使用注册在 locale 字典中的标签；不可选择的文件与会话分组标题会区分两个连续的候选分组，且不会进入键盘选择索引。尚未闭合的带引号 token 只搜索文件。任一候选领域都可以独立失败，不会隐藏另一领域成功返回的行。

文件功能遵循由三个包构成的 seam：`@deepseek-ai/dsh-file-reference` 拥有 `ctx.fileReferences`、共享 `@path` token 语法、候选形状和稳定的模型指引；`@deepseek-ai/dsh-file-reference-local` 拥有每个 agent（智能体）有界的宿主文件系统索引、失效处理和作用域内的提示词安装；`dsh-client-ui-reference` 消费生成的 Remote 命名空间与共享语法。选择文件后仍只会把路径文本写入提示词，选择目录则会在其尾部斜杠后重新触发补全。

选择会话会创建一个原子的输入框引用。可见标签只用于呈现，隐藏值和剪贴板形式则是宿主生成的规范 `@[label](dsh-session:…)` mention。普通 `session.prompt` 投递会原样携带该 mention。session-reference 服务会在 `agent/pre-step` 解析已接受的直接用户消息，捕获每个源，在保留直接消息 id 的同时把规范 mention 替换为可读文本，并把冻结快照插入到该消息紧前。API Proxy 不包含引用专用路由、依赖或错误码。

输入状态机在默认 sink 报告宿主已接受前，会保留普通草稿文本和原子引用。序列化或提示词传输失败后，同一草稿会回到可编辑状态。接受后，引用准备属于 agent 轮次；格式错误的 mention、源读取失败、取消或预算失败会终止该轮次。已记录的提示词仍是回放权威。具体的 user 和 steering chat-node 定义会关联紧邻前一条 session-reference 上下文中的标签，因此渲染器会从自身节点数据接收关联信息，并显示精简的来源摘要，而不是快照 JSON。

## 引用事务

```text
type @ → parallel file/session Remote calls → pick path text or canonical session chip
       → serialize draft → ordinary session.prompt enqueue
       → agent/pre-step parses mentions → capture sources → context + readable prompt
```

文件查询仅供参考且可取消；选择操作本身不会读取文件。会话准备针对一个已接受的模型步骤保持全有或全无。queued 消息被领取时会捕获每个源，因此队列编辑和从 queue 移动到 steer 使用同一路径，无需网关协调。

## 备选方案

**在 Web 客户端内部实现文件发现与语法。** 不予采纳，因为浏览器侧代码无法安全访问宿主工作区，而且重复的语法、排序、边界和失效处理会与宿主提供方产生偏差。

**通过普通文件系统工具 RPC 扫描文件。** 不予采纳，因为递归模糊发现属于编辑器低延迟工作，而不是面向模型的精确文件系统操作；该方案还会把菜单与工具策略及提供方往返绑定。

**选择文件时立即附加其内容。** 不予采纳，因为该方案会在尚未确定相关性时消耗上下文，并绕过可从日志重建、可审计的 `read` 调用／结果序列。

**用普通 `@label` 文本表示会话。** 不予采纳，因为标签既不稳定也不唯一，无法标识源快照。宿主生成的规范提及标记既能保留不透明会话身份，也能保持显示内容易读。

**提示词准入结算前清空输入框。** 不予采纳，因为传输或准入失败会丢失请求唯一可编辑的副本，并在视觉上错误表示一个从未成功的接受操作。

## 验证

包（package）测试固定共享文件语法和排序、缓存失效及生命周期清理、Web 并行查询、带引号的路径、候选项独立失败、取消、不改变候选项索引的分组标题、文件／目录继续补全、规范会话 chip、相邻引用及相邻文本条件下的引用投影、codec 无损往返、生成的 Remote 类型推断、pre-step 准备、下游拒绝，以及 chat node 自有的标签关联。无密钥的装配 Web 快照会渲染可用的引用分组，并通过真实客户端组合依次选择文件和会话引用。

## 后果

Web 现在使用共享的 `@file` 发现 seam 和结构化会话引用身份，宿主服务仍然是文件系统与会话访问的权威来源。文件和会话发现都是所属服务上的一元 Remote 契约，因此生成的客户端类型会替代手写 RPC 接口，浏览器 bundle 中也不包含 Node API。候选查询失败仍会让菜单静默降级。引用准备失败发生在提示词已接受之后，并会结束 agent 轮次。文件引用只产生路径文本和稳定的条件式指引成本，而会话引用仍保留 `dsh-session-reference` 所拥有的有界快照开销与信任限定文本。
