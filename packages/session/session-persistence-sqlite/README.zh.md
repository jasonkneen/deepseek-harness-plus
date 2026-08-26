---
description: "面向部署方与维护者的 SQLite 会话持久化说明，用于选择、配置或排查这个可选启用的分片行后端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-sqlite

[English](README.md) | 中文

## 概述

`dsh-session-persistence-sqlite` 是 `SessionPersistence` 服务的可选存储后端：它不按会话各留一个文件，而是把所有会话的持久事件日志统一保存在同一个 SQLite 数据库中。它与 JSONL 后端提供完全相同的逻辑 `SessionEvent` 流，因此选择它不会改变 agent loop、模型或回放的任何行为——打包、压缩与恢复都是存储内部细节。仅当单一可查询数据库适合你的部署时才选择它；任何已发布的组合都不会默认启用它。这是预发布提供方：它拒绝而非迁移不属于自己的数据库文件，而且其同步 Node SQLite 驱动会在读写时阻塞 JavaScript 线程。设置、容量评估与迁移指引在前；实现内部细节放在下方可折叠的开发者章节中。

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

当组合需要由 SQLite 支撑的持久会话、且可以接受进程本地的同步数据库驱动时，挂载此提供方。常用路径是显式的：加载会话服务、挂载提供方，然后给出数据库路径。

### 何时选择

当本地部署受益于一个可查询数据库、而非每会话一个独立文件时，选择此后端。当消费方需要按会话产物时，请选择 JSONL 后端：本提供方的 `locate(meta)` 返回 `undefined`，不支持原始产物，也不暴露任何单会话文件。高并发服务在采用前还应考虑同步 SQLite 与压缩工作。

### 磁盘占用与性能

打包布局以磁盘空间换取速度与结构。现有基准测量 schema 17，该打包前身使用相同的分片 codec，但行判别值不同；schema 18 尚未重新测量。在该语料上——105 个会话、约 250 万个事件——SQLite 数据库占用 75 MB，而默认压缩 JSONL 日志为 31 MB：磁盘占用约为后者的 2.5 倍。

同一组测量显示，写入快约 3 倍，50 个事件的后缀读取快约 40 倍，完整会话读取相当或略快，约 250 万个物理行缩减到约 6.6 万个。按会话内容不同，磁盘占用约为压缩 JSONL 的 2–3 倍；完整数据与方法见 [SQLite 物理分片行决策](../../../.agents/notes/implemented/architecture/2026-08-18-sqlite-physical-chunk-row-compression.zh.md)。

磁盘成本换来的是结构化、可查询的会话历史视图：外部工具可以用 SQL 分析 `sessions` 与 `events`，按本提供方的方式解码物理行——这是内置全文搜索等功能的天然基础。

### 最小配置

先加载会话服务，再用数据库路径挂载提供方。除非位置允许依赖进程工作目录（相对路径从该目录解析），否则请使用绝对路径。`:memory:` 可用于进程内数据库，其内容随进程消失。

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-persistence-sqlite'
  config:
    path: /absolute/path/to/sessions.db
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | 必填 | SQLite 数据库路径，或 `:memory:` |
| `journalMode` | `wal` | 持久 journal mode：`wal`、`delete`、`truncate` 或 `persist` |
| `busyTimeoutMs` | `5,000` | 等待另一连接锁的最长同步时间 |
| `preparedSessionCacheSize` | `5` | 为恢复复用而保留的冷会话准备结果数量 |
| `writeBatchMaxDelayMs` | `200` | 实时事件的固定聚合窗口，单位为毫秒 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-persistence-sqlite)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 迁移现有 JSONL 会话

没有内置迁移工具：JSONL 与 SQLite 是两个独立存储，没有任何机制在两者之间复制会话。由于两个后端实现相同的逻辑约定，你可以直接用持久化 API 迁移会话——在 JSONL 侧读取，在 SQLite 侧写入。每个组合只有一个后端服务于 `ctx.sessionPersistence`，因此两步请分两次运行或分两个进程执行：

