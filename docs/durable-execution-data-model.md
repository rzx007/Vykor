# Durable Execution Data Model

> 状态：当前持久化运行记录的权威契约。最后核对：2026-08-23。

本文集中回答一件事：OpenHarness 把一次运行保存成哪些记录，这些记录怎样关联，什么时候算真正结束。

## 总关系

```text
Session
  ├─ Input
  │    └─ Run
  │         ├─ Run Attempt
  │         ├─ Message ─ Part（文本、推理、Tool、结果、错误）
  │         ├─ Permission
  │         ├─ Session Execution（child、shell、dream 等长期工作）
  │         └─ Workflow Run ─ Task Attempt
  ├─ Durable Event
  └─ Projection Settlement（投影没写完时的修复单）
```

SQLite 是 daemon 的业务真相。客户端快照和 SSE 都从这些记录产生；live Agent history 和 Handle 不写进数据库。

## 固定记录

下表列的是稳定责任，不代替 TypeScript 的逐字段定义。精确字段以 `packages/protocol/src/session.ts` 和 migrations 为准。

| 记录 | 主键与关系 | 必须保存的内容 | 终态或删除规则 |
|---|---|---|---|
| Session | `id`；可有 `parentId` | cwd、title、model、status、metadata、创建/更新时间 | `archived` 不再接收新工作 |
| Input | `id`；属于 Session；Session 内有 `seq` | delivery、content、metadata、创建时间 | 写入后不改正文；相同 ID 重试必须内容相同 |
| Run | `id`；属于 Session，可指向 Input | status、时间、error、metadata | `completed/failed/interrupted` 不可回到 running |
| Run Attempt | `id`；属于 Run；Run 内有 `sequence` | provider、model、状态、错误分类、token、起止时间 | `completed/failed/cancelled` 不可逆 |
| Message | `id`；属于 Session，可指向 Run/Input | role、Session 内 `seq`、metadata、时间 | 消息本身是容器，内容在 Part |
| Message Part | `id`；属于 Message 和 Session | type、status、text/tool input/output、时间 | `completed/failed/interrupted` 不可回到活动态 |
| Permission | `id`；属于 Session，可指向 Run | toolName、payload、status、decision、决定者 | `approved/denied/expired` 不可重新 pending |
| Session Execution | `id`；属于 Session，可指向 child Session/Run | type、description、cwd、status、output/error | `completed/failed/stopped/interrupted` 不可逆 |
| Durable Event | `id` 和全局 `seq`；可属于 Session | type、`schemaVersion`、payload、创建时间 | 只追加，不覆盖；未知版本拒绝读取 |
| Projection Settlement | `id`；关联 root Session 和事件序号 | projector、action、payload、重试数、错误 | `resolved/abandoned` 结束；pending 必须可跨重启检查 |
| Workflow Run | `run_id`；可指向 owner Session/Input/Run | status、termination、完整 snapshot、时间 | 终态不可恢复为 running |
| Workflow Task Attempt | Workflow + task + attempt 联合主键 | status、payload、起止时间 | 每次 retry 新建 attempt，不覆盖旧 attempt |
| Workflow Event | 自增 `seq`；属于 Workflow | type、完整 event、创建时间 | 只追加 |

## 状态规则

当前公共状态枚举：

```text
Session: idle | running | closing | archived | error
Run: pending | running | completed | failed | interrupted
Run Attempt: pending | running | completed | failed | cancelled
Session Execution: pending | running | completed | failed | stopped | interrupted
Permission: pending | approved | denied | expired
Message Part: pending | running | completed | failed | interrupted
Settlement: pending | retrying | resolved | abandoned
```

共同规则只有两条：

1. 一条活动记录一旦进入终态，迟到事件不能把它改回活动态。
2. Runtime 返回成功不等于 durable Run 已成功；需要的投影全部提交后，Run 才能完成。

更完整的转移和失败表见 [Agent Lifecycle Contract](./agent-lifecycle-contract.md)。

## ID 和安全重试

服务端生成 Session、Run、Attempt、消息和内部事件 ID。外部调用方可以为 Input 提供稳定 ID，用来处理网络重试或平台重复投递。

