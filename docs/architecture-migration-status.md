# 架构重组迁移状态

> 状态：当前。阶段 0–3 已完成，阶段 4 未开始。

## 当前阶段

阶段 0–2 已完成：依赖护栏、Session SQLite 数据库内核，以及 Project、Schedule、Workflow、Channel、Goal、Permission、Attachment 业务边界已经落地。
阶段 3 已完成：三域 Repository、跨域事务和增量输出均已抽取。`SessionStore` 保留公开兼容转发、Task waiter/listener、生命周期和维护入口。阶段 4 未开始。

## 指标

- `scripts/architecture-baseline.json` 是旧入口调用的只减不增基线。
- `pnpm check:architecture` 检查禁止的 package 依赖方向与内部模块导入边界，并比较当前生产代码调用数。
- 基线只能在调用数实际下降时通过 `node scripts/architecture-boundaries.mjs --write-baseline` 更新；禁止为了通过检查提高数字。
- 当前基线：`sessionStoreFlatCalls: 351`, `httpClientFlatCalls: 11`。
- 当前 `SessionStore` 行数：2152 行。

## 阶段 3 迁移记录

### 阶段 3A：只读 Repository
- 起始 commit：`00063c18`
- 提交记录：
  - `20711c26` test(services): lock session runtime read contracts
  - `7fd3810c` refactor(services): add session read repository
  - `33d8b576` refactor(services): add conversation read repository
  - `b9935cd4` refactor(services): add run read repository
  - `2b19581e` refactor(services): delegate session runtime reads
  - `d2772656` chore: close session runtime read extraction
- 迁出查询方法：
  - `SessionRepository`：`getSession`, `listSessions`, `listChildSessions`
  - `ConversationRepository`：`getInput`, `listInputAttachments`, `listSessionInputAttachments`, `countInputAttachmentReferences`, `countAttachmentReferences`, `listInputs`, `listMessages`, `listMessageParts`, `listEvents`, `latestEventSeq`
  - `RunRepository`：`getRun`, `findRunByInput`, `listRunsByInput`, `findOwningRunByInput`, `listRuns`, `getSessionTask`, `listSessionTasks`, `findSessionExecutionByRuntimeId`, `getRunAttempt`, `listRunAttempts`
- 验证命令：
  - `pnpm --filter @openharness/services test -- src/sessions src/conversations src/runs src/session-runtime`
  - `pnpm --filter @openharness/services check-types`
  - `pnpm --filter @openharness/server check-types`
  - `node --test scripts/architecture-boundaries.test.mjs`
  - `pnpm check:architecture`
  - `node scripts/check-docs.mjs`

### 阶段 3B：单实体写 Repository
- 起始 commit：`169656e0`
- 提交记录：
  - `169656e0` test(services): lock session runtime write contracts
  - `ec680062` refactor(services): move session entity writes
  - `a2cee388` refactor(services): move conversation entity writes
  - `78eb93c0` refactor(services): move run entity writes
  - `1faae28a` refactor(services): move session task entity writes
  - `a189228f` refactor(services): delegate session runtime entity writes
- 迁出写操作方法：
  - `SessionRepository`：`create`, `update`, `archive`, `beginArchive`
  - `ConversationRepository`：`appendEventInMemory`, `appendEvent`, `createMessage`, `upsertMessagePart`
  - `RunRepository`：`createRun`, `updateRun`, `createRunAttempt`, `updateRunAttempt`, `createSessionTask`, `reserveSessionTask`, `transitionPendingSessionTask`, `updateSessionTask`
- 验证命令：
  - `pnpm --filter @openharness/services test -- src/sessions src/conversations src/runs src/session-runtime`
  - `pnpm --filter @openharness/services check-types`
  - `pnpm --filter @openharness/server test -- src/application/session src/jobs src/permissions`
  - `pnpm --filter @openharness/server check-types`
  - `node --test scripts/architecture-boundaries.test.mjs`
  - `pnpm check:architecture`
  - `node scripts/check-docs.mjs`