```text
// Export — run against the JSONL composition, per session id:
const { meta, events } = await ctx.sessionPersistence.load(id)

// Import — run against the SQLite composition, per exported session:
await ctx.sessionPersistence.create(meta)
await ctx.sessionPersistence.append(id, events)
```

用 `list()` 枚举已物化的会话。导出的事件 `seq` 从 0 开始连续，因此 `append` 可以一次性按序写入新会话；`load` 会先在源端提交所需的冷修复，导出的日志因此是平衡的。请把迁移当作一次性切换：确认导入的会话可以加载后，再把组合切换到 SQLite 提供方；之后继续写旧 JSONL 根目录会让两个存储分叉。

### 启动与安全运行

全新数据库直接初始化为 schema 版本 18。任何其他版本、外来应用标识、无版本的非全新 schema 或意外 schema 对象，都会在任何数据暴露或变更之前被拒绝——本预发布提供方不提供迁移。每条语句和固定 pragma 都来自 `resources/sql/` 下打包的 `.sql` 资源，运行时的值以 SQLite 参数绑定，包代码从不拼装查询文本。

每个连接都会禁用 SQLite trusted schema 与内存映射 I/O、验证所请求的 journal mode，并固定 `synchronous=FULL`，保证成功返回的追加在操作系统崩溃或断电后依然持久。在 POSIX 上，数据库父目录和文件必须属于当前用户，父目录不得允许组或其他用户写入，文件也不得授予任何组或其他用户权限；Windows 还会拒绝符号链接和非普通文件，ACL 限制则由部署方负责。路径与所有权失败会拒绝插件初始化；Node 的 SQLite 驱动在首次持久化操作时才延迟加载。普通 `create` 会保持惰性直到首次 append，而 `ensureMaterialized` 会写入一条没有事件行的会话元数据记录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本提供方建立在一个分离与三项承诺之上：

- **逻辑约定，物理格式。** 调用方始终读写普通的 `SessionEvent[]`；行如何打包、存储与压缩是本包私有的存储行为。
- **schema 拥有格式。** Schema 18 是冻结的物理约定：任何其他版本、外来标识或意外 schema 对象的数据库都会被拒绝，绝不迁移。改变物理规则需要新的 schema。
- **持久性是默认值。** 追加在立即事务中以 `synchronous=FULL` 提交，成功返回的 `append()` 意味着该批次已持久。普通追加仅插入：更早的事件行永远不会被重写。
- **在严格边界内追求效率。** 打包与压缩让数据库保持小巧，但每个上限都是硬性格式边界——每个打包行至多表示 1,024 个事件、1 MiB 载荷。

决策历史——备选方案、测量数据与后果——记录在 [SQLite 物理分片行决策](../../../.agents/notes/implemented/architecture/2026-08-18-sqlite-physical-chunk-row-compression.zh.md) 中。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、服务注册、协调器接线 |
| [`src/store.ts`](src/store.ts) | 存储原语：事务追加、读取、修复、路径与所有权验证 |
| [`src/schema.ts`](src/schema.ts) | schema 归属：版本门禁、连接加固、行解码 |
| [`src/codec.ts`](src/codec.ts) | 打包：哪些 `assistant/chunk` 连续段成为打包行、大小上限 |
| [`src/compression.ts`](src/compression.ts) | 物理编码：压缩阈值、序列列表、行扫描与解码 |
| [`src/sql.ts`](src/sql.ts) + [`resources/sql/`](resources/sql/) | 所有 SQL 语句均为打包的闭名资源 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件（无运行时不变式；打包只能通过数据库往返观察） |

### 数据库 schema

全新数据库包含三张 STRICT 表，定义于 [`resources/sql/schema.sql`](resources/sql/schema.sql)：

| 表 | 用途 |
|---|---|
| `persistence_state` | 单行存储标识 |
| `sessions` | 每个会话一行：头部字段加单调递增的 revision |
| `events` | 物理事件行：一个逻辑事件，或一个打包连续段 |

