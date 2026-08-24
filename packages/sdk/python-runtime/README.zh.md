# @deepseek-ai/dsh-sdk-python-runtime

[English](README.md) | 中文

这是为暂时保持不变的 Python SDK 运行时提供的私有直读配置载体。其 [`jsonrpc`](../server/README.zh.md) 入口通过按换行分隔的 stdio 为 SDK 客户端提供服务，外部 `cordis.yml` 则负责组合主干、后端和服务插件。该 npm 包不公开 bin，也不会发布；Python SDK 既有的 `dsh-jsonrpc-agent-pkg-<platform>-<arch>` [单文件可执行运行时](../../../.agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.zh.md)从封闭部署树打包 `lib/packaged-bin.js`。裸插件从该树解析，相对插件仍以配置目录为基准。

## 配置发现

第一个非空通道生效：先 `$DSH_CORDIS_CONFIG`，再位置参数 `argv[2]`。如果二者都没有指向现有文件，打包入口会向 stderr 打印单行用法并以 1 退出；没有工作目录回退或内置回退。[`dsh-app-boot`](../../boot/app-boot/README.zh.md) 会使插件加载失败成为致命错误。此协议不使用 `DSH_SNAPSHOT`。

不含 `dsh-sdk-jsonrpc-server` 的配置仍然有效，只是不提供任何服务；该载体不会指定服务器插件。

## 退出生命周期

stdin EOF 和 `SIGTERM` 会 dispose（释放资源）根上下文，等待完全停稳后以 0 退出；`SIGINT` 完成同样的 dispose 后以 130 退出。EOF 可能按[分发 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.zh.md) 所述截断正在处理的轮次。`jsonrpc` 插件拥有先响应再退出的协议关闭流程；两条路径均幂等，即使发生竞态也安全。

## stdout 是协议

stdout 只承载 JSON-RPC 帧。该载体和启动守卫在 stderr 上输出诊断，配置必须省略 stdout logger。

## 模型体验

模型体验由外部 `cordis.yml` 加载的插件间接提供；这些插件负责所有面向模型的提示词、schema、消息和结果，该载体不添加任何内容。

#### KV Cache 影响

不会直接失效；由上述消费方负责请求前缀的任何变更。

## 已知限制与暂缓事项

- **临时直读配置例外**：为了保持当前 Python 可执行文件与 wheel 包行为不变，该私有载体暂时不经过 `dsh --profile sdk`；后续 Python 运行时迁移会删除它，之后再重命名可执行文件族。
- **载体无法证明配置提供 JSON-RPC 服务**：不含 `dsh-sdk-jsonrpc-server` 条目的有效配置也能成功启动，但不会提供任何服务。
- **不存在内置或默认配置**：每次启动都必须提供 `DSH_CORDIS_CONFIG` 或位置路径；部署方负责完整的插件树和 stdout 纪律。
- **stdin EOF 会截断正在处理的工作**：客户端消失时立即释放根上下文；需要有序完成的调用方应使用协议级 `shutdown` 请求。
