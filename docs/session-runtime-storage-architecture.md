# Session Runtime 存储架构

> 状态：当前实现的权威存储说明。最后核对：2026-09-17。

## 一句话说明

Session Runtime 使用一份由 daemon 独占的 SQLite 数据库。`SessionStore` 负责打开和关闭数据库、组装存储能力以及少量跨域运行协调；业务记录由各领域 Repository 读写，必须一起成功或失败的操作由具名 Transaction 完成。

这里的 Repository 是“某类记录的唯一读写入口”，Transaction 是“把多个入口放进同一次提交”。它们共享同一个数据库和内存 read model，不会因为拆文件而拆散事务。

## 入口与组装

主入口位于 `packages/services/src/session-runtime/store.ts`：

```text
new SessionStore(options)
  -> SessionDatabase.open(path)
  -> loadSessionReadModel(connection)
  -> DurableEventSequence.load(connection, state)
  -> TransactionCoordinator(storage)
  -> 构造各领域 Repository / Transaction
  -> 对 Server 暴露明确的领域属性和系统级能力
```

所有领域入口使用同一个 `StorageContext`。这个上下文只携带数据库连接、当前 read model、待落盘 mutation、事件序号、delta checkpoint、事务入口和 owner 写保护，不依赖 Server、HTTP、Client 或 UI。

## 状态放在哪里

| 状态 | 当前负责人 | 说明 |
| --- | --- | --- |
| SQLite 连接与 schema | `SessionDatabase` | 打开连接、配置 SQLite、应用迁移链（基线 + 增量）、关闭数据库 |
| Session 列表和关系 | `SessionRepository` | 创建、更新、归档、查询和 child 关系 |
| Input、Message、Part、Event | `ConversationRepository` | transcript 与 durable event 的单域读写 |
| Run、Attempt、Session Task | `RunRepository` | Run 生命周期、实际模型尝试和持久任务 |
| Project | `ProjectRepository` | cwd 识别、名称、置顶、shell、归档和路径重绑定 |
| Schedule | `ScheduleRepository` | scheduled task 与 scheduled run |
| Workflow | `WorkflowRepository` | daemon SQLite 内的 workflow snapshot、attempt、event 和 claim |
| Channel | `ChannelRepository` | 外部会话映射和 delivery |
| Permission | `PermissionRepository` | durable permission request 与 decision |
| Goal | `GoalRepository` + `GoalTransactions` | goal 记录及其 request、assessment、continuation、run 联合写入 |
| Attachment | `AttachmentRepository` + `AttachmentTransactions` | asset、representation、lease、引用和 GC 联合写入 |
| prompt/run、fork、delete、replace、recovery | `ConversationTransactions` | Session、Conversation、Run、Permission、Attachment 之间的原子操作 |
| text delta checkpoint | `IncrementalOutput` + `DeltaCheckpoint` | 立即发布 transient delta，按时间或字节阈值批量持久化正文 |

Repository 不开第二个数据库连接，也不自行创建外层事务。它通过收到的 `StorageContext` 读写同一份状态。

## Transaction 怎样保证原子性

`TransactionCoordinator.atomic()` 是最外层事务入口，执行顺序是：

```text
1. 复制 read model、event sequence、delta checkpoint 和 mutation buffer
2. 在 better-sqlite3 transaction 中执行业务操作
3. 将 mutation buffer 写入 SQLite
4. SQLite commit
5. 执行 deferUntilCommit 回调，例如唤醒 waiter 或发布提交后动作
```

任何一步在 commit 前失败，协调器会恢复四份内存快照并丢弃 deferred callback。因此调用方看不到“SQLite 回滚了，但内存已经变了”或“数据没提交，waiter 却被唤醒”的半完成状态。

嵌套 `atomic()` 只增加深度，真正的 SQLite transaction 仍由最外层拥有。Repository 可以组合，但不能偷偷形成相互独立的提交。

当前具名跨域操作包括：

- `ConversationTransactions.admitPromptWithRun()`：Input 与 pending Run 一起建立；
- transcript replace、最新 prompt edit/re-admission；
- session fork 与历史复制；
- session tree 删除及相关引用处理；
- active Run/Task、孤立 Input 和 closing Session 的启动恢复；
- Goal、Attachment 各自需要跨表一致性的操作。

## SessionStore 仍负责什么

`SessionStore` 是存储组合根，不是业务万能对象。它保留的职责分为四组：

1. **数据库生命周期：** 打开、backup、close、连接级配置和当前 schema 检查；
2. **写入所有权：** application owner lease 的 acquire、heartbeat、assert 和 release；
3. **系统维护：** retention、retention audit、projection settlement 和启动恢复入口；
4. **进程内协调：** session task waiter/listener、delta close flush，以及把 Repository/Transaction 装配成同一个一致性单元。

Store 中仍能看到 Workflow、Session Task 或 Projection Settlement 的系统级方法。它们服务于 scheduler、Jobs、event projection、recovery 和 waiter 协议，不意味着新业务应继续添加平铺 `store.<domainAction>()`。普通 Session、Project、Channel、Permission、Goal、Attachment 和 Run 代码必须优先使用对应领域属性。

## Owner lease 与写保护

一个数据库目录同一时刻只能有一个活动 Application owner：

```text
DaemonApplication start
  -> store.acquireApplicationOwner()
  -> generation + heartbeat 写入 SQLite
  -> 每次领域写入调用 storage.assertWritable()
  -> 租约失效后拒绝继续写入
  -> shutdown 时 releaseApplicationOwner()
```

