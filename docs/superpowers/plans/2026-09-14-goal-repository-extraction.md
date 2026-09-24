# Goal Repository 与跨域事务提取实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。子代理仅用于只读审查，不执行实现。

**目标：** 将 Goal 四组表的 SQL 迁入 `GoalRepository`，将跨 Session/Run/event 的规则迁入 `GoalTransactions`，保留 Store 兼容 API，并收窄 Server Goal 依赖。

**架构：** Repository 只处理本域表；GoalTransactions 实现完整 14 项 GoalOperations，并在每个写入口的 `storage.atomic()` 内先执行 `assertWritable()`。Store 只转发，Server 通过 `store.goals` 使用 Goal 能力。

**技术栈：** TypeScript、better-sqlite3、Vitest、pnpm workspace。

---

## 文件结构

- 创建 `packages/services/src/goals/goal-records.ts`：Goal/request row conversion。
- 创建 `packages/services/src/goals/goal-repository.ts`：四组 Goal 表的低级 SQL。
- 创建 `packages/services/src/goals/goal-transactions.ts`：14 项公开 Goal 能力与跨域事务。
- 创建 `packages/services/src/goals/*.test.ts`：Repository 和跨域事务测试。
- 创建 `packages/services/src/goals/index.ts`：包内导出。
- 修改 `packages/services/src/session-runtime/store.ts`：构造 goals 并保留兼容转发。
- 修改 Server Goal/Run/Daemon 调用点：改用 `store.goals`。

## 任务 1：提取 Records 与 GoalRepository

**文件：**
- 创建：`packages/services/src/goals/goal-records.ts`
- 创建：`packages/services/src/goals/goal-repository.ts`
- 创建：`packages/services/src/goals/goal-repository.test.ts`
- 创建：`packages/services/src/goals/index.ts`

- [ ] **步骤 1：编写失败测试**

用真实 Store 建立 Session，再从 `storage` 构造 Repository，覆盖 request 同 fingerprint 幂等、不同 fingerprint/session 冲突、settle 与磁盘重载；assessment upsert/evidence；continuation insert-or-ignore/mark；严格 JSON 解析与返回对象隔离。

- [ ] **步骤 2：运行红灯**

```powershell
pnpm --filter @vykor/services test -- goal-repository
```

预期：缺少 GoalRepository。

- [ ] **步骤 3：实现低级 SQL**

Repository 方法不自行调用 `assertWritable()` 或跨域 event；写方法只执行 SQL并返回本域记录。`goal-records.ts` 保持当前 JSON.parse 语义。

- [ ] **步骤 4：验证并提交**

```powershell
pnpm --filter @vykor/services test -- goal-repository session-goals
pnpm --filter @vykor/services check-types
git diff --check
git add packages/services/src/goals
git commit --no-verify -m "refactor(services): add goal repository"
```

## 任务 2：实现 GoalTransactions

**文件：**
- 创建：`packages/services/src/goals/goal-transactions.ts`
- 创建：`packages/services/src/goals/goal-transactions.test.ts`

- [ ] **步骤 1：编写跨域失败测试**

覆盖 create/update/start/finish 的 event trigger 故障：在对应 Goal SQL 已发生后，让 `session_event` INSERT trigger 抛错，断言当前实例与重开实例的 Goal、currentRunId、revision 和 event 均未变化。

覆盖 start 的跨 Session、terminal Run、旧 revision、重复 run、automatic 计数和额度暂停。覆盖 startup 只暂停 active、取消 pending continuation，并用第二个 Goal 更新 trigger 证明整体回滚。

- [ ] **步骤 2：编写外层事务与 fence 测试**

在 `store.transaction()` 内 create Goal + admit input + create Run，inner atomic 成功后 outer 抛错；同时断言当前实例和重开实例没有 Goal/input/run/event，event sequence、read model、mutation buffer 无泄漏。

取得 owner 后让另一 Store 在 stale 条件下接管，再调用 request/assessment/continuation/update 等写入口，断言均拒绝且数据库无新记录。

- [ ] **步骤 3：运行红灯**

```powershell
pnpm --filter @vykor/services test -- goal-transactions
```

预期：缺少 GoalTransactions 或原子回滚行为不满足。

- [ ] **步骤 4：实现 14 项 GoalOperations**

所有写方法使用：

