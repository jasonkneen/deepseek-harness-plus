# @deepseek-ai/dsh-client-locale

[English](README.md) | 中文

locale 插件：LocaleRuntime——`zh`／`en` 偏好以 `locale.preference` 存储在 `$DSH_HOME/settings.yaml` 中；若没有显式 Host 值，全新浏览器会暂时使用 `navigator` 请求的语言（按主子标签匹配；若其请求的语言本应用都不提供，则使用 `en`）。Host 读取在插件激活后执行，因此 settings 服务不可用不会阻塞页面；读取结果会实时替换浏览器暂定值。Client 在非 loopback 页面禁用 Host settings 持久化，因此这些页面的 locale 选择仍只保留在进程内，尽管 Connection 会认证每个 API 方法。`locale/change` 仅在切换语言时触发；插件会在激活时以及每次切换时把 `<html lang>` 指向当前 locale（`zh-CN`／`en`）。该服务还拥有 ns×locale 字典注册表（类型化 `register(ns, {zh, en})` 按 `LocaleNamespaceMap` 校验，`bind(ns)`→`TranslateNS<ns>`；查找链 ns → common → en → key），实现 slot 系统的 `LocaleFace`，并经 `ctx.slots.installLocale` 自行安装，支撑框架注入的 `t` 标准席位（`Translate`／`TranslateNS` 是 ui-slots 的类型；请从那里导入——本包的再导出仅为字典所有者提供便利）。产品编写的 Client UI 文本必须经这些 typed 字典或已本地化原子组件 prop 进入展示；`verify-client-ui-i18n` 会强制这项源码归属（[决策](../../../.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.zh.md)）。该持久化边界由[Host settings 支撑的偏好决策](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.zh.md)拥有。

## 模型体验

无。locale 注册表为浏览器 UI 文案提供服务；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **注册表持有的文本只读取一次翻译**——在 slot 渲染路径之外于注册时捕获的文案（例如 command 注册表中的 `/model` 命令描述）在重新注册前保持注册时的语言；slot 渲染的文案随切换实时更新。
