# @deepseek-ai/dsh-client-ui-approval

[English](README.md) | 中文

基于 Agent-scoped Remote Event waterfall 的浏览器审批界面。插件通过 `ctx.uiSession` 发布每个待处理请求、接管 Conversation composer、按需渲染关联的 Tool 详情，并将用户决定返回给等待中的 Host 请求。

## 模型体验

无，因为本包只在浏览器中呈现审批请求，不注册任何面向模型的内容。

#### KV Cache 影响

无；审批请求和响应的呈现不会改变模型请求。

## 已知限制与暂缓事项

- **面板只提供临时决定**——它支持仅本次允许和拒绝；持久权限策略仍由 Host 侧审批 package 拥有。
