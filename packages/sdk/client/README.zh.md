# @deepseek-ai/dsh-sdk-client

[English](README.md) | 中文

通过 stdio JSON-RPC 驱动同版本 [`dsh`](../../../apps/cli/README.zh.md) runtime 的 TypeScript client SDK。`DeepSeekHarness` 是高层自有运行 API，`HarnessClient` 是低层协议 client。本包依赖 `@deepseek-ai/dsh` 并直接解析随安装的 CLI，因此普通消费方无需发现 runtime 可执行文件，也无需维护第二套应用配置。干净源码 checkout 中若不存在 `lib/bin.js`，client 会通过已解析的 `tsx/esm` loader 启动同一包的 `src/bin.ts`，并应用一个省略构建期生成 Typert 贡献加载的内部 patch；SDK JSON-RPC 应用不消费该远程网关。已安装包使用完整的构建后入口。

两层 client 接受同一组启动字段：`dshBin?`、`profile?`（默认 `sdk`）、有序 `patches?`、`dshHome?`、`processCwd?`、`env?`，以及请求、初始化、关闭和 dispose 超时。相对调用方的 CLI 模块、patch、显式 home 与进程 cwd 路径会在 spawn 前转为绝对路径。client 会在所有平台上通过自身当前的 Node 可执行文件运行 dsh CLI 模块。省略 home 时保留 dsh 的普通解析（先 `DSH_HOME`，再 `~/.dsh`）；显式 home 会覆盖子进程环境。提供 `env` 时，它整体替换子进程环境；client 会在 `start()` 实际 spawn 时读取该对象或 `process.env`，所以首次启动前的修改会生效。

组合自定义属于 profile 系统。使用 `dsh plugin --profile <name> …` 安装持久组合包与插件依赖，编辑该 profile 的 `cordis.patch.yml`，再通过 `profile` 选择。`patches` 用于有序的逐次启动覆盖。patch 会替换配置行的完整 config；自定义 profile 必须保留 `@deepseek-ai/dsh-sdk-app` 或另一个 SDK server 配置行。

## DeepSeekHarness

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

await using harness = new DeepSeekHarness({
  profile: 'sdk',
  patches: ['./automation.cordis.yml'],
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  maxTokens: 49_152,
})
const result = await harness.run('say hi')
console.log(result.finalResponse)
```

dsh 进程在首次使用时惰性启动，并在多次 `run()` 之间持续归实例所有；必须调用 `close()`（或使用 `await using`）。`start()` 会记忆化有界的 `initialize` 握手；`initializeTimeoutMs` 默认 10 秒，诊断会写明所选 profile 并附带保留的 stderr 尾部。握手失败会回收 runtime，之后的调用可以用新进程重试，直至终结性的 `close()`。

握手携带绝对 session workspace、provider/model 和可选的正整数 `maxTokens`。`run(input, { sessionId?, onNotification? })` 接受文本或 `SdkPromptContentBlock[]`；内联栅格图片块携带规范 base64 与 `mimeType`，并在运行时内成为持久附件。该调用将 prompt 入队，等待持久 inbox 回执，并收集到整个根 agent 下次 idle。它返回 `RunResult { sessionId, finalResponse, events, notifications }`；`events` 仅限根 session，notification 还包括发现的后代。

## HarnessClient

低层 client 提供 `start()`/`initialize()`/`prompt()`/`request()`/`close()` 与 notification 订阅。`prompt()` 返回入队后的持久消息 ID，而不是 prompt 结果。`subscribeSessionTree(id)` 把进程级 notification 流限定到一个 session 血缘。导出的失败类型为 `JsonRpcResponseError`、`RequestTimeoutError`、`SdkProtocolError` 与 `TransportClosedError`。

`close()` 先请求协议 `shutdown`（默认上限 1000 毫秒），再执行 stdin EOF → SIGTERM → SIGKILL（`disposeEofGraceMs` 6000、`disposeGraceMs` 3000），直到进程退出。client 位于任何 Harness context 之外，因此其私有进程 adapter 是 `dsh-subprocess` 中记录的 SDK 托管传输例外；通用 command/argv 启动仅是包测试机制，不是消费方接口。

## 模型体验

本库不会增加任何模型可见内容；所选 dsh profile 负责子进程模型的 prompt、工具、策略和缓存前缀（见 [`dsh-sdk-app`](../../bundle/sdk-app/README.zh.md)）。

#### KV Cache 影响

client 进程中无影响。子进程的 profile、patch、provider、model 与历史决定缓存复用。

## 已知限制与暂缓事项

- **所选 profile 可以省略 SDK server**：初始化会在配置的上限失败并写明 profile；请保留 SDK app 组合包或等价 server 配置行。
- **没有轮次中取消或逐 prompt 结果**：放弃自有活动意味着关闭 runtime；模型结果保留在 session event 中。
- **受信任 patch 可能破坏 stdout 纯净性**：随附 SDK profile 只写协议 frame，但任意用户插件负责自己的输出行为。
- **client→server notification 与 server→client request 尚未实现**。