```ts
return storage.atomic(() => {
  storage.assertWritable()
  return repository.write(...)
})
```

create/update/start/finish/startup pause 在同一 atomic 中追加 durable event。读取方法直接委托 Repository。

- [ ] **步骤 5：验证并提交**

```powershell
pnpm --filter @vykor/services test -- goal-transactions goal-repository session-goals store
pnpm --filter @vykor/services check-types
git add packages/services/src/goals
git commit --no-verify -m "refactor(services): add goal transaction boundary"
```

## 任务 3：收缩 SessionStore Goal 入口

**文件：**
- 修改：`packages/services/src/session-runtime/store.ts`
- 修改：`packages/services/src/session-runtime/__test__/session-goals.test.ts`
- 修改：`packages/services/src/session-runtime/__test__/store.test.ts`

- [ ] **步骤 1：固定 14 项兼容行为**

在 Goal 测试中通过 Store 旧 API 覆盖 create/get/current/update、request、assessment、continuation、start/finish/startup pause。保留现有 Goal + Run 事务测试。

- [ ] **步骤 2：运行兼容基线**

```powershell
pnpm --filter @vykor/services test -- session-goals store
```

- [ ] **步骤 3：构造并转发**

Store 增加 `readonly goals: GoalTransactions`。注入 `assertSession/assertMutableSession/getRun/appendEvent` 窄函数。删除 Store 中 Goal SQL、row conversion；14 个旧方法只转发。

- [ ] **步骤 4：验证并提交**

```powershell
pnpm --filter @vykor/services test
pnpm --filter @vykor/services check-types
git diff -- packages/services/src/session-runtime/schema.ts packages/services/src/session-runtime/migrations
git add packages/services/src/session-runtime packages/services/src/goals
git commit --no-verify -m "refactor(services): delegate goals from session store"
```

## 任务 4：迁移 Server Goal 调用

**文件：**
- 修改：`packages/server/src/application/session/session-goal-service.ts`
- 修改：`packages/server/src/application/session/session-run-engine.ts`
- 修改：`packages/server/src/application/session/session-run-executor.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改/创建相关 Goal 测试
- 修改：`docs/architecture-migration-status.md`
- 修改：`scripts/architecture-baseline.json`

- [ ] **步骤 1：编写 Server 失败测试**

用窄 Goal fake 验证 GoalService、RunEngine、RunExecutor 的实际 Goal 调用。真实 DaemonApplication 测试破坏 `store.pauseActiveGoalsOnStartup` 和一个旧读取方法，证明启动恢复及业务读取走 `store.goals`。

- [ ] **步骤 2：运行红灯**

```powershell
pnpm --filter @vykor/server test -- goal
```

- [ ] **步骤 3：迁移调用点**

各 context 增加 `goals: Pick<GoalOperations, ...>`；只替换 Goal 方法，不迁其他 Store 能力。Daemon startup 调用 `store.goals.pauseActiveGoalsOnStartup()`。

- [ ] **步骤 4：更新状态与基线**

将阶段 2D 标为完成。先运行 `pnpm check:architecture`，确认旧 Store Goal 调用下降后才执行 `--write-baseline`，不得提高其他指标。

- [ ] **步骤 5：最终验证、审查和提交**

```powershell
pnpm --filter @vykor/services test
pnpm --filter @vykor/server test -- goal
pnpm --filter @vykor/services check-types
pnpm --filter @vykor/server check-types
pnpm check:architecture
node scripts/check-docs.mjs
git diff --check
```

提交后派子代理只读审查；主代理修复所有 Critical/Important 并重新运行上述验证。

```powershell
git add packages/server/src/application docs/architecture-migration-status.md scripts/architecture-baseline.json
git commit --no-verify -m "refactor(server): depend on goal operations"
```

## 最终验收

- [ ] Goal 四组表 SQL 只存在于 goals 目录。
- [ ] GoalTransactions 实现 14 项公开能力，无额外 Facade。
- [ ] 所有写入在 atomic 内 fence。
- [ ] create/update/start/finish 事件与状态原子提交。
- [ ] 外层事务回滚当前内存和磁盘均无泄漏。
- [ ] Store 只转发；Server Goal 调用只走 `store.goals`。
- [ ] request、revision、额度、startup 和 continuation 行为不变。
- [ ] schema、migration、协议和 UI 不变。