确切的列定义见 [`resources/sql/schema.sql`](resources/sql/schema.sql)。`events.data` 列存放文本或 blob：小载荷保持为文本，较大的载荷在压缩后更小时以压缩形式存储。标量逻辑事件的 `events.is_packed` 为 `0`，打包分片连续段的该值为 `1`，因此类型与物理分片标签同名的标量事件仍然明确。打包行沿用其首个逻辑事件的 `seq`，因此在复合主键 `(session_id, seq)` 下，物理顺序就是逻辑顺序。

### 写入路径

每次追加都会开启立即事务、重新验证 schema 归属、检查已存尾部以防止陈旧写入方扩展日志、只打包新批次、插入对应行、递增一次会话 revision，然后提交。协调器按配置窗口聚合实时事件，因此高频流会产生更大的打包行，而物理写入量始终与新持久批次成正比。

### 读取与恢复

完整读取先反向定位最后一个有效 `turn/end`，再按正向顺序把每个物理行解码为其逻辑事件，并拒绝已提交前缀中的缺口或格式错误行。格式错误的最后一行被视为撕裂尾部：执行恢复的加载可以在写锁下删除它，并用合成闭合事件关闭日志。后缀读取（`readFrom`）只检查可能包含目标序列的物理跨度，因此永远不会解析无关的更早行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享持久化模型逐步进入穷尽式配置，以及物理布局背后的决策证据。

- [会话持久化子系统](../../../docs/subsystems/persistence.zh.md)——后端无关的服务语义与提供方关系。
- [会话包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-persistence-sqlite)——每个受支持配置字段及其源声明。
- [SQLite 物理分片行决策](../../../.agents/notes/implemented/architecture/2026-08-18-sqlite-physical-chunk-row-compression.zh.md)——打包布局背后的理由、备选方案与测量。

-----

<a id="model-experience"></a>
## 模型体验

### 恢复的对话历史

#### 模型看到什么

没有 SQLite 专有内容。恢复会还原与 JSONL 后端相同的逻辑事件和派生消息；物理打包标签永远不会进入提示词、工具、回放或实时 `session/event` 投递。

#### Token 影响

实时请求 token 为零。恢复只为保留的逻辑历史和当前请求信封消耗 token。

#### KV Cache 影响

物理打包不会改变请求前缀。提供方缓存复用取决于重建历史、当前信封与模型路由，与其他持久化后端完全相同。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本提供方何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用 SQLite 对比或任务积压。

