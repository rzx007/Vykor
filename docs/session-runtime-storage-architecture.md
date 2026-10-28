# Session Runtime 存储架构

> 状态：当前实现的权威存储说明。最后核对：2026-10-22。

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

侧边入口指定 `copyHistory: false`，只继承来源会话的工作目录、模型和运行设置，不复制主聊天消息；发送时的 conversation 引用仍提供只读上下文。普通 fork 默认复制历史。用户主动关闭侧边 tab（包括批量关闭）时先确认，再通过现有删除入口停止运行、删除临时会话及子会话，并清除本地草稿和缓存；删除失败保留 tab 供重试。收起面板、切换标签或主聊天不销毁会话。

附件来源保存在 `attachment_asset.chat_sources_json`，工作流来源保存在 `workflow_run.origin_json`。临时来源附件作为持久资源保留，不随临时聊天删除或因聊天重启消失被当作无引用垃圾回收；本阶段没有增加过期策略。工作流不把临时 session/input/run ID 写入 SQLite 外键列，真实 owner 信息在来源和原快照中保留。重启后已消失的临时会话不再接收工作流聊天事件，工作流自身事件仍持久化。

长期记忆库共用。临时会话跳过自动 personalization、会话记忆 checkpoint、自动 remember 和 autoDream，明确的记住操作仍可保存。普通工具按现有权限操作项目文件；聊天使用内存不代表整个应用不落盘。

当前两个实现使用同步提交；同步入口会拒绝 Promise 返回值，回滚并阻止提交后通知。未来异步数据库需增加等待提交的事务入口，同时调整 admission、projection 和通知调用者；缓存查询可以保持同步，不把后台异步写入当作已经成功。

## 记录与写入命令

Session、Input、Run、Goal、Attachment 等记录及其纯数据规则来自 `domain-contracts` 对应业务子入口。该包没有汇总所有记录的根入口，不持有 Repository、事务、配置加载或文件 I/O。Services 不依赖 Protocol。

Services 在 sessions、conversations、runs、permissions、schedules、notes 和 session-runtime 等模块用自己的 `commands.ts` 定义写入输入，查询条件也在所属存储模块定义。Application 将业务意图转换成这些命令，Repository/Transaction 再按自身不变量验证和写入；HTTP 字段、状态码和分页响应不成为存储契约。

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

- Services：`packages/services/src/attachments/` 是唯一根。`attachment-policy.ts` 是 `DEFAULT_ATTACHMENT_LIMITS` 的单一来源，独立 Services 可以直接使用，Server 引用同一默认值；domain-contracts 只定义限额形状和校验。`persistence/` 放 SQLite 记录、Repository 和原子事务；`storage/` 放内容寻址 Blob、文件名/媒体类型、完整性检查和存储操作互斥；`processing/` 放 OCR 和图片标准化；`content/` 放不依赖存储的内容分类与文本解码。稳定错误放在该根目录。
- Server：`packages/server/src/application/attachments/attachment-service.ts` 是 daemon 应用用例入口，负责组合事务、Blob Store、限制和存储操作 gate。routing、resources、tools 收在同一根下的子目录。远程图片导入属于 visual tools，不在 Attachment processing。
- Client：`packages/client/src/resources/session/attachment-resource.ts` 保持远程 Resource。
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

- `packages/services/src/database/transactions/__test__/transaction-coordinator.test.ts`：提交、回滚和 deferred callback；
- `packages/services/src/*/*-repository.test.ts`：各领域 SQL/read model 行为；
- `packages/services/src/conversations/__test__/conversation-transactions.test.ts`：跨域事务与失败回滚；
- `packages/services/src/session-runtime/__test__/store.test.ts`：数据库生命周期、owner、recovery、retention 和系统级能力；
- `packages/services/src/session-runtime/__test__/session-task-waiting.test.ts`：task waiter 不丢唤醒；
- `node scripts/architecture-boundaries.mjs`：依赖方向和旧平铺调用基线；
- `node scripts/verify-clean-slate.mjs`：迁移链完整性（基线 + journal 与文件一致）、协议和禁止兼容面。

## 历史说明

旧的 [Session 存储增强设计](./session-storage-design.md) 描述项目级 JSON snapshot，已经退场，只保留为历史记录。它不是当前 SQLite/Repository 架构的实现依据。

## 存储与执行的依赖边界

