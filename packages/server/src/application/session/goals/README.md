# 会话目标推进

协调会话目标的启动、暂停、续跑和外部等待。

## 入口与流程

`SessionGoalService` 接收目标操作并安排下一次运行；等待核验器确认外部任务状态，观察器在等待条件变化时触发后续处理。

Run 正常结束、结构化交付状态、格式检查、宿主核验和 Goal 状态各自独立。`done` 不自动完成 Goal，`waiting` 不自动暂停或等待用户；Goal 仍按显式 `GoalUpdate`、预算和已有等待规则结算。如果同一 Run 的真实交付回执是 `partial`、`blocked` 或 `waiting`，却显式提交 `GoalUpdate.status=completed`，服务把 Goal 暂停，记录 `run_error` 并说明矛盾，供核对后续做。

## 状态归属

目标、评估和等待事实保存在目标与运行存储中，等待观察的订阅和计时器保存在服务实例中。交付回执来自运行事件投影器写入的 Run `metadata.delivery`，不从普通输出文字推断。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [goal-external-wait-observer.ts](./goal-external-wait-observer.ts) | `GoalWaitObservationResult`、`sameGoalExternalWait`、`GoalExternalWaitObserver` |
| [goal-wait-verifier.ts](./goal-wait-verifier.ts) | `GoalWaitCheck`、`GoalWaitVerifier` |
| [session-goal-service.ts](./session-goal-service.ts) | `SessionGoalService` |

## 测试与维护

会话目标调度与等待规则放在这里；面向 Agent 的目标工具放在 application/goals。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
