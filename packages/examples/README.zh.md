# examples/：可复用组合包

[English](README.md) | 中文

预先组合的插件组合包，供需要具体 Agent 主干、但不应手工组装它的测试与自定义部署使用。npm 名称的 `-demo` 后缀表明每个包都是支撑基础设施，而非产品接口。

| 包 | npm 名称 | 角色 |
|---|---|---|
| [`agent-spine-demo/`](agent-spine-demo/README.zh.md) | `@deepseek-ai/dsh-agent-spine-demo` | 可复用的 agent-spine（智能体主干）组合包 |

`agent-spine-demo` 是共享组合包。产品 SDK、ACP 与一次性执行分别由 `dsh --profile sdk`／`dsh --profile sdk-minimal`、`dsh --profile acp` 和 `dsh --profile headless` 提供；本目录没有任何包提供应用入口。

这些包不是产品 API。产品 seam 与产品入口仍位于各自的归属组；支撑组合包为聚焦消费方选择具体组合。