`database`、各记录域和 `session-runtime` 只持有存储、自有命令和明确的领域数据，不引用 Protocol 的 HTTP DTO。它们不能反向调用 Core、execution-node、Sandbox、Agent、PTY 或 Office/Memory 辅助服务；`scripts/architecture-policy.json` 通过导入图验证。附件图片/OCR 处理保留既有专用实现，不参与 Agent/PTY 组装。

本地执行与 LSP 已归 `@vykor/execution-node`。Server 持有应用级 ExecutionRuntimeOwner 并在关闭时回收；Node/工具通过明确接口借用，不再从 services 入口发现执行宿主。Office 转换保留自己的 `OfficeDocumentPreview` 数据，不依赖 Protocol 的预览响应。Goal 的持久事务仍归 services，准入和结算编排在 Server GoalModelAttemptService；事件投影不能再写 Goal 用量。

## 历史增长基准与有界加载评估（2026-10-27）

2026-10-27 的复查保留当时基准，**未保留有界加载优化**。2026-10-28 删除 S1 后，当前加载器一次读取 tool_result 与 session_message_part；基准脚本同步改为这两张表，下列旧数值不适用于新 schema。

下列 baseline/candidate 表格转录自 `31072ee8` 的实施记录，属于历史报告数值，不能代替原始 JSON。原记录描述的候选为 256 行 rowid 键集批次及一致读事务；本轮在明确检索范围内未恢复候选补丁、原始样本或验证日志，记录的脚本 SHA 也与现存脚本不符。因此，回滚和表内算术可以核实，候选的实际性能、256 行上限及完整执行过程尚不能独立复核。检索范围、源码身份及本轮原始样本见[证据复查记录](./superpowers/reviews/2026-10-27-n4-evidence-audit.md)。

入口为 `packages/services/src/database/persistence/__test__/storage-growth.bench.mjs`。从仓库根运行：

```powershell
pnpm --filter @vykor/services exec node --expose-gc --import ../../apps/cli/node_modules/tsx/dist/loader.mjs src/database/persistence/__test__/storage-growth.bench.mjs
```

`--output` 是基准脚本输出文件参数，不是产品设置；缺省写入系统临时目录。脚本按四组顺序各启动三个全新 Node 子进程，写出聚合 JSON 和每个 worker 的原始 JSON。重跑当前源码得到的是新结果表的加载器；下文候选列转录自历史报告，原始候选数据尚未恢复，不能把当前源码称为候选实现。

原实施记录称两轮脚本 SHA256 均为 `469ba2ee93ffd8d3b41319e4264833dcdadcfd0255a4ab669b0280162341757b`，Node 均为 `v24.10.0`，baseline 和 candidate 各 12 个独立进程、顺序运行且未混用早期试跑样本。这些执行过程缺少原件支持。当前 `31072ee8` 中脚本的 Git 内容（LF 换行）SHA256 为 `3d2db8ea4d11e382f48f0a0c942bd1055e078292b661ebaec08c6a0741e9f5d0`；Windows 工作副本 CRLF 换行为 `f43f16f969f7c6366081e7a54406b15ed8a2939d8db2d9a1168605431ab43c0f`，两者均不等于历史值，差异原因未查明。脚本输出的 `sha256` 按实际文件字节计算，因此后续归档应同时记录换行形式和源码提交。

后续交付性能比较时，应把确切脚本、基线与候选源码提交或补丁、逐进程原始 JSON 和验证日志放入 Git 跟踪的记录或持久审查附件；只保存在忽略目录或系统临时目录不算完成交付。重新运行当前源码只能测量已恢复的加载器，不能补成旧候选的证据。

现行脚本使用两个合成会话，当前会话固定 10 个 Run，其余是无关历史。每 Run 为 1 Input、2 Message、2 Part、1 模型 Attempt、1 Execution、1 已确认只读 Operation、1 DispatchAttempt、1 合法简短事件。工具正文分别存在 Part、Operation、DispatchAttempt。使用现有迁移建库，固定时间和可复现 ID，不读用户数据库、不调用模型、不添加依赖、索引、产品命令或配置；只清理由自身 mkdtemp 创建且核实位于临时目录内的数据库目录。

现行脚本在建库和批量写入之后计时，构造、owner 接管重读分别计时；内存取构造后 GC、重读后未 GC、重读后 GC 三个点。候选查询和安全状态全投影在每个进程内各预热 10 次、测量 100 次。查询聚合取单进程 100 次的中位数，再取三个进程中位数。数据库大小是建库连接关闭后主文件字节数。历史报告描述了相同口径，缺少原件时不能据此确认其实际执行方式。

