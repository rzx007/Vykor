# 架构重组迁移状态

> 状态：当前。阶段 0–1、阶段 2A、阶段 2B、阶段 2C1、阶段 2C2、阶段 2D 和阶段 2E 已完成。

## 当前阶段

阶段 0–1、阶段 2A、阶段 2B、阶段 2C1、阶段 2C2、阶段 2D 和阶段 2E 已完成：依赖护栏、Session SQLite 数据库内核、Project、Schedule、Workflow、Channel、Goal 与 Permission 边界已经落地。

## 指标

- `scripts/architecture-baseline.json` 是旧入口调用的只减不增基线。
- `pnpm check:architecture` 检查禁止的 package 依赖方向，并比较当前生产代码调用数。
- 基线只能在调用数实际下降时通过 `node scripts/architecture-boundaries.mjs --write-baseline` 更新；禁止为了通过检查提高数字。

## 当前所有权

`SessionStore` 暂时仍拥有多数业务方法和公开兼容接口。SQLite 生命周期、read model、mutation buffer、event sequence 和 delta checkpoint 已迁入 `packages/services/src/database`，并由一个 `StorageContext` 持有。

Project SQL、路径规则和写操作已迁入 `packages/services/src/projects`。`SessionStore` 保留八个兼容转发方法，Server 的 `ProjectApplicationService` 只依赖七个 Project 动作的窄 capability。`StorageContext.atomic()` 仍由 Store 的 transaction coordinator 临时提供，在 Store 退场前必须把该协调器迁入 database 内核。

Scheduled Task/Run SQL 和 row conversion 已迁入 `packages/services/src/schedules`。`SessionStore` 保留十个兼容转发方法；Server 的 `ScheduledTaskService` 只依赖九个实际使用的 Schedule 操作，计时器和 Agent 执行策略仍由 Server 拥有。

Workflow Run/Event/Claim SQL 和 row conversion 已迁入 `packages/services/src/workflows`，retention 跨域清理 SQL 暂留 Maintenance 路径。Server Workflow adapter 只依赖 Workflow 存储与 session event 窄能力，并使用进程内 change version 防止 event-only wait 注册竞态。

External Conversation 与 Channel Delivery SQL 和 row conversion 已迁入 `packages/services/src/channels`。`SessionStore` 保留八个兼容转发方法；Server Channel application service 只通过 `store.channels` 执行 Channel 持久化，Session/Input 查询仍使用窄 Store 能力。

Goal 四组表 SQL 和 row conversion 已迁入 `packages/services/src/goals`，跨 Session、Run 与 durable event 的规则由 `GoalTransactions` 原子执行。`SessionStore` 保留十四个兼容转发方法；Server 的 Goal 调用统一经过 `store.goals`。

Permission read model、状态转换和 durable event 已迁入 `packages/services/src/permissions`。`SessionStore` 保留五个兼容转发方法；Server Broker 只依赖 Permission、Session lineage 和 event cursor 窄能力，live resolver 与授权复用策略仍由 Server 持有。

## 下一步

阶段 2F 处理 Attachment；完成后统一收尾阶段 2。
