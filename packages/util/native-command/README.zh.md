---
description: "供宿主原生 OS 集成使用的零依赖免 shell execFile 运行器，支持 utf8 标准流捕获、中止传播与 Windows 隐藏控制台窗口。"
kind: "package-library"
---

# @deepseek-ai/dsh-native-command

[English](README.md) | 中文

## 概述

`dsh-native-command` 直接运行宿主可执行文件——绝不拼 shell 字符串——并捕获其 utf8 stdout 与 stderr。调用方的中止信号会终止子进程，在 Windows 上瞬时控制台窗口保持隐藏。失败时调用会以错误拒绝，该错误附带退出码与两路已捕获输出，因此调用方无需重跑即可区分工具缺失、取消与真实失败。宿主侧消费方是原生目录选择器与「用默认应用打开」的交接。它是库而非插件：没有 `ctx`、无状态、不发事件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当宿主侧集成需要执行一条原生命令、并需要它的输出或失败信息（或两者兼要）、且绝不能涉及 shell 时，使用本运行器。

### 运行一条命令

```ts
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'

declare const script: string
declare const signal: AbortSignal
const { stdout, stderr } = await runNativeCommand('osascript', ['-e', script], signal)
```

退出码为 0 时，调用解析为捕获到的 stdout 与 stderr。任何失败都会以错误拒绝，错误附带退出 `code` 与两路已捕获输出，因此调用方无需重跑命令即可区分工具缺失（`ENOENT`）、取消（`ABORT_ERR`）与真实的命令失败。

### 注入命令边界

`NativeCommandRunner` 类型是宿主集成的可注入命令边界：在集成需要一个可测试接缝的位置传入该函数（或其包装层），测试即可替换为假运行器。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本运行器是 Node `execFile` 的薄包装，固定三项选择：utf8 编码、中止传播与 Windows 控制台隐藏。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `runNativeCommand` 与 `NativeCommandRunner` 类型——即整个包 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件（无运行时不变式；每次运行都是一次无状态的子进程往返） |

### execFile 给了运行器什么

`execFile` 以 argv 数组直接 spawn 可执行文件——没有 shell 字符串，参数不经 shell 解释。`signal` 选项在调用方中止触发时终止子进程；`windowsHide` 在 Windows 上抑制瞬时控制台窗口。遇到非零退出或 spawn 错误时，回调把 `code`、`stdout`、`stderr` 挂到被拒绝的错误上，并保留原始错误作为 `cause`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你需要消费方或本工具刻意不属于的通用子进程能力时，阅读以下页面。

- [原生目录选择器](../../host/directory-picker-native/README.zh.md)——本运行器执行的 OS 选择器命令。
- [宿主 API 代理](../../host/apiproxy/README.zh.md)——本运行器服务的「用默认应用打开」交接。
- [子进程能力](../../subprocess/subprocess/README.zh.md)——通用子进程 seam，本包并非其组成部分。

-----

<a id="model-experience"></a>
## 模型体验

无：宿主侧子进程运行器不注册任何面向模型的内容。

#### KV Cache 影响

此处没有任何内容进入请求前缀；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本运行器何时不是合适的工具。它们是当前包约束，不是任务积压。

- **不做输出限量**——两路流在内存中无界缓冲；当前每个调用方只运行输出为一个路径或一行错误的小型原生工具。把它指向输出量可观的命令之前，先接入 `dsh-output-retention` 限量。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
