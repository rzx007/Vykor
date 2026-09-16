# 架构重组迁移状态

> 状态：当前。阶段 0–7 与 clean-slate Stage 8A 已完成。

## 当前阶段

阶段 0–2 已完成：依赖护栏、Session SQLite 数据库内核，以及 Project、Schedule、Workflow、Channel、Goal、Permission、Attachment 业务边界已经落地。
阶段 3 已完成：三域 Repository、跨域事务和增量输出均已抽取。`SessionStore` 保留公开兼容转发、Task waiter/listener、生命周期和维护入口。
阶段 4A 已完成：Event、Retention、Channel、Terminal、Job、BackgroundShell、Attachment、AgentPool 等简单 Application Service 的依赖能力已全部收窄为最小接口，彻底移除对完整 `SessionStore` 的导入；Server 边界检查（Route、Application Service、Runtime）已补充并纳入架构护栏。
阶段 4B 已完成：Session Query 与 Command 拆分完成，`SessionQueryService` 读服务完成能力收窄与协议解耦，`SessionCommandService` 写服务抽取完成，`SessionApplicationService` 变为向前兼容委托层，`DaemonApplication` 组装一次共享实例，新增 SessionCommand 与 SessionQuery 的架构护栏。
阶段 4C 已完成：`RunAdmissionService` 统一拥有 prompt、持久 Run 派发、rejected-steer 恢复和 goal revision 执行准入；`RunControlService` 统一拥有查询、提升、等待、中断和关闭。`DaemonApplication` 显式构造唯一共享实例并注入 Session、Goal、DaemonControl 与兼容 Engine。
阶段 4D 已完成：`SessionRunCoordinator` 成为 lane、Promise 与 live 状态索引的唯一所有者；`SessionRunEngine` 不再保存第二份 run Promise map；`SessionRunExecutor` 通过命名 data capability 执行单个已准入 Run。
阶段 4E 已完成：`StartupRecoveryService` 按固定顺序执行 durable recovery，失败继续阻止 ready；Maintenance 与 PostRun 使用命名 data 边界；既有 Transcript/Execution Projection 保持唯一映射所有者。
阶段 4F 已完成：Scheduled Task 的 worktree、Session、permission、admission、await 与清理流程迁入 `ScheduledTaskExecutor`；Daemon 保留显式服务组合、ready 和 close。
阶段 5 已完成：Transport 内核、ProtocolClient、14 个专用业务/执行 Resource 彻底抽取完成。`OpenHarnessClient` 收敛为 Resource 组合根，移除全部 endpoint 字符串与业务 decoder；内部 consumer 收窄为命名 capability；架构规则补充 Client Resource 与 Transport 隔离护栏。后续 clean-slate Stage 8A 已物理删除顶层兼容 facade，领域 Resource 是唯一业务入口。
阶段 6 已完成：Desktop 与 Frontend 状态边界重组完成。建立平台状态所有权（Matrix + 纯 Selector）；抽取跨平台 SSE 连接与断线重连控制器 `SessionSyncController`；解构 Frontend `useServerSync`（1333 行降至 770 行）；解构 Desktop Main `SessionService`（1152 行降至 439 行）；审计确认 Desktop Renderer Store 已有的 `applySessionUpdate` 是持久对账单入口（本阶段未改动 renderer 生产代码）；架构护栏收窄 client 扁平旧调用至 79（下降 25 次）。
阶段 7 已完成：Public API Convergence（公共 API 收敛）。Client 内部、CLI、Desktop Main 与 Frontend 的生产调用均迁到命名领域 Resource。该阶段曾短暂保留的 118 个顶层方法与双发行治理属于历史过程，已由 clean-slate Stage 8A 删除，不构成当前 API 或发行承诺。

阶段 4 最终复审补充：Coordinator 等待的是包含 `settleGoalRun` 的完整 completion Promise，shutdown 不会在 Goal settlement 尚未结束时关闭 Store；Session Run 三件套的两阶段闭包装配进入纯 `assembleSessionRunServices` factory，Executor 的 Skill/Attachment/Capability/steer 依赖进入 `assembleSessionRunExecutor`；settings、model limits、Skill catalog/list 和 plugin inventory 统一由 `createSessionRuntimeDiscovery` 提供，避免 Daemon 内重复发现扩展；Maintenance/PostRun 使用精确方法 capability，并由架构测试禁止重新持有完整 `SessionStore`。`DaemonApplication` 最终为 908 行。最终统一验证为 Server 80 个文件、717 个测试，Services 最近一次回归为 45 个文件、430 个测试，全仓 TypeScript 61/61，架构测试 15/15。

## 指标