### 阶段 3C：跨域事务
- `TransactionCoordinator` 已进入 database 内核，嵌套事务失败会使最外层回滚，提交后回调不会反向恢复已提交数据库。
- `ConversationTransactions` 已接管 prompt admission、owning/replay Run、transcript replace/edit、session fork、session tree 删除、daemon recovery 和 `getSessionState` 聚合。
- `deleteSessionTree` 保持禁止嵌套语义，且不再清空树外待提交 mutation。
- Task listener 通知通过 `deferUntilCommit` 延迟到最外层提交成功之后。
- fork 不复制 Run，复制后的 Message 不保留源 `runId`；replay metadata 只接受调用方显式值；snapshot 保持现有协议，不新增 children。
- 事务测试包含 6 个 coordinator 契约用例和至少 15 个业务阶段失败注入场景，覆盖内存、mutation、delta、event sequence、SQLite reopen 与提交后通知。
- Store 残留 SQL 已逐项核对：application owner lease 属于进程写入围栏；retention 属于维护事务；`persistChanges` 中的 SQL 是 database kernel 尚由 Store 装配的持久化回调，不是跨域业务事务。

### 阶段 3D：增量输出与 Checkpoint
- `IncrementalOutput` 接管 delta append、UTF-8 字节/时间阈值、显式 flush、三层时间戳 SQL 和 checkpoint close。
- Store 的 append/flush 只转发，`persistChanges` 复用同一 flush 实现，不再保留第二套 delta SQL。
- close、backup、Run terminal 和 transcript replace durability 边界已用 reopen 测试固定；backup 在 owner fence 后、复制数据库前 flush。
- services 全量验证为 45 个测试文件、429 个测试；已知 WSL/node-pty 全仓并发环境问题未在本阶段处理。
- Server 定向验证中 transcript projection 与 run engine 共 34 个测试通过；run executor 收集及 Server typecheck 受当前 worktree 缺失 `yaml`、内部 workspace 包解析和重复物理路径类型问题阻断，未通过安装依赖或改业务代码规避。

## 当前所有权

`SessionStore` 不再拥有阶段 3 的领域读写、跨域业务事务或 delta SQL；它保留公开兼容接口、进程内 listener、数据库生命周期和维护入口。
三域 Repository 独立负责各领域的单实体读写，`ConversationTransactions` 负责 Session/Conversation/Run 的跨域原子编排；`SessionStore` 保留代理转发与 Task waiter/listener。

Project SQL、路径规则和写操作已迁入 `packages/services/src/projects`。`SessionStore` 保留八个兼容转发方法，Server 的 `ProjectApplicationService` 只依赖七个 Project 动作的窄 capability。`StorageContext.atomic()` 由 database 内核的 `TransactionCoordinator` 提供。

Scheduled Task/Run SQL 和 row conversion 已迁入 `packages/services/src/schedules`。`SessionStore` 保留十个兼容转发方法；Server 的 `ScheduledTaskService` 只依赖九个实际使用的 Schedule 操作，计时器和 Agent 执行策略仍由 Server 拥有。

Workflow Run/Event/Claim SQL 和 row conversion 已迁入 `packages/services/src/workflows`，retention 跨域清理 SQL 暂留 Maintenance 路径。Server Workflow adapter 只依赖 Workflow 存储与 session event 窄能力，并使用进程内 change version 防止 event-only wait 注册竞态。

External Conversation 与 Channel Delivery SQL 和 row conversion 已迁入 `packages/services/src/channels`。`SessionStore` 保留八个兼容转发方法；Server Channel application service 只通过 `store.channels` 执行 Channel 持久化，Session/Input 查询仍使用窄 Store 能力。

Goal 四组表 SQL 和 row conversion 已迁入 `packages/services/src/goals`，跨 Session、Run 与 durable event 的规则由 `GoalTransactions` 原子执行。`SessionStore` 保留十四个兼容转发方法；Server 的 Goal 调用统一经过 `store.goals`。

Permission read model、状态转换和 durable event 已迁入 `packages/services/src/permissions`。`SessionStore` 保留五个兼容转发方法；Server Broker 只依赖 Permission、Session lineage 和 event cursor 窄能力，live resolver 与授权复用策略仍由 Server 持有。

Attachment asset、representation、lease 的 SQL、row conversion 和状态事务已迁入 `packages/services/src/attachments`。`SessionStore` 保留兼容转发；Application、Integrity、OCR、RunExecutor、compact 和 backup 使用附件入口或窄能力。lease token、representation claim/recovery 与 durable GC saga 需要 schema/协议变化，已明确留给后续安全阶段。

## 下一步

阶段 4：拆分 Server Application Service 与 Runtime 编排。