新的 daemon 只有在旧租约过期后才能取得更大的 generation。这个机制防止两个本机进程同时写一份 SQLite，不是用户权限系统。

## 事件、waiter 与提交后的通知

Durable event 的全局 `seq` 由 `DurableEventSequence` 分配。序号可以因预留或崩溃出现空洞，但不会复用客户端已经见过的 cursor。

Session Task 的 wait 由 Store 维护进程内 listener。状态变更先进入 Repository/Transaction，通知通过 `deferUntilCommit()` 排到成功提交之后；回滚不会制造一次虚假的状态变化。

text delta 有两条路径：

- live delta 立即交给当前 SSE 客户端，用于流式显示；
- durable text 按默认时间或字节阈值 checkpoint 到 SQLite，part 完成、Tool 边界、Run terminal 和 Store close 会强制 flush。

## Schema 与启动边界

迁移目录以 0000_current_schema.sql 为基线，其后是 0001+ 增量迁移：

```text
packages/services/src/session-runtime/migrations/0000_current_schema.sql
packages/services/src/session-runtime/migrations/0001_drop_application_storage_format.sql
packages/services/src/session-runtime/migrations/meta/0000_snapshot.json
packages/services/src/session-runtime/migrations/meta/0001_snapshot.json
packages/services/src/session-runtime/migrations/meta/_journal.json
```

迁移目录以 `0000_current_schema.sql` 为基线，其后为增量迁移；journal 与 `.sql` 文件一一对应。启动先按基线快照接管基线前旧库，再无条件应用增量迁移；不做字段猜测或读取时降级。

Daemon 对外 ready 前由 Server 的 recovery service 收束上次进程留下的 active Run、Attempt、Task、Permission、closing Session、Workflow claim 和 Projection Settlement。Services 提供原子存储能力，但不决定 HTTP 错误、Run 排队或是否重新调用模型。

## 新代码放在哪里

新增持久化功能时按顺序判断：

1. 只读写一个业务域的记录：进入该域 Repository；
2. 多张表或多个域必须一起成功：进入具名 Transaction；
3. 只涉及数据库连接、schema、事务协调、owner 或 checkpoint：进入 database/session-runtime 内核；
4. 涉及请求策略、Run 排队、Agent handle 或错误映射：不进入 Services，分别放到 Server Application、Runtime 或 transport；
5. 只有一个调用方且没有独立规则：不要预先增加 interface、manager 或通用 context。

Attachment 当前按层各保留一个领域入口：

- Services：`packages/services/src/attachments/` 是唯一根。`persistence/` 放 SQLite 记录、Repository 和原子事务；`storage/` 放内容寻址 Blob、文件名/媒体类型、完整性检查和存储操作互斥；`processing/` 放 OCR 和图片标准化；`content/` 放不依赖存储的内容分类与文本解码。稳定错误放在该根目录。
- Server：`packages/server/src/application/attachments/attachment-service.ts` 是 daemon 应用用例入口，负责组合事务、Blob Store、限制和存储操作 gate。routing、resources、tools 收在同一根下的子目录。远程图片导入属于 visual tools，不在 Attachment processing。
- Client：`packages/client/src/resources/attachment-resource.ts` 保持远程 Resource。
- Desktop：`apps/desktop/src/main/features/attachment/` 继续负责本机交互；上传生命周期与本地文件操作分别在 `attachment-upload-service.ts` 和 `attachment-file-service.ts`，门面只做委派。

特别禁止：

- 在 HTTP route 里直接写 SQLite；
- 在 Repository 里调用 Agent、SSE 或 UI；
- 为单次 CRUD 增加跨域 Transaction；
- 把新业务重新塞进 `SessionStore` 平铺方法；
- 为旧数据库格式增加读取 fallback。

## 结果从哪里返回

Repository/Transaction 返回已经写入当前 read model 的记录。Server Application 在操作成功后通过 `SessionEventPublisher` 发布 checkpoint 之后的已提交事件；Client 再用 snapshot 与 SSE 合并为界面状态。

完整请求路径见 [Daemon Application Architecture](./daemon-application-architecture.md)，客户端收敛见 [Client Sync Flow](./client-sync-flow.md)，固定记录格式见 [Durable Execution Data Model](./durable-execution-data-model.md)。

## 验证入口

- `packages/services/src/database/transaction-coordinator.test.ts`：提交、回滚和 deferred callback；
- `packages/services/src/*/*-repository.test.ts`：各领域 SQL/read model 行为；
- `packages/services/src/conversations/conversation-transactions.test.ts`：跨域事务与失败回滚；
- `packages/services/src/session-runtime/__test__/store.test.ts`：数据库生命周期、owner、recovery、retention 和系统级能力；
- `packages/services/src/session-runtime/__test__/session-task-waiting.test.ts`：task waiter 不丢唤醒；
- `node scripts/architecture-boundaries.mjs`：依赖方向和旧平铺调用基线；
- `node scripts/verify-clean-slate.mjs`：迁移链完整性（基线 + journal 与文件一致）、协议和禁止兼容面。

## 历史说明

旧的 [Session 存储增强设计](./session-storage-design.md) 描述项目级 JSON snapshot，已经退场，只保留为历史记录。它不是当前 SQLite/Repository 架构的实现依据。
