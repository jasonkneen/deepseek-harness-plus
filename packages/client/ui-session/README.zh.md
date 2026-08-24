# @deepseek-ai/dsh-client-ui-session

[English](README.md) | 中文

面向 Session Controller 状态的 React 与 Slot adapter。本包在 root scope 提供 Session list 和 pending-interaction hook，物化逐 Session hook 与 prop，并拥有标准 `SessionProvider` 渲染行为，但不接管 Session transport 或 lifecycle 状态。

## 模型体验

无，因为本包适配浏览器侧 Session 状态，不注册任何面向模型的内容。

#### KV Cache 影响

无；Session selector 与 Slot scope 不会组装模型请求。

## 已知限制与暂缓事项

- **Pending interaction 是进程本地投影**——浏览器重连后，所属 Remote waterfall 必须重放仍未完成的请求。
