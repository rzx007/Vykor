# 目标记录与事务

保存会话目标、版本、执行请求、等待与模型尝试用量。

## 入口与流程

GoalRepository 查询目标事实，GoalTransactions 协调目标变更和相关运行；版本与用量模块记录正文修订、实际模型尝试和预算状态。

## 状态归属

正式会话的目标事实位于 SQLite，临时会话通过共享临时控制记录保存；推进目标的运行由应用层负责。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [goal-records.ts](./goal-records.ts) | `CreateSessionGoalStoreInput`、`UpdateSessionGoalStoreInput`、`SessionGoalRequestRecord` 等 |
| [goal-repository.ts](./goal-repository.ts) | `GoalRepository` |
| [goal-transactions.ts](./goal-transactions.ts) | `GoalOperations`、`GoalTransactionsOptions`、`GoalTransactions` |
| [goal-usage.ts](./goal-usage.ts) | `GoalAttemptStart`、`GoalAttemptReport`、`GoalModelAttemptRow` 等 |
| [goal-version.ts](./goal-version.ts) | `getGoalVersion`、`listGoalVersions`、`beginGoalVersion` |
| [index.ts](./index.ts) | 汇总本分类的接口 |

## 测试与维护

目标的记录转换、查询、版本、用量及事务放在这里，模型与 Agent 的实际执行由宿主提供。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
