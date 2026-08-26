---
description: "web GUI 宿主侧的包映射：共享 API 网关、承载它的 HTTP 服务器、SPA dist 服务器、工作区目录选择 seam 与插件清单投影。"
kind: "package-group"
---

# host/ — Web GUI 宿主侧

[English](README.md) | 中文

## 概述

`host/` 组是 web GUI 宿主侧：所有客户端形态共享的 API 网关、承载它的普通 HTTP 服务器、服务已构建 Web 壳的 SPA dist 服务器、带原生／浏览／自适应组合包的工作区目录选择 seam，以及只读的插件清单投影。这八个包都是产品包；消费网关的浏览器半侧位于 [`client/`](../client/README.zh.md)，组合应用是 [`apps/cli`](../../apps/cli/README.zh.md)，它启动 [`dsh-base` 组合包](../bundle/base/cordis.patch.yml) 来提供 `apps/web/` 下的 web 应用。网关约定与传输无关，选择器后端可在共享 seam 后互相替换。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

八个包分别承担宿主角色；各包的 README 拥有自己的约定与配置。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`apiproxy/`](apiproxy/README.zh.md) | 共享 API 网关：类型化的客户端↔宿主约定、fetch 载体与网关服务 | `ctx.apiProxy` |
| [`webserver/`](webserver/README.zh.md) | 浏览器 HTTP 服务器：具名路由、upgrade、index 转换与回退席位 | `ctx.webServer` |
| [`frontend-static/`](frontend-static/README.zh.md) | 占据 webserver 回退席位的 SPA dist 服务器 | 消费 `ctx.webServer` |
| [`directory-picker/`](directory-picker/README.zh.md) | 工作区目录选择 seam：能力约定与错误词汇 | `ctx.directoryPicker` |
| [`directory-picker-native/`](directory-picker-native/README.zh.md) | 面向宿主屏幕前操作者的原生 OS 选择器后端 | 注册 `ctx.directoryPicker` |
| [`directory-picker-browse/`](directory-picker-browse/README.zh.md) | 应用内目录浏览器后端，也服务于远程客户端 | 注册 `ctx.directoryPicker` |
| [`directory-picker-auto/`](directory-picker-auto/README.zh.md) | 在启动时挂载匹配后端的宿主自适应选择器 | 挂载一个后端 |
| [`plugin-inventory/`](plugin-inventory/README.zh.md) | 当前 Loader 条目的只读投影 | Remote `pluginInventory/list` |

-----

<a id="related-documentation"></a>
## 相关文档

先从传输与工作区记录的子系统参考读起，再看网关背后的分层决策。

- [HTTP 服务器子系统](../../docs/subsystems/web-server.zh.md)——webserver 的路由、匹配顺序与配置。
- [工作区子系统](../../docs/subsystems/workspace.zh.md)——目录选择器所喂给的工作区记录。
- [GUI 分层与 RPC 协议 RFC](../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.zh.md)——网关约定为何与通道无关。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