以下 heap（JS 堆）和 RSS（进程驻留内存）均为历史报告中的 MiB 增量。现存脚本的计算方式是先对每个样本减去测量前手动 GC 的 before 值，再取中位数，不是两个中位数相减；但历史原始 JSON 未恢复，无法核对其绝对字节数和逐样本增量。

### 四组中位数

| Run / 正文 | 阶段 | DB MiB | 构造 ms | 接管 ms | 候选查询 ms | 安全全投影 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 100 / 4096 B | baseline | 2.137 | 16.838 | 10.545 | 0.011 | 0.009 |
| 1000 / 4096 B | baseline | 16.535 | 76.036 | 67.457 | 0.098 | 0.096 |
| 10000 / 4096 B | baseline | 160.367 | 745.167 | 638.305 | 1.974 | 2.038 |
| 10000 / 0 B | baseline | 41.508 | 428.881 | 370.750 | 2.068 | 2.061 |
| 100 / 4096 B | candidate | 2.137 | 17.723 | 11.375 | 0.010 | 0.010 |
| 1000 / 4096 B | candidate | 16.535 | 94.529 | 72.919 | 0.101 | 0.103 |
| 10000 / 4096 B | candidate | 160.367 | 695.088 | 640.013 | 1.972 | 1.951 |
| 10000 / 0 B | candidate | 41.508 | 488.631 | 442.956 | 2.209 | 1.922 |

| Run / 正文 | 阶段 | 构造 GC heap / RSS | 重读未 GC heap / RSS | 重读 GC heap / RSS |
| --- | --- | ---: | ---: | ---: |
| 100 / 4096 B | baseline | 2.158 / 3.254 | 8.513 / 4.215 | 2.240 / 4.465 |
| 1000 / 4096 B | baseline | 18.056 / 38.875 | 39.773 / 83.336 | 18.113 / 83.426 |
| 10000 / 4096 B | baseline | 176.385 / 440.488 | 513.994 / 620.398 | 176.912 / 615.270 |
| 10000 / 0 B | baseline | 58.783 / 173.070 | 144.792 / 239.988 | 59.009 / 234.996 |
| 100 / 4096 B | candidate | 2.190 / 4.234 | 8.613 / 4.863 | 2.260 / 4.906 |
| 1000 / 4096 B | candidate | 18.139 / 42.477 | 41.989 / 82.781 | 18.172 / 82.918 |
| 10000 / 4096 B | candidate | 176.502 / 289.723 | 359.737 / 474.324 | 176.569 / 469.141 |
| 10000 / 0 B | candidate | 58.854 / 169.766 | 128.327 / 232.262 | 58.921 / 227.762 |

### 历史报告转录的进程数值

原报告称下表每行来自一个独立新进程，内存为该进程相对自身 before 的增量，数据库大小同组不变。下表保留报告精度，不是原始 worker JSON，也不能验证进程身份及实际运行条件。