- **预发布设计，无迁移**——schema 18 是临时的 SQLite 专用设计；被推迟的统一多后端、可配置 schema 关系型设计已有可运行的外部原型 [morlay/session-persistence-rdb](https://github.com/morlay/session-persistence-rdb)（基于 Drizzle，支持 SQLite 与 PostgreSQL），预发布期间不保证 schema 稳定性或迁移支持。
- **打包依赖批次边界**——被写后窗口或显式 flush 拆开的兼容连续段仍分属不同物理行；这避免了重写先前行，代价是打包比例依赖时序。
- **同步 SQLite 与压缩**——Node 的 SQLite 驱动与 Zstandard 调用会阻塞 JavaScript 线程；4 KiB 压缩阈值限制了小记录的单帧工作量。
- **忙等待阻塞事件循环**——SQLite 在同步调用内部等待；竞争写入方最长可让线程停顿配置的 `busyTimeoutMs`。
- **外部 SQL 读取方必须解码物理行**——打包的 `events.type`（`text-chunks`、`reasoning-chunks`、`tool-call-chunks`）不是逻辑事件类型；受支持的消费方通过本提供方读取。
- **没有删除或历史压缩**——普通追加仅插入，没有任何机制移除旧行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：测量产物、开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准，结论一旦稳定就迁移到对应归属。

#### 基准产物

以下数字是冻结的 schema 17 基准。Schema 18 改变了行判别值，尚未重新测量；[SQLite 物理分片行决策](../../../.agents/notes/implemented/architecture/2026-08-18-sqlite-physical-chunk-row-compression.zh.md) 是权威记录，本表只是带注的摘要。

| 指标 | **JSONL（zstd）** | **SQLite（legacy）** | **SQLite（new）** |
|---|---|---|---|
| 磁盘占用 | **30.65 MB** | 709.57 MB | 75.01 MB |
| 105 个会话的写入时间 | 28.21 s | 10.64 s | **8.58 s** |
| 完整会话读取 p50 / p95 | 4.49 / 23.36 ms | 9.02 / 69.16 ms | **3.95 / 21.58 ms** |
| 50 个事件尾部读取 p50 / p95 | 10.58 / 80.90 ms | **0.189 / 0.293 ms** | 0.253 / 0.378 ms |
| 事件行数 | 2,507,860（逻辑） | 2,507,860 | **65,810** |
| 全部会话 fork | 14.48 s | 19.30 s | **13.10 s** |

语料为 105 个会话、2,507,860 个逻辑事件，按 512 个事件一批追加，因此具体比例取决于会话内容、流密度与批次边界。`SQLite（legacy）` 是标量布局——每个逻辑事件一行、不打包——其 709.57 MB 的占用正是打包行的动机。在已测量的 schema 17 布局中，SQLite 磁盘占用约为 JSONL 的 2.5 倍，但写入快约 3.3 倍，完整会话读取在两个分位上都更快，50 个事件尾部读取快约 40 倍；相对标量布局，它缩小约 89%、写入更快，并把 2,507,860 行缩减到 65,810 行，只有标量尾部读取仍略快（0.189 对 0.253 ms p50）。写入路径或 schema 变化时，请重跑或扩展该基准。

#### 未来：多后端 RDB 持久化（Drizzle）

统一的多后端关系型设计仍被推迟。若以 Drizzle 实现，需要解决：schema 归属——逐版本冻结与精确对象校验的意义在于任何组合都能读取同版本数据库，可定制 schema 必须同样带版本并接受同样校验；后端加固——`synchronous=FULL`、busy timeout 与所有权检查都是 SQLite 专属，Postgres 或 MySQL 后端需要各自的持久性与权限方案；codec 可移植性——打包 codec 围绕 SQLite 列设计，无论跨方言共享 codec 还是按 schema 版本固定每后端 codec，都必须保持逻辑约定完全一致。

#### 未来：持久化到持久化的迁移与版本升级

README 记录了手动的 `load` → `create`/`append` 迁移，但 seam 没有导入/导出 API，SQLite 也直接拒绝其他 schema 版本。自动化迁移需要：能保留头部血缘（`seedLength`、`parentSession`、`agentPreset`）与 revision 语义的导出格式；格式与 schema 版本的升级链，即[事件词汇表显式拒绝笔记](../../../.agents/notes/implemented/simplification/2026-08-25-fail-closed-session-event-vocabulary.zh.md)中推迟的升级链；以及导出前源日志可读且平衡的保证——`load` 已先提交冷修复。

#### 未来：库内全文搜索与索引改进

兄弟包 [session-query-sqlite](../../session-query/session-query-sqlite/README.zh.md) 已经在独立派生索引数据库中维护一份会话内容的 SQLite FTS5 搜索索引。把 FTS 放进持久化数据库会重复该表面；开放问题包括索引归属、如何与追加保持事务一致，以及打包行应展开成索引文档还是索引直接读取逻辑流。持久化 schema 目前只索引 `(session_id, seq)`；额外索引（例如 `sessions.created_at` 用于冷数据截止扫描）实现简单，但会增加写入成本。

#### 未来：冷数据卸载到级联数据库文件

本提供方没有删除或后台压缩：所有数据永远留在同一个数据库里。一个方向是把冷会话（例如超过 30 天）卸载到按级联组织的独立归档数据库文件，并对冷文件使用更激进的压缩——对冷数据而言，更高的 Zstandard 级别代价很低。这需要：知道哪个文件存放哪个会话的路由规则、`list`/`readFrom`/`load` 的跨文件扇出、级联间一致的 revision 与存储标识，以及卸载是取代还是补充「无删除」限制的决定。

</details>
