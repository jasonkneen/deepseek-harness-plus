# @deepseek-ai/dsh-client-test-runtime

[English](README.md) | 中文

面向客户端功能测试的 jsdom slot 测试运行时：真实 Cordis `Context`、renderer 所有的 `SlotRegistry` 与生产 `UiSession` adapter，围绕带类型的 Session 和 Workspace Controller 测试替身组装。功能套件无需复制生产 renderer 或 adapter 逻辑，即可测试声明、注册、scope、store、注入、渲染、更新与销毁。

替身实现通过 Cordis 消费的 owner 接口：`TestSessions implements ISessions`、`TestWorkspaces implements IWorkspaces`，每个 fixture Session 是 `FixtureSession implements SessionFace`，`stubSettingsScope` 实现 `SettingsScope`。运行时挂载 `UiSession`，由它从 Controller binding 派生 renderer 标准 source。fixture 通过 `updateSessionSnapshot` 发布 Session 生命周期状态，通过 `TestWorkspaces.update` 发布 Workspace 状态，通过 Session face 发布 projection 值，并通过 Session event feed 提供 Conversation 输入。未打桩的 `ISession` 行为会在错误中指出缺失方法。

局部 DOM 快照：`declare(children)` 注册自动 frame，逐 key 的 `<div data-slot>` 包裹层即快照根；`renderSlot(key, owner)` 返回该 slot 的局部视图（container、限定范围的 Testing Library 查询、原位 `update(owner)`）；注册的快照序列化器把 CSS-module 哈希类名折回语义名（`_frame_a1b2c3` → `frame`）保持 `.snap` 只含结构，并把 `<svg>` 内部折叠为 `data-content` 指纹。需要自定义页面 frame 的套件改用 `root.declare(children, Frame)`；`mount(plugin)` 在真实 fiber 上运行并对缺失服务先行报错；`dispose()` 沿单一轴拆除视图、feature fiber、已铸 scope 与持久化 store 状态。

不属于产品插件图（无 `dsh.client`）；feature 包仅以 `devDependencies` 依赖之。

## 模型体验

无；本包是浏览器侧测试基础设施，无一物到达模型请求。

#### KV Cache effect

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

- **仅用于 Vitest 与 jsdom。** 所有消费者都是仓内、面向浏览器的 Vitest 套件。本包不是产品插件，也不是通用 Node 测试框架。
- **Session、Conversation 与 Chat fixture 相互分离。** `sessionSnapshot` 只包含 Session Controller 状态，`conversationSnapshot` 包含目标无关的 Conversation 状态，`chatSnapshot` 包含 Chat 目标状态。测试装配过程时应提供 Session event entry，不得向 `SessionSnapshot` 添加 Conversation 或 Chat 字段。