| 阶段 | Run / B | 样本 | 构造 ms | 接管 ms | 构造 GC heap / RSS | 重读未 GC heap / RSS | 重读 GC heap / RSS | 候选 / 安全 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| B | 100 / 4096 | 1 | 16.375 | 9.975 | 2.162 / 2.742 | 8.516 / 4.215 | 2.240 / 4.465 | 0.012 / 0.009 |
| B | 100 / 4096 | 2 | 17.518 | 12.788 | 2.158 / 3.254 | 8.513 / 4.090 | 2.240 / 4.273 | 0.011 / 0.010 |
| B | 100 / 4096 | 3 | 16.838 | 10.545 | 2.158 / 4.266 | 8.512 / 4.957 | 2.240 / 5.082 | 0.010 / 0.009 |
| B | 1000 / 4096 | 1 | 78.891 | 70.089 | 18.056 / 38.875 | 39.773 / 83.336 | 18.112 / 83.426 | 0.095 / 0.095 |
| B | 1000 / 4096 | 2 | 74.907 | 67.457 | 18.061 / 40.141 | 39.658 / 85.078 | 18.113 / 85.230 | 0.098 / 0.101 |
| B | 1000 / 4096 | 3 | 76.036 | 66.764 | 18.055 / 37.672 | 39.815 / 82.543 | 18.115 / 82.684 | 0.098 / 0.096 |
| B | 10000 / 4096 | 1 | 748.607 | 757.687 | 176.386 / 440.488 | 513.863 / 620.945 | 176.915 / 615.867 | 2.357 / 2.469 |
| B | 10000 / 4096 | 2 | 728.899 | 638.305 | 176.384 / 440.605 | 514.172 / 620.398 | 176.912 / 615.270 | 1.934 / 1.954 |
| B | 10000 / 4096 | 3 | 745.167 | 627.195 | 176.385 / 439.164 | 513.994 / 619.570 | 176.912 / 614.766 | 1.974 / 2.038 |
| B | 10000 / 0 | 1 | 428.881 | 370.750 | 58.795 / 172.910 | 144.874 / 239.520 | 59.014 / 234.535 | 2.068 / 2.059 |
| B | 10000 / 0 | 2 | 444.743 | 364.069 | 58.783 / 173.070 | 144.247 / 239.988 | 58.993 / 234.996 | 2.094 / 2.061 |
| B | 10000 / 0 | 3 | 426.484 | 386.766 | 58.781 / 174.566 | 144.792 / 240.453 | 59.009 / 235.477 | 2.040 / 2.114 |
| C | 100 / 4096 | 1 | 16.596 | 10.791 | 2.191 / 4.559 | 8.613 / 6.422 | 2.260 / 6.582 | 0.010 / 0.009 |
| C | 100 / 4096 | 2 | 17.723 | 13.242 | 2.190 / 4.074 | 8.611 / 4.863 | 2.259 / 4.906 | 0.011 / 0.010 |
| C | 100 / 4096 | 3 | 19.727 | 11.375 | 2.189 / 4.234 | 8.614 / 4.562 | 2.260 / 4.574 | 0.010 / 0.010 |
| C | 1000 / 4096 | 1 | 99.222 | 81.619 | 18.139 / 42.477 | 41.989 / 82.781 | 18.172 / 82.918 | 0.104 / 0.104 |
| C | 1000 / 4096 | 2 | 94.529 | 72.919 | 18.138 / 43.957 | 41.986 / 84.133 | 18.171 / 84.270 | 0.097 / 0.096 |
| C | 1000 / 4096 | 3 | 85.925 | 71.025 | 18.163 / 41.000 | 42.603 / 81.016 | 18.173 / 81.090 | 0.101 / 0.103 |
| C | 10000 / 4096 | 1 | 694.167 | 650.107 | 176.501 / 289.688 | 358.640 / 474.324 | 176.569 / 469.141 | 1.972 / 1.971 |
| C | 10000 / 4096 | 2 | 713.933 | 638.413 | 176.504 / 290.938 | 359.991 / 474.844 | 176.569 / 469.273 | 1.897 / 1.938 |
| C | 10000 / 4096 | 3 | 695.088 | 640.013 | 176.502 / 289.723 | 359.737 / 474.223 | 176.569 / 468.426 | 1.974 / 1.951 |
| C | 10000 / 0 | 1 | 488.631 | 419.961 | 58.851 / 172.348 | 128.120 / 232.867 | 58.918 / 227.762 | 2.209 / 1.922 |
| C | 10000 / 0 | 2 | 499.258 | 442.956 | 58.854 / 169.766 | 128.327 / 232.262 | 58.921 / 227.801 | 2.209 / 1.925 |
| C | 10000 / 0 | 3 | 485.310 | 453.827 | 58.855 / 168.594 | 128.356 / 230.844 | 58.923 / 225.664 | 2.173 / 1.897 |

### 历史报告转录的原始集合统计

现存脚本在测试侧包装实际 better-sqlite3 Statement.all，统计 Drizzle 转换及 JSON 解码之前返回的数组行数；不保留数组，不给生产代码添加 observer 或 hook。原报告给出下列 `maxRows / 调用数`，并称同组的三个进程及构造/接管两个阶段完全一致；因候选与原始 JSON 缺失，本轮未独立验证候选统计。E/O/A/P 分别表示 Execution、Operation、DispatchAttempt、Part。

