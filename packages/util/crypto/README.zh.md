# dsh-util-crypto

[English](README.md) | 中文

零依赖的 v4 UUID 铸造，基于 `crypto.getRandomValues`——所有发布上下文都提供的那个随机原语。`crypto.randomUUID` 是安全上下文限定的 Web API：经普通 HTTP 在局域网地址上提供的页面或 worker（浏览器预览部署）根本没有这个方法，必须在那里运行的代码不能调它。全仓 `no-restricted-properties` lint 规则把 `crypto.randomUUID` 的调用者指到这里；只跑在 Node 的代码从 `node:crypto` 导入 `randomUUID` 维持原样。

它是**库，不是服务也不是插件**：无 `ctx`、不注册任何东西、不持有状态。

## API

```ts
import { randomUUID, type Uuid } from '@deepseek-ai/dsh-util-crypto'
```

| 导出 | 角色 |
|---|---|
| `randomUUID()` | 随机 RFC 9562 v4 UUID 字符串，由 `crypto.getRandomValues` 铸造。可原位替换 `crypto.randomUUID()`。 |
| `Uuid` | 五段式 UUID 字符串类型，与 `crypto.randomUUID` 声明的返回形状一致。 |

## Model Experience

间接地，经由用它铸造请求、会话与附件标识符的消费方，这些标识符均不作为语义内容进入提示词。

#### KV Cache effect

无直接失效；铸造标识符的消费方自行负责其请求变化。

## Known Limitations and Deferred Work

- **仅 v4**——不提供其他 UUID 版本、命名空间或解析；需要更多能力的消费方应引入真正的 UUID 依赖。
- **唯一性是概率性的**——122 位随机，与 `crypto.randomUUID` 同级保证；此处不做碰撞检测。
