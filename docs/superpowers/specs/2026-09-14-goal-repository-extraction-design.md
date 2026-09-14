# Goal Repository 与跨域事务提取设计

> 状态：当前。阶段 2D 的实施规格。

## 背景

Goal 持久化目前集中在 `SessionStore`，覆盖 Goal、request、assessment、continuation 四组表，并与 Session、Run、durable event 和 owner fence 交叉。它不像 Project 或 Schedule 那样能整体作为单一表域搬入 Repository；若让 Repository 直接认识完整 Session/Run/event，会把万能 Store 换成万能 Repository。

## 目标

- `GoalRepository` 唯一拥有 Goal 四组表的 SQL 和 row conversion。
- 具名 Goal transaction scripts 拥有跨 Session、Run、event 的原子业务规则。
- `SessionStore` 原有 Goal 方法只保留兼容转发。
- Server Goal service、Run engine 和 Run executor 依赖窄 Goal capability。
- 保持 request 幂等、revision 乐观锁、自动续跑额度、启动恢复和事件行为不变。
- 不修改 schema、migration、协议或 UI。

## 非目标

- 不重新设计 Goal 状态机、完成评估或等待策略。
- 不移动 Server 的自动续跑、用户优先级或 timer 逻辑。
- 不把 Run/Session Repository 提前纳入阶段 2D。
- 不增加通用 domain framework、factory 或单实现 interface。

## 目标结构

```text
packages/services/src/goals/
├─ goal-records.ts
├─ goal-repository.ts
├─ goal-transactions.ts
├─ goal-repository.test.ts
├─ goal-transactions.test.ts
└─ index.ts
```

## GoalRepository

Repository 直接使用 `StorageContext.database.connection`，只处理本域表：

- `getGoal()`、`getCurrentGoal()`；
- `insertGoal()`、`updateGoalRevision()`、`clearCurrentRun()`、`bindCurrentRun()`；
- `getRequest()`、`beginRequest()`、`settleRequest()`；
- `recordAssessment()`、`evidenceSignatures()`；
- `recordContinuation()`、`markContinuation()`、`cancelPendingContinuations()`；
- `listActiveGoalIds()`。

Repository 不读取 Session read model、不读取 Run、不写 durable event，也不调用 Store。

### Records

`goal-records.ts` 负责：

- Goal row → `SessionGoal`；
- request row → `SessionGoalRequestRecord`；
- wait/evidence/assessment/result JSON 解析。

JSON 行为保持当前严格程度：数据库中非空 JSON 语法错误继续抛错，不增加 fallback；SQL NULL 仍映射为字段缺失。

## GoalTransactions

Goal 跨域能力使用一个具体类，不建立通用事务脚本框架：

```ts
export class GoalTransactions {
  constructor(options: {
    storage: StorageContext
    repository: GoalRepository
    assertSession(sessionId: string): SessionRecord
    assertMutableSession(session: SessionRecord): void
    getRun(runId: string): SessionRunRecord | undefined
    appendEvent(input: AppendEventInput): SessionEventRecord
    assertCurrentOwner(): void
  })
}
```

这些窄函数由 Store 组合时注入。GoalTransactions 不持有 Store 实例。

它拥有以下跨域操作：

- `createGoal()`；
- `updateGoal()`；
- `startGoalRun()`；
- `finishGoalRun()`；
- `pauseActiveGoalsOnStartup()`。

单表 request、assessment、continuation 操作可以由 Goal facade 直接调用 Repository，但仍在写入前执行 owner fence。

## Goal Facade

Store 暴露：

```ts
readonly goals: GoalOperations
```

`GoalOperations` 是一个具体组合对象，对外提供与当前 Store Goal 方法一致的 15 项能力。跨域方法委托 `GoalTransactions`，表内方法委托 `GoalRepository` 并统一执行 owner fence。

这使 Server 可以依赖 `store.goals`，而 `SessionStore` 原方法只做同名转发。Facade 不拥有 SQL，也不复制状态机。

## 关键流程

### 创建 Goal

1. owner fence；
2. 从 read model 取得 Session 并校验可修改；
3. 在 `storage.atomic()` 中插入 Goal；
4. 写 `session.goal.created` durable event；
5. 任一步失败则 Goal 与 event 一起回滚。