```text
同一个 ID + 同一份不可变内容 -> 返回原记录
同一个 ID + 不同内容         -> 409 / 明确冲突
```

Input 校验不把 `traceId` 当业务内容，因为一次网络重试可能得到新的 trace；正文、Session、delivery 和其他 metadata 必须一致。Bot 的稳定 Input ID 来自 connector、accountId 和平台 message ID。

## 哪些写入必须一起成功

以下操作不能只成功一半：

- 接收 prompt：Input 和 pending Run；
- 开始/结束 Run：Run、Attempt、Session 状态和对应事件；
- transcript 更新：Message、Part、Run 关系和 durable event；
- child 结束：child task、child Run、child Session 和 settlement 状态；
- retention：实际删除和 retention audit；
- Workflow snapshot、task attempt、event 和 execution claim 的关键更新。

`SessionStore.transaction()` 同时提交 SQLite 和内存 read model。失败时两边都回滚。文本 delta 是例外：它先通过 live SSE 显示，再按时间或大小 checkpoint；Tool 边界、Run 终态和 store close 会强制落盘。

## 版本规则：当前格式与迁移链

本项目在每次打开时应用迁移链（基线 + 增量）；不做旧库接管、字段猜测或跨世代数据转换。与当前基线不匹配的库删除重建。

| 数据 | 当前标记 | 行为 |
|---|---|---|
| daemon SQLite | `__drizzle_migrations` 水位线 | 每次打开应用迁移链；水位线早于基线的库会失败，需删除重建 |
| Durable Event | `schemaVersion = 1` | registry 只接受当前版本，不在读取时升级 |
| 项目会话快照 | `schema_version = 1` | 缺失或不同版本直接失败 |
| Memory Markdown | frontmatter `schema_version: 1` | 缺字段、类型错误、文件名与 ID 不同都失败 |
| Swarm team/permission | `schema_version: 1` | 不接受旧字段名或缺失标记 |
| Swarm mailbox | `schemaVersion: 1` | 读取、标记已读时都严格检查 |
| settings | `_formatVersion: 1` | 缺失、不同版本或旧字段直接失败 |
| Agent 定义 | YAML frontmatter 当前 camelCase 字段 | YAML 无效直接失败，不回退到逐行猜测 |

数据库 migrations 建立新库并对已存在库应用增量迁移。不做旧库接管、字段猜测、别名或读取时降级。

## 重启后怎样处理活动记录

重启不会复活旧进程，也不会再次执行原 Tool。Application 在 ready 前：

1. 先处理 pending Projection Settlement。
2. 把失去进程的 running Attempt 收束为 cancelled。
3. 把对应 Run、Execution、Permission 和 Workflow 收束到明确结果。
4. 孤立 Input 会得到一条 terminal interrupted owner Run，留下原因，但不自动调用模型。

人工要重新执行时，创建新的 Input 和 Run，并在 metadata 里记录来源。旧 Run 仍保留原终态。

## 快照与事件

客户端 attach 单个 Session 时先拿原子快照：

```text
cursor + session + inputs + messages + parts + runs + attempts + tasks + permissions
```

随后从同一个 cursor 接 SSE。durable event 使用全局递增 `seq` 去重；live 文本 delta 也有 cursor，但不写进 durable event 表。重启可能在 cursor 中留下空洞，已用过的数字绝不复用。

## 代码与测试入口

| 内容 | 位置 |
|---|---|
| 公共记录类型 | `packages/protocol/src/session.ts` |
| SQLite schema 和 migration | `packages/services/src/session-runtime/migrations` |
| Store 写入与状态转移 | `packages/services/src/session-runtime/store.ts` |
| Durable event registry | `packages/services/src/session-runtime/event-registry.ts` |
| Agent 事件投影 | `packages/server/src/application/agent/daemon-agent-event-projector.ts` |
| 投影恢复 | `packages/server/src/application/agent/projection-settlement-recovery.ts` |
| Store 契约测试 | `packages/services/src/session-runtime/__test__/store.test.ts` |
| 完整生命周期契约 | [Agent Lifecycle Contract](./agent-lifecycle-contract.md) |
