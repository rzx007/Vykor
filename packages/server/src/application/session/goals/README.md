# 会话目标推进

协调会话目标的启动、暂停、续跑和外部等待。

## 入口与流程

`SessionGoalService` 接收目标操作并安排下一次运行；等待核验器确认外部任务状态，观察器在等待条件变化时触发后续处理。

## 状态归属

目标、评估和等待事实保存在目标与运行存储中，等待观察的订阅和计时器保存在服务实例中。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [goal-external-wait-observer.ts](./goal-external-wait-observer.ts) | `GoalWaitObservationResult`、`sameGoalExternalWait`、`GoalExternalWaitObserver` |
| [goal-wait-verifier.ts](./goal-wait-verifier.ts) | `GoalWaitCheck`、`GoalWaitVerifier` |
| [session-goal-service.ts](./session-goal-service.ts) | `SessionGoalService` |

## 测试与维护

会话目标调度与等待规则放在这里；面向 Agent 的目标工具放在 application/goals。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
