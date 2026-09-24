# Schedule Repository 提取实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Scheduled Task/Run 持久化规则迁入 `ScheduleRepository`，保留 Store 兼容 API，并让 Server 定时服务只依赖九个实际使用的 Schedule 操作。

**架构：** Repository 直接使用 `StorageContext.database.connection`，多 SQL 删除使用 SQLite transaction；不接触 Session read model、mutation buffer 或 atomic。Server 保留计时与执行策略，只替换存储依赖。

**技术栈：** TypeScript、better-sqlite3、Vitest、pnpm workspace。

---

## 任务 1：提取 Schedule Records 与 Repository

**文件：**
- 创建：`packages/services/src/schedules/schedule-records.ts`
- 创建：`packages/services/src/schedules/schedule-repository.ts`
- 创建：`packages/services/src/schedules/schedule-repository.test.ts`
- 修改：`packages/services/src/schedules/index.ts`
- 修改：`packages/services/src/session-runtime/store-state.ts`

- [ ] **步骤 1：编写失败测试**

用真实 `SessionStore` 取得 `storage` 后直接构造 Repository，覆盖：Task 默认值、完整 JSON 字段、update 的 undefined/null、状态过滤；Run 创建、unread/taskId/limit 过滤、更新和 queued/running 中断。

加入原子删除失败测试：创建 Task 和 Run，添加 `BEFORE DELETE ON scheduled_task` trigger 抛出 `forced task delete failure`，调用 `deleteTask()` 后断言 Task 和 Run 均保留。

直接写 SQL 覆盖兼容 JSON：非字符串/语法错误使用 fallback，合法 `null`/`{}` 继续透传，坏的非空 stop policy 返回 `{}`。

- [ ] **步骤 2：运行测试确认失败**

```powershell
pnpm --filter @vykor/services test -- schedule-repository
```

预期：FAIL，缺少 ScheduleRepository。

- [ ] **步骤 3：实现 Records 和 Repository**

从 `store-state.ts` 移动 `scheduledTaskFromRow()`、`scheduledRunFromRow()` 和 `parseJson()`；从 Store 复制十个 Schedule 方法到 Repository，并把命名改为 task/run 窄方法。`deleteTask()` 保持两条 DELETE 在一个 better-sqlite3 transaction。

- [ ] **步骤 4：验证并提交**

```powershell
pnpm --filter @vykor/services test -- schedule-repository store
pnpm --filter @vykor/services check-types
git diff --check
git add packages/services/src/schedules packages/services/src/session-runtime/store-state.ts
git commit --no-verify -m "refactor(services): add schedule repository"
```

## 任务 2：收缩 SessionStore Schedule 入口

**文件：**
- 修改：`packages/services/src/session-runtime/store.ts`
- 修改：`packages/services/src/session-runtime/__test__/store.test.ts`

- [ ] **步骤 1：固定 Store 兼容行为**

保留现有 “stores Scheduled tasks and Agent run projections in SQLite” 与 “interrupts unfinished Scheduled runs after daemon restart” 测试；补一个通过旧十个方法完成 Task/Run 生命周期的兼容测试，确认 `getScheduledRun()` 仍公开可用。

- [ ] **步骤 2：运行特征测试**

```powershell
pnpm --filter @vykor/services test -- store
```

预期：现有和新增兼容测试通过。

- [ ] **步骤 3：构造 Repository 并替换实现**

Store 增加 `readonly schedules: ScheduleRepository`，在 StorageContext 完成后构造。十个旧方法只转发；删除 Store 中 Schedule SQL、`withoutUndefined()` 以及已迁走的 row converter import。

- [ ] **步骤 4：验证并提交**

```powershell
pnpm --filter @vykor/services test
pnpm --filter @vykor/services check-types
git diff -- packages/services/src/session-runtime/schema.ts packages/services/src/session-runtime/migrations
git add packages/services/src/session-runtime/store.ts packages/services/src/session-runtime/__test__/store.test.ts
git commit --no-verify -m "refactor(services): delegate schedules from session store"
```

预期：Services 全量通过，schema/migration diff 无输出。

## 任务 3：让 ScheduledTaskService 依赖窄能力

**文件：**
- 修改：`packages/server/src/daemon/scheduled-task-service.ts`
- 修改：`packages/server/src/daemon/__test__/scheduled-task-service.test.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`docs/architecture-migration-status.md`
- 修改：`scripts/architecture-baseline.json`

- [ ] **步骤 1：编写失败测试**

把测试 fake 改为只实现 `ScheduleOperations`。用调用数组断言构造顺序：

```ts
expect(calls.slice(0, 2)).toEqual([
  ["interruptActiveRuns", "Daemon restarted while the scheduled task was running"],
  ["listTasks"],
])
```

真实 composition 测试在构造后破坏 Store 平铺 Schedule 方法，通过 `application.schedules.listTasks()`/`createTask()` 证明使用 `store.schedules`。Server capability 不包含 `getRun()`。

- [ ] **步骤 2：运行测试确认旧 Store 依赖失败**

```powershell
pnpm --filter @vykor/server test -- scheduled-task-service
```

预期：FAIL，旧 Service 调用 `interruptActiveScheduledRuns/listScheduledTasks`。

- [ ] **步骤 3：实现 capability 与 composition**

在 scheduled-task-service 定义九方法 `ScheduleOperations`，`ScheduledTaskServiceOptions` 使用 `schedules` 字段。所有内部 `options.store.*` 改为对应 task/run 方法；DaemonApplication 注入 `store.schedules`。计时、验证和执行逻辑不移动。

- [ ] **步骤 4：更新基线和状态**

```powershell
pnpm check:architecture
node scripts/architecture-boundaries.mjs --write-baseline
```

只有旧 Store 调用数量下降时更新。文档将阶段 2B 标为完成，并记录下一阶段为 Workflow/Channel。

- [ ] **步骤 5：最终验证并提交**

```powershell
pnpm --filter @vykor/services test
pnpm --filter @vykor/server test -- scheduled-task-service
pnpm --filter @vykor/services check-types
pnpm --filter @vykor/server check-types
pnpm check:architecture
node scripts/check-docs.mjs
git diff --check
```

预期：全部通过。

```powershell
git add packages/server/src/daemon packages/server/src/application/daemon-application.ts docs/architecture-migration-status.md scripts/architecture-baseline.json
git commit --no-verify -m "refactor(server): depend on schedule repository capability"
```

## 最终验收

- [ ] Repository 唯一拥有 Schedule SQL 和 row conversion。
- [ ] Store 十个方法只转发，`getScheduledRun()` 保持可用。
- [ ] Server capability 只有九个实际使用的方法。
- [ ] 删除失败、JSON 兼容、limit 和启动恢复顺序都有测试。
- [ ] schema、migration 和协议不变。
- [ ] Services、Server、架构和文档检查通过。