| Run / B | 阶段 | E | O | A | P |
| --- | --- | --- | --- | --- | --- |
| 100 / 4096 | baseline | 100 / 1 | 100 / 1 | 100 / 1 | 200 / 1 |
| 1000 / 4096 | baseline | 1000 / 1 | 1000 / 1 | 1000 / 1 | 2000 / 1 |
| 10000 / 4096 | baseline | 10000 / 1 | 10000 / 1 | 10000 / 1 | 20000 / 1 |
| 10000 / 0 | baseline | 10000 / 1 | 10000 / 1 | 10000 / 1 | 20000 / 1 |
| 100 / 4096 | candidate | 100 / 1 | 100 / 1 | 100 / 1 | 200 / 1 |
| 1000 / 4096 | candidate | 256 / 4 | 256 / 4 | 256 / 4 | 256 / 8 |
| 10000 / 4096 | candidate | 256 / 40 | 256 / 40 | 256 / 40 | 256 / 79 |
| 10000 / 0 | candidate | 256 / 40 | 256 / 40 | 256 / 40 | 256 / 79 |

### 性能决定与边界

原报告采用的退出条件是：任何组的构造或接管中位数比 baseline 增加超过 20%，且增加超过 10 ms，视为明显倒退。按转录数值，1,000 Run × 4 KiB 构造从 76.036 ms 增至 94.529 ms（+24.32%，+18.493 ms），符合该条件；零正文控制组接管从 370.750 ms 增至 442.956 ms（+19.48%，+72.206 ms）。回滚与这组记录相符，但条件是否在候选执行前设定、样本是否经过选择，现有材料不足以确认。

按转录数值，10,000 Run × 4 KiB 的构造从 745.167 ms 降至 695.088 ms（−6.72%），接管从 638.305 ms 到 640.013 ms（+0.27%），重读后未 GC heap 增量从 514.0 MiB 降至 359.7 MiB（约 −30.0%）。这些是待原件支持的历史实验结果；该采样点不是严格峰值，固定 256 行也不是固定字节上限。原报告未测整个进程的严格内存峰值，也未采集加载中连续 heap 曲线。

这不是正文懒加载。报告中的 10,000 Run × 4 KiB 重读后 GC heap 增量约 176.9 → 176.6 MiB；当前源码仍持有完整状态，owner 重读期间仍要保留旧状态用于失败恢复。这里与较早的 `59cce87b` 合成基线不是同一轮实验，不能用那一轮约 172 MiB 的材料补证本次候选。RSS 包含原生内存和分配器保留，不能等同于 JS 活对象。脚本的查询包装与计数在计时窗口内，分批候选会承担更多包装调用，其影响未单独测量；历史数值不代表未加观测的生产耗时。系统负载和磁盘缓存没有严格控制，结果不代表冷盘启动或用户体验承诺。

原报告记载：候选 RED 为 7 项中 2 项预期失败，覆盖 513 行集合超过 256 和跨连接快照混读；GREEN 为五文件 123 项及类型检查通过，后续强化的 read-model 7 项也通过。候选代码、断言及 RED/GREEN 日志未在本轮检索中恢复，这些数量属于历史执行记录。回退后的原有加载测试已与实施前逐字节核对，不把当前加载器的测试或本轮样本当作候选验证。

实施结果见[存储热路径优化计划](./superpowers/plans/2026-10-27-storage-hot-path-optimization-plan.md)和[本轮证据](./superpowers/reviews/2026-10-27-storage-hot-path/README.md)。保留 Q1 的摘要读取与一次有限元数据清理保护，提交为 13d9f7cc。Q2 从冻结的 Q1 比较两轮后，第二轮候选查询与模拟派发未达收益门槛，1,000 Run 正文组接管还出现稳定退化，因此撤回生产改动并归档全部材料，停止本轮。没有增加缓存、索引、查询后端、懒加载或迁移；全历史加载和正文常驻仍保留。此前 2ae6a425 的 12 进程数据仍只是归档基准，不能替代本次以 Q1 为基线的比较。

基准独立进程驱动需要一条明确的门禁能力许可：`architecture-policy.mjs` 仅对上述精确脚本路径的 `node:child_process#spawnSync` 放行；该文件其它禁用能力、普通生产 mjs、其它路径和近似名称仍被拦截。不提供通用测试目录或 bench 文件豁免，不改变生产存储模块的能力限制，不提高旧调用基线。原实施记录还记载真实文件扫描回归先 RED、后完整 62 项 GREEN，以及回退后的原有五文件 117 项和 Services 类型检查通过；这些历史执行过程不作为本轮新增验证结果。
