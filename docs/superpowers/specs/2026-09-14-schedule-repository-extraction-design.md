# Schedule Repository 提取设计

> 状态：当前。阶段 2B 的实施规格。

## 背景

阶段 2A 已用 Project 验证 Repository、`SessionStore` 兼容转发和 Server 窄 capability 的迁移模式。Schedule 是下一项低耦合存储域：Scheduled Task 和 Scheduled Run 全部直接读写 SQLite，不进入 Session read model；Server 的 `ScheduledTaskService` 负责计时、触发和完成策略，但目前依赖完整 `SessionStore`。

## 目标

- 建立唯一的 `ScheduleRepository` 存储入口。
- 从 `SessionStore` 移出 Scheduled Task/Run SQL 和 row conversion。
- 保留 Store 原有十个方法作为兼容转发。
- 让 `ScheduledTaskService` 依赖窄 `ScheduleOperations`。
- 保持 schema、migration、协议、排序、默认值和恢复行为不变。

## 非目标

- 不移动计时器、重叠策略、missed-run、recurrence 计算或 Agent 执行逻辑。
- 不拆分 Scheduled Task 与 Run 为两个 Repository。
- 不增加 interface/factory 到 Services。
- 不修改 Desktop、Client 或 HTTP API。

## 目标结构

```text
packages/services/src/schedules/
├─ recurrence.ts
├─ schedule-records.ts
├─ schedule-repository.ts
├─ schedule-repository.test.ts
└─ index.ts
```

现有 `recurrence.ts` 保持职责不变。

## ScheduleRepository

```ts
export class ScheduleRepository {
  constructor(private readonly storage: StorageContext)

  createTask(input: CreateScheduledTaskInput): ScheduledTaskRecord
  getTask(id: string): ScheduledTaskRecord | undefined
  listTasks(options?: { status?: ScheduledTaskRecord["status"] }): ScheduledTaskRecord[]
  updateTask(id: string, patch: UpdateScheduledTaskInput): ScheduledTaskRecord
  deleteTask(id: string): boolean

  createRun(input: CreateScheduledRunInput): ScheduledRunRecord
  getRun(id: string): ScheduledRunRecord | undefined
  listRuns(options?: { taskId?: string; unread?: boolean; limit?: number }): ScheduledRunRecord[]
  updateRun(id: string, patch: UpdateScheduledRunInput): ScheduledRunRecord
  interruptActiveRuns(reason: string): number
}
```

Repository 直接使用 `storage.database.connection`。该域不修改 read model 或 mutation buffer，因此不使用 `storage.atomic()`；需要多 SQL 原子性的 `deleteTask()` 使用 better-sqlite3 自身的 transaction。

## Records

`schedule-records.ts` 拥有：

- `scheduledTaskFromRow()`；
- `scheduledRunFromRow()`；
- 容错 JSON 解析；
- patch 合并时过滤 `undefined`。

JSON 兼容精确保持现状：SQL NULL、其他非字符串值和语法错误 JSON 使用 fallback；合法但类型不符的 JSON（例如 `null` 或 `{}` 出现在数组列）继续按当前宽松转换透传，不新增 shape 校验。project/skill/plugin 的 fallback 是空数组，permission profile 的 fallback 是 `{ mode: "workspace_write" }`。`stop_policy_json` 为 SQL NULL 时省略字段；非空但语法错误时保留 `stopPolicy: {}`。

## 数据与事务规则

- Task 创建保留当前默认状态、execution mode、overlap/missed-run policy 和 createdBy。
- Task update 中 `undefined` 表示不修改，`lastRunAt/nextRunAt: null` 表示清空。
- 删除 Task 与其所有 Scheduled Run 在一个 SQLite transaction 中完成；测试用 trigger 阻止第二条 Task DELETE，证明第一条 Runs DELETE 也会回滚。
- 创建 Run 前检查 Task 存在；不存在时保持当前错误。
- Run list 保持现有 limit 行为：默认 50，零或负数变为 1，大于 500 变为 500；本阶段不新增整数、`NaN` 或 `Infinity` 校验。
- `interruptActiveRuns()` 只更新 queued/running，设置 interrupted、error、unread、finishedAt 和 updatedAt。
- 所有读结果均由 row conversion 新建，调用方修改返回对象不会影响后续读取。

## SessionStore 兼容边界

Store 增加：

```ts
readonly schedules: ScheduleRepository
```

原有十个方法只转发到 Repository。Store 中删除 Scheduled Task/Run SQL、row conversion 和仅为 Schedule patch 使用的 `withoutUndefined()`。

## Server 边界

`ScheduledTaskService` 保留业务编排，只把 `options.store` 替换成：

```ts
interface ScheduleOperations {
  createTask(input: CreateScheduledTaskInput): ScheduledTaskRecord
  getTask(id: string): ScheduledTaskRecord | undefined
  listTasks(options?: { status?: ScheduledTaskRecord["status"] }): ScheduledTaskRecord[]
  updateTask(id: string, patch: UpdateScheduledTaskInput): ScheduledTaskRecord
  deleteTask(id: string): boolean
  createRun(input: CreateScheduledRunInput): ScheduledRunRecord
  listRuns(options?: { taskId?: string; unread?: boolean; limit?: number }): ScheduledRunRecord[]
  updateRun(id: string, patch: UpdateScheduledRunInput): ScheduledRunRecord
  interruptActiveRuns(reason: string): number
}
```

Daemon composition 注入 `store.schedules`。Server capability 不包含 Service 未使用的 `getRun()`；Repository 和 Store 仍保留该方法作为存储与兼容 API。计时器安装、trigger、execute、skip、finish 和 shutdown 逻辑不移动。

## 测试

Repository 使用真实 SQLite，覆盖：

- Task 默认值、JSON 字段和磁盘重载，包括非字符串/语法错误 fallback、合法错误类型透传和坏 stop policy 得到 `{}`；
- status 过滤、排序、update 的 undefined/null；
- Task/Run 不存在错误；
- Run 创建、过滤、unread 和 limit；
- Task 删除连同 Runs 的成功路径，以及用 trigger 阻止 Task DELETE 后两类记录均保留的失败路径；
- `interruptActiveRuns()` 将 queued/running 持久化为 interrupted 且不改终态；
- 返回对象隔离。

Store 保留一组旧 API 兼容测试。Server 测试用窄 fake 验证全部九个实际调用，并用真实 DaemonApplication 证明 composition 使用 `store.schedules` 而不是 Store 平铺方法。另用有序调用记录证明 `ScheduledTaskService` 构造时先调用 `interruptActiveRuns()`，再调用 `listTasks()` 和安装 timer；启动恢复顺序不由 Repository 测试代替。

## 验收标准

- `ScheduleRepository` 是 Scheduled Task/Run SQL 的唯一所有者。
- Store 十个 Schedule 方法只转发。
- `ScheduledTaskService` 不依赖完整 SessionStore。
- 删除、恢复、JSON、limit、null 清空行为有自动测试。
- schema、migration、HTTP/SSE 和根公共导出不变。
- Services、Server、架构和文档检查通过。
- 旧 Store 平铺调用基线继续下降。