- `scripts/architecture-baseline.json` 只保留尚在迁移的 `SessionStore` 调用基线。
- `pnpm check:architecture` 检查禁止的 package 依赖方向与内部模块导入边界，并串联 `pnpm check:client-api` 执行当前契约比对、永久 forbidden-surface 扫描与 consumer 负向 fixture 编译。
- 基线只能在调用数实际下降时通过 `node scripts/architecture-boundaries.mjs --write-baseline` 更新；禁止为了通过检查提高数字。
- 当前基线：`sessionStoreFlatCalls: 248`。Client 旧名采用绝对禁止，不再维护数量基线。
- 当前 `SessionStore` 行数：2152 行。
- 当前 `OpenHarnessClient`（`http-client.ts`）只组装 15 个 Resource，不提供顶层业务转发或底层 transport 成员。
- 当前 `useServerSync.ts` 行数：770 行（原 1333 行，净删减 563 行）。
- 当前 Desktop `SessionService.ts` 行数：439 行（原 1152 行，净删减 713 行）。
- 当前 Desktop `session-actions.ts` 行数：926 行。

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
- Server 定向验证覆盖 transcript projection、run engine 与 run executor；Server typecheck 在 worktree 按锁文件安装依赖并构建 `@openharness/agent-runtime` 后通过。此前临时 Junction 导致的 `yaml`、workspace 包解析和重复物理路径报错不属于代码回归。

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

## 阶段 4A 迁移记录：Server Application Service 能力收口

- 起始 commit：`dab1a3d9`
- 提交记录：
  - `aa80643b` test(server): lock simple application service contracts
  - `2c974818` refactor(server): narrow simple application capabilities
  - `1ce15636` refactor(server): narrow task and terminal capabilities
  - `a3603155` refactor(server): narrow attachment and agent query capabilities
- 收窄服务能力：
  - `ApplicationEventService`：从完整 `SessionStore` 收窄为 `ApplicationEventStore`（`listEvents`, `latestEventSeq`）。
  - `ApplicationRetentionService`：从完整 `SessionStore` 收窄为 `RetentionStoreOperations`（`applyRetention`, `listRetentionAudits`）。
  - `ChannelApplicationService`：将 Session/Input 查询收窄为 `ChannelSessionQueries`（`getInput`, `getSession`）。
  - `DaemonTerminalService`：将 Project/Session 查询收窄为 `DaemonTerminalSessionScopeQueries`（`getProject`, `getSession`）。
  - `DaemonJobService`：将 Session/Task 查询与更新收窄为 `JobSessionQueries`（`getSession`, `listSessionTasks`, `getSessionTask`, `updateSessionTask`, `waitForSessionTaskChange`）。
  - `BackgroundShellService`：将 Task 生命周期与 Session 查询收窄为 `BackgroundShellSessionQueries`。
  - `AttachmentAccess` / `CompactAttachmentCatalog` / `AgentPool`：分别收窄为 `AttachmentSessionResolverQueries`、`AttachmentSessionReferenceQueries`、`CompactAttachmentAssetQueries`、`AgentPoolSessionQueries`。
  - `scripts/architecture-boundaries.mjs`：新增 Server 边界规则，禁止 HTTP routes 导入 `SessionStore` 或 Repository，禁止 Application Service 导入 `DaemonApplication`，禁止 Runtime 导入 `http/routes`。
- 调用指标与基线变化：
  - `sessionStoreFlatCalls`：从 351 降至 343（-8）。
  - `httpClientFlatCalls`：保持 11。
- 验证命令：
  - `pnpm --filter @openharness/server test`
  - `pnpm --filter @openharness/server check-types`
  - `pnpm --filter @openharness/services test`
  - `node --test scripts/architecture-boundaries.test.mjs`
  - `pnpm check:architecture`
  - `node scripts/check-docs.mjs`
  - `git diff --check`

## 阶段 4B 迁移记录：Session Query 与 Command 拆分

- 起始 commit：`1b5a12f8`
- 提交记录：
  - `7e364be6` test(server): lock session lifecycle application contracts
  - `35a61ee8` refactor(server): complete session query service
  - `115a48a7` refactor(server): extract session command service
  - `0d6c264f` refactor(server): delegate session query and commands
- 拆分内容：
  - `SessionQueryService`：从直接依赖 `SessionStore` 收窄为 `SessionQueryStore` 接口，解耦具体 Store 实现；完全移除写能力与事务，确保纯只读查询。
  - `SessionCommandService`：抽离会话生命周期命令操作（`createSession`、`forkSession`、`updateSession`、`archiveSessionTree`、`deleteSessionTree`、`closeRuntime`），通过细粒度接口依赖会话存储、事务编排、运行时控制、操作并发门（Operation Gate）与事件发布。
  - `SessionApplicationService`：转换为向前兼容委托门面，已抽离的查询委托至 `SessionQueryService`，生命周期写操作委托至 `SessionCommandService`，并删除已迁移的私有 helper（如 `archiveSessionTreeWork`、`acquireSessionMutation`、`mergeSessionMetadata`、`forkSessionMetadata`）。
  - `DaemonApplication`：统一在装配根初始化一次 `SessionQueryService` 与 `SessionCommandService`，复用给 `SessionApplicationService` 与 `DurableAgentApplication`，禁止在各层重复构造。
  - `scripts/architecture-boundaries.mjs`：新增架构护栏，禁止 `SessionCommandService` 导入 HTTP 路由与 Daemon 顶层，禁止 `SessionQueryService` 导入 Runtime。
