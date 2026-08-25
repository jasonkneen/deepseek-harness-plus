# @deepseek-ai/dsh-client-store

[English](README.md) | 中文

供 Client controller 与 renderer adapter 共用的不依赖 React 的 observable 和 snapshot-store 基础设施。本包负责同步与 animation-frame 发布、基于 Immer 的更新、浅比较和可选的浏览器持久化；React hook 的构造仍属于 `@deepseek-ai/dsh-client-ui-renderer`。

## 模型体验

无，因为本包提供浏览器侧状态基础设施，不注册任何面向模型的内容。

#### KV Cache 影响

无；这些 store 既不组装也不发送模型请求。

## 已知限制与暂缓事项

- **持久化仅限浏览器本地**——持久化 store 使用 `localStorage` 中的 JSON；非浏览器运行时会禁用持久化，本包也不提供跨设备同步。
