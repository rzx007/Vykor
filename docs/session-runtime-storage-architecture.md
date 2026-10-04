# Session Runtime 存储架构

> 状态：当前实现的权威存储说明。最后核对：2026-10-04。

## 一句话说明

Session Runtime 在同一个 daemon 中同时支持正式 SQLite 聊天和临时 JS 内存聊天。`SessionStore` 负责组装共享的聊天业务入口、存储实现及事务协调；附件与工作流继续使用现有持久存储并记录来源。必须一起成功或失败的操作由具名 Transaction 完成。

这里的 Repository 是“某类记录的唯一读写入口”，Transaction 是“把多个入口放进同一次提交”。它们共享同一个数据库和内存 read model，不会因为拆文件而拆散事务。

## 入口与组装

主入口位于 `packages/services/src/session-runtime/store.ts`：

```text
new SessionStore(options)
  -> SessionDatabase.open(path)
  -> SqliteChatPersistence.load(eventRegistry)
  -> DurableEventSequence.load(database.orm, state)
  -> TransactionCoordinator(storage)
  -> ChatPersistenceRouter(SQLite + JS memory)
  -> 构造各领域 Repository / Transaction
  -> 对 Server 暴露明确的领域属性和系统级能力
```

所有领域入口使用同一个 `StorageContext`。这个上下文只携带数据库连接、当前 read model、待落盘 mutation、事件序号、delta checkpoint、事务入口和 owner 写保护，不依赖 Server、HTTP、Client 或 UI。

`SessionDatabase.orm` 是在现有 SQLite 连接上创建的 Drizzle 查询入口。日常记录的查询、插入、更新和删除使用 schema 中的命名字段，查询结果由 Drizzle 转为对应的 TypeScript 字段；JSON 内容仍由领域记录转换函数编码和解码。内存状态加载、批量保存、流式正文 checkpoint、owner 和维护记录也使用这个入口。

批量保存、流式正文保存、工作流任务快照和历史事件清理使用 Drizzle 生成的预编译查询：每个批次按记录类型准备一次，循环内绑定命名参数并执行，避免为每条记录重新编译查询。这里的 `.prepare()` 属于 Drizzle 查询构造器，不接收手写 SQL 字符串。

SQLite 连接配置、备份与外层同步事务继续由现有连接负责，因此共享持久资源和正式聊天写入参与同一事务。聊天记录通过 `ChatPersistence` 的加载、提交、checkpoint 和删除接口选择具体实现；业务 Repository 继续共用内存读模型。SQL 迁移文件继续由 Drizzle Kit 管理。

创建会话或 fork 时传 `storage: "memory"` 可选择临时聊天，缺省为 SQLite；子会话继承归属，创建后不能切换。侧边聊天明确选择 memory，其目标关联只存当前 renderer 的 Map。临时会话、输入与附件引用、消息/工具结果、Run/Attempt/Task、权限、事件及控制记录不写进 SQLite，重启后消失。正式上下文沿现有 fork 历史复制及 conversation 只读引用提供，临时分支写入自己的记录。审批只在相同存储归属的父子会话间上溯。

附件来源保存在 `attachment_asset.chat_sources_json`，工作流来源保存在 `workflow_run.origin_json`。临时来源附件作为持久资源保留，不随临时聊天删除或因聊天重启消失被当作无引用垃圾回收；本阶段没有增加过期策略。工作流不把临时 session/input/run ID 写入 SQLite 外键列，真实 owner 信息在来源和原快照中保留。重启后已消失的临时会话不再接收工作流聊天事件，工作流自身事件仍持久化。

长期记忆库共用。临时会话跳过自动 personalization、会话记忆 checkpoint、自动 remember 和 autoDream，明确的记住操作仍可保存。普通工具按现有权限操作项目文件；聊天使用内存不代表整个应用不落盘。

当前两个实现使用同步提交；同步入口会拒绝 Promise 返回值，回滚并阻止提交后通知。未来异步数据库需增加等待提交的事务入口，同时调整 admission、projection 和通知调用者；缓存查询可以保持同步，不把后台异步写入当作已经成功。

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
| text delta checkpoint | `IncrementalOutput` + `DeltaCheckpoint` | 临时正文立即写入 JS 存储；正式正文按时间或字节阈值批量持久化 |

Repository 不开第二个数据库连接，也不自行创建外层事务。它通过收到的 `StorageContext` 读写同一份状态。

## Transaction 怎样保证原子性

`TransactionCoordinator.atomic()` 是最外层事务入口，执行顺序是：

```text
1. 复制 read model、临时聊天存储、临时控制记录、event sequence、delta checkpoint 和 mutation buffer
2. 在 better-sqlite3 transaction 中执行业务操作
3. 按归属将 mutation buffer 写入 SQLite 或 JS 存储
4. SQLite commit
5. 执行 deferUntilCommit 回调，例如唤醒 waiter 或发布提交后动作
```

任何一步在 commit 前失败，协调器会恢复上述内存快照并丢弃 deferred callback。因此调用方看不到“SQLite 回滚了，但内存已经变了”或“数据没提交，waiter 却被唤醒”的半完成状态。

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

所有对客户端发布的事件共用 `DurableEventSequence` 分配全局 `seq`。SQLite 只保留序号预留上限等共享元数据，不保存临时聊天的事件记录或内容；这样即使临时事件超过一个预留块，重启也不会让正式聊天的 cursor 回退。序号可以因预留或崩溃出现空洞。

Session Task 的 wait 由 Store 维护进程内 listener。状态变更先进入 Repository/Transaction，通知通过 `deferUntilCommit()` 排到成功提交之后；回滚不会制造一次虚假的状态变化。

text delta 有两条路径：

- live delta 立即交给当前 SSE 客户端，用于流式显示；
- durable text 按默认时间或字节阈值 checkpoint 到 SQLite，part 完成、Tool 边界、Run terminal 和 Store close 会强制 flush。
- 临时正文每次增量立即 checkpoint 到 JS 存储，不等待 SQLite 批量写入计时器；无关正式聊天保存失败后的状态重载保留已接受的临时正文，失败事务内部的增量仍一起回滚。

## Schema 与启动边界

迁移目录以 0000_current_schema.sql 为基线，其后是 0001+ 增量迁移：

```text
packages/services/src/session-runtime/migrations/0000_current_schema.sql
packages/services/src/session-runtime/migrations/0001_drop_application_storage_format.sql
packages/services/src/session-runtime/migrations/0002_temporary_resource_sources.sql
packages/services/src/session-runtime/migrations/meta/0000_snapshot.json
packages/services/src/session-runtime/migrations/meta/0001_snapshot.json
packages/services/src/session-runtime/migrations/meta/0002_snapshot.json
packages/services/src/session-runtime/migrations/meta/_journal.json
```

迁移目录以 `0000_current_schema.sql` 为基线，其后为增量迁移；journal 与 `.sql` 文件一一对应。每次打开都应用迁移链；不做旧库接管或字段猜测，与当前基线不匹配的库删除重建。

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