- 调用指标与基线变化：
  - `sessionStoreFlatCalls`：从 343 降至 325（-18）。
  - `httpClientFlatCalls`：保持 11。
  - `SessionApplicationService.ts` 行数：从 907 行减少至 764 行（-143 行）。
- 验证命令：
  - `pnpm --filter @openharness/server test`
  - `pnpm --filter @openharness/server check-types`
  - `pnpm --filter @openharness/services test`
  - `node --test scripts/architecture-boundaries.test.mjs`
  - `pnpm check:architecture`
  - `node scripts/check-docs.mjs`
  - `git diff --check`

## 阶段 6 迁移记录：Desktop 与 Frontend 状态边界重组

- 起始 commit：`b616e1df`
- 阶段子模块与提交记录：
  - 阶段 6A：`105d3183` refactor(client): establish platform state ownership
    - 在 `@openharness/client` 新增纯派生选择器 `selectSessionInputs`、`selectSessionOrderedMessages`、`selectSessionParts`、`selectSessionRuns`、`selectSessionTasks`、`selectSessionPermissions`、`selectFirstPendingPermission`。
    - 确立统一跨平台状态所有权矩阵（Matrix），补充 `scripts/architecture-boundaries.mjs` 跨平台边界规则。
  - 阶段 6B：`aec2268e` refactor(client): extract platform sync controller
    - 在 `@openharness/client` 抽取 `SessionSyncController`，统一快照挂载、增量游标同步、gap 检测与指数退避重连。
  - 阶段 6C：`24793c09` refactor(frontend): split server sync hook
    - 解构 Frontend `useServerSync.ts`（1333 行降至 770 行），拆分为 `actions.ts`、`connection.ts`、`mcp.ts`、`permissions.ts`、`view-model.ts`，保留全部 hook 接口兼容。
  - 阶段 6D：`5a0180a7` refactor(desktop): split main session service 与 `11ee38c4` fix(desktop): preserve clientPromise accessor for test compatibility
    - 解构 Desktop Main `session-service.ts`（1152 行降至 439 行），拆分为 `daemon-connection-service.ts`、`session-subscription-service.ts`、`session-operations.ts`，保留 `DesktopSessionService` 门面及公开属性兼容。
  - 阶段 6E：`9f95ca54` refactor(desktop): unify renderer durable reconciliation
    - 审计确认既有 `applySessionUpdate` 已是 Desktop Renderer Store 持久对账单入口；该提交只补充状态所有权文档，没有改动 renderer 生产代码。
  - 阶段 6F：兼容集成、调用收口与统一验收
    - 将 `session-operations.ts` 与 `actions.ts` 中的调用平移至 Client Resource 原生方法（如 `client.sessions.*`、`client.projects.*`、`client.system.*`、`client.jobs.*`）。
    - 治理旧扁平调用：`clientLegacyFlatCalls` 真实下降至 79（下降 25 次），更新基线。
- 调用指标与基线变化：
  - `clientLegacyFlatCalls`：从 104 降至 79（-25）。
  - `useServerSync.ts` 行数：1333 行 -> 770 行（-563 行）。
  - Desktop `SessionService.ts` 行数：1152 行 -> 439 行（-713 行）。
  - Desktop `session-actions.ts` 行数：926 行（保持单一持久对账入口）。
- 验证命令：
  - `pnpm --filter @openharness/client test`
  - `pnpm --filter @openharness/frontend test`
  - `pnpm --filter @openharness/desktop test`
  - `pnpm --filter @rzx/ohs test`
  - `pnpm --filter @openharness/server test -- src/http`
  - `pnpm check-types`
  - `node --test scripts/architecture-boundaries.test.mjs`
  - `pnpm check:architecture`
  - `node scripts/check-docs.mjs`
  - `git diff --check`


## 阶段 7 迁移记录：Public API Convergence（公共 API 收敛）

阶段 7 曾把调用者迁到领域 Resource。后续 clean-slate 设计已经删除 Client 顶层兼容 facade 与双发行治理；当前事实源是只列当前导出的 `scripts/client-public-api-contract.json`，旧名称只保存在测试专用 forbidden 清单和负向编译 fixture 中。

## 下一步

阶段 8A、8B 已完成：永久 removal ledger 固定了 118 个旧名称、replacement、Stage 7 Git 快照与 SHA-256；普通 integrity check 已接入根测试和架构检查；显式 removal gate 会验证 stable channel、commit/tag/祖先关系、发布时间、npm 证据结构、授权摘要和 major target。Tag Release 现在会在类型检查、全量测试、架构检查和双平台安装包构建完成后才创建 tag，npm 在线校验成功后才创建 GitHub Release，并输出机器可读证据。当前 integrity 为 PASS，removal gate 因 A/B 发行均 pending 而保持 118/118 BLOCKED。下一步为 8C：执行弃用版 A 的真实稳定发行并登记证据；物理删除仍未解锁。详细顺序见 `docs/superpowers/plans/2026-09-16-client-flat-facade-removal-stage-8.md`。
