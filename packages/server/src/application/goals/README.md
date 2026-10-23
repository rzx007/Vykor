# 目标工具与运行贡献

为 Agent 提供目标读取、修改、策略和每次运行的目标上下文。

## 入口与流程

目标工具读取或修改持久目标；运行贡献模块生成当前运行所需的目标信息；模型尝试服务和策略约束目标执行。

## 状态归属

目标及评估事实通过传入的目标仓储保存，工具仅持有当前调用所需的上下文。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [goal-model-attempt-service.ts](./goal-model-attempt-service.ts) | `GoalModelAttemptServiceOptions`、`GoalModelAttemptService` |
| [goal-policy.ts](./goal-policy.ts) | `DEFAULT_GOAL_AUTO_TURNS` |
| [goal-read-tool.ts](./goal-read-tool.ts) | `GoalReadSnapshot`、`GOAL_READ_TOOL_NAME`、`formatGoalReadSnapshot`、`createGoalReadTool` |
| [goal-run-contribution.ts](./goal-run-contribution.ts) | `GoalRunBinding`、`createGoalRunContribution` |
| [goal-update-tool.ts](./goal-update-tool.ts) | `GOAL_UPDATE_TOOL_NAME`、`createGoalUpdateTool` |

## 测试与维护

面向工具的目标能力放在这里；会话目标的排队、续跑和等待核验放在 session/goals。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
