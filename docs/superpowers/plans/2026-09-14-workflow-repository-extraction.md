# Workflow Repository 提取实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 提取 Workflow Run/Event/Claim 存储，保留 Store 兼容，并让 Server Workflow adapter 只依赖窄存储与 session event 能力。

**架构：** WorkflowRepository 使用 StorageContext 和临时 assertWritable owner fence；Server adapter 负责 Coordinator 编解码、event 镜像、wait/listener 和 SSE 通知。Retention 跨域 SQL留在 Maintenance 路径。

**技术栈：** TypeScript、better-sqlite3、Vitest、Coordinator Workflow API。

---

## 任务 1：提取 Workflow Records 与 Repository

**文件：**
- 创建：`packages/services/src/workflows/workflow-records.ts`
- 创建：`packages/services/src/workflows/workflow-repository.ts`
- 创建：`packages/services/src/workflows/workflow-repository.test.ts`
- 创建：`packages/services/src/workflows/index.ts`
- 修改：`packages/services/src/database/storage-context.ts`

- [ ] 先写失败测试：run/attempt 保存与替换、owner/status 过滤、磁盘重载、event 顺序、claim 首次/重复/接管/结束、失效 owner 拒绝写入。
- [ ] 用 trigger 在第二个 attempt INSERT 时失败，断言旧 snapshot 与旧 attempts 完整保留。
- [ ] 运行 `pnpm --filter @openharness/services test -- workflow-repository`，确认缺少模块而失败。
- [ ] 实现 Records、七方法 Repository，并给 StorageContext 增加 `assertWritable()`；Store 绑定到现有 owner fence。
- [ ] 运行 Repository 测试和 Services 类型检查。
- [ ] 提交：`refactor(services): add workflow repository`。

## 任务 2：收缩 SessionStore Workflow 入口

**文件：**
- 修改：`packages/services/src/session-runtime/store.ts`
- 修改：`packages/services/src/session-runtime/__test__/store.test.ts`

- [ ] 增加旧七方法兼容测试，覆盖带 sessionId 的 `appendWorkflowEvent()` 同时生成 workflow event 与 session durable event。
- [ ] 运行 Store 测试固定现有行为。
- [ ] Store 构造 `readonly workflows`；save/load/list/event list/claim/finish 只转发。
- [ ] 兼容 appendEvent 先调用 Repository，再按现有顺序写 session event；失败时 workflow event 保留且错误上抛。
- [ ] 删除 Store 中 Workflow CRUD/claim SQL 和 row conversion；保留 retention SQL。
- [ ] 运行 Services 全量、类型和 schema/migration diff。
- [ ] 提交：`refactor(services): delegate workflows from session store`。

## 任务 3：迁移 Server Workflow Adapter 并修复 event-only wait 竞态

**文件：**
- 修改：`packages/server/src/application/workflow/session-workflow-run-repository.ts`
- 修改：对应 Workflow repository 测试
- 修改：`packages/server/src/application/daemon-application.ts`

- [ ] 写失败测试：窄 fake 覆盖七个存储方法；session event 镜像失败后 workflow event 保留、错误上抛、SSE/waiter 不通知。
- [ ] 写 event-only 竞态测试：事件发生在首次 load 与 listener 注册之间，wait 必须立即结束而非等 timeout。
- [ ] Adapter 构造参数改为 workflow storage、session events、database path 和通知回调。
- [ ] 增加每 run 进程内 change version；save 和成功 event 镜像后递增，wait 注册后复查 version。
- [ ] Daemon composition 注入 `store.workflows`、`store.path` 和 `latestEventSeq/appendEvent` 窄能力。
- [ ] 运行 Server Workflow 测试与类型检查。
- [ ] 提交：`refactor(server): depend on workflow repository capability`。

## 任务 4：迁移只读调用、更新基线并收尾

**文件：**
- 修改：`packages/server/src/application/control/run-inspector.ts`
- 修改：`packages/server/src/application/control/daemon-control-service.ts`
- 修改：相关测试
- 修改：`docs/architecture-migration-status.md`
- 修改：`scripts/architecture-baseline.json`

- [ ] 将 inspector/control 的 Workflow 查询依赖改为只含 `listRuns()` 的结构类型，composition 传入 `store.workflows`。
- [ ] 测试它们不调用 Store 平铺 `listWorkflowRuns()`。
- [ ] 运行架构检查并只在数字下降时写新基线。
- [ ] 更新状态为阶段 2C1 完成、下一步 Channel 2C2。
- [ ] 运行 Services 全量、Server Workflow/Control 测试、两包类型、架构、文档和 diff 检查。
- [ ] 提交：`refactor(server): use workflow query capability`。

## 最终验收

- [ ] 除 retention 外，Workflow SQL/转换只在 workflows 目录。
- [ ] owner fence、attempt 回滚和 claim 语义有失败测试。
- [ ] Store 七方法兼容，event 镜像部分成功语义不变。
- [ ] Server adapter 不依赖完整 Store，event-only wait 不丢唤醒。
- [ ] inspector/control 使用窄查询能力。
- [ ] schema、migration 和协议不变。
- [ ] Services、Server、架构和文档检查通过。