Server 外层仍可把 Goal、首次 input 和 Run 包在同一个 `store.transaction()` 中；嵌套 atomic 继续参与最外层提交。

### Revision 更新

1. 读取当前 Goal；
2. expectedRevision 不一致立即拒绝；
3. 构造 next 值，明确区分 `undefined` 与 `null`；
4. SQL 使用 `WHERE id = ? AND revision = ?` 再做一次并发保护；
5. 同一 atomic 中写 `session.goal.updated`；
6. SQL 或 event 失败时全部回滚。

### Start Goal Run

在同一 atomic 中验证：

- Goal 存在且 status=active；
- Goal revision 与 Run 绑定 revision 一致；
- Run 存在、属于同一 Session，且为 pending/running；
- 同一 run 重试幂等返回 true；
- automatic 达到额度时将 Goal pause、清 currentRunId、写更新事件并返回 false；
-成功绑定时只增加 accounting，不增加 objective revision。

### 启动恢复

1. owner fence；
2. 查询 active Goal IDs；
3. 对每个 Goal 通过 revision update 设 paused、清 currentRunId、写原因与事件；
4. 取消全部 pending continuation；
5. 整体 atomic，失败时不允许部分 Goal 已暂停、部分仍 active。

## 不变量

- 同一 Session 最多一个开放 Goal，继续依赖现有唯一索引。
- requestId 同 fingerprint 重试返回原记录，不同 Session/fingerprint 抛 `session_goal_request_conflict`。
- expectedRevision 与 SQL revision 双重检查保持不变。
- Goal 更新事件与对应状态同事务。
-旧 revision、跨 Session Run、terminal Run 不能绑定 Goal。
-自动续跑计数只在 automatic start 成功时增加。
-达到额度时暂停而不是继续启动。
- assessment `(goalId, revision, runId)` upsert 幂等。
- continuation `(goalId, revision, previousRunId)` insert-or-ignore 幂等。
-启动恢复取消 pending continuation，并保留 waiting_user/blocked/paused/terminal Goal。
- owner fence 覆盖所有 Goal 写入。

## Server 边界

`SessionGoalService`、`SessionRunEngine`、`SessionRunExecutor` 的 context 使用 `GoalOperations` 的窄 Pick，不再通过完整 Store 调用 Goal 方法。它们仍可通过 Store 使用 Session/Run/transaction 等其他尚未迁移的能力。

Daemon composition 注入同一个 `store.goals`。阶段 2D 不要求一次移除这些类对 Store 的全部依赖，只禁止新增 `store.<goalMethod>()`。

## 测试

### Repository

- Goal/request/assessment/continuation 的磁盘重载；
- request 幂等与 fingerprint/session 冲突；
- assessment upsert 与 evidence signatures；
- continuation insert-or-ignore 与状态更新；
-严格 JSON 解析行为；
-返回对象隔离。

### Transactions

- create/update 的 event 原子回滚；
- revision 冲突和 null/undefined patch；
- start run 的归属、状态、revision、幂等和额度分支；
- finish run 的无匹配 no-op 与更新事件；
-启动恢复只暂停 active，并在故障注入时整体回滚；
-嵌入外层 `store.transaction()` 的 Goal + input + Run 提交/回滚。

### Store 与 Server

- Store 原 Goal API 兼容转发；
-现有 session-goals、Goal service、run engine/executor 测试保持通过；
-窄 fake 验证 Server 的 Goal 调用；
-真实 Daemon composition 证明使用 `store.goals`，破坏旧 Store Goal 方法后业务仍可读取或执行。

## 实施顺序

1. 提取 records 与纯 SQL Repository；
2. 实现 GoalTransactions 与 fault-injection 测试；
3. 组合 Goal facade，收缩 Store 兼容方法；
4. 迁移 Server 三个调用方到窄 Goal capability；
5. 更新架构基线和迁移状态；
6. Services/Server 全量相关测试、类型、架构和文档验证；
7. 独立子代理只读审查，主代理修订后重新验证。

## 验收标准

- Goal 四组表 SQL 与 row conversion 只存在于 `packages/services/src/goals`。
-跨域 Goal 规则只存在于 `GoalTransactions`。
- Store Goal 方法只转发，Server Goal 调用只通过 `store.goals`。
- request/revision/startup/event/owner 不变量有自动测试。
- schema、migration、协议和 UI 无变化。
-架构基线下降，工作区干净。
