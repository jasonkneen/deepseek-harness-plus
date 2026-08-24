# examples/：开箱可运行的演示组合包

[English](README.md) | 中文

预先组合的插件组合包，供轻量叶节点 `cordis.yml` 加载，无需手工组装主干。这些是 **演示／参考** 包；npm 名称的 `-demo` 后缀表明每个包都不属于产品对外接口，直接查看包名即可辨认。仓库根目录 [`examples/`](../../examples/AGENTS.md) 下的可运行叶节点是消费方；每个消费方都只包含可替换后端和一个组合包入口。

| 包 | npm 名称 | 角色 |
|---|---|---|
| [`agent-spine-demo/`](agent-spine-demo/README.zh.md) | `@deepseek-ai/dsh-agent-spine-demo` | 可复用的 agent-spine（智能体主干）组合包 |

`agent-spine-demo` 是共享组合包。产品 SDK、ACP 与一次性执行分别由 `dsh --profile sdk`、`dsh --profile acp` 和 `dsh --profile headless` 提供；本目录没有任何包提供应用入口。

这些包不是产品 API。产品 seam 与产品入口仍位于各自的归属组；演示组合包选择具体组合。

不要将此组与仓库根目录的 [`examples/`](../../examples/AGENTS.md) 混淆：该目录存放可运行的 `cordis.yml` **叶节点**；此组存放这些叶节点加载的 **组合包**。
