# 会话运行流程

负责输入准入、排队控制、运行组装与执行，以及工作目录变化和后台 Shell。

## 入口与流程

准入服务检查输入并创建或排队运行；控制服务处理推进、等待和中断；运行引擎与执行器获取 Agent、执行、结算，再触发审查及后续维护。

## 状态归属

输入和运行结果通过存储保存；活跃 Agent、取消信号与计时器由注入的运行资源及本目录服务持有。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [background-shell-service.ts](./background-shell-service.ts) | `BackgroundShellSessionQueries`、`BackgroundShellTaskOperations`、`BackgroundShellStore`、`BackgroundShellError` 等 |
| [run-admission-service.ts](./run-admission-service.ts) | `AdmitPromptInput`、`AdmitPromptResult`、`RunAdmissionSessionQueries`、`RunAdmissionConversationTransactions` 等 |
| [run-admission-work.ts](./run-admission-work.ts) | `inputItems`、`admitPromptWork` |
| [run-auto-review.ts](./run-auto-review.ts) | `captureAutoReviewBaseline`、`reviewAutoReview`、`settleUnreviewedAutoReview` |
| [run-control-service.ts](./run-control-service.ts) | `RunControlDurableSessions`、`RunControlDurableRuns`、`RunControlDurableInputs`、`RunControlRuntime` 等 |
| [run-stall-watchdog.ts](./run-stall-watchdog.ts) | `RunStallWatchdogOptions`、`RunStallWatchdog` |
| [session-run-assembly.ts](./session-run-assembly.ts) | `SessionRunAssemblyOptions`、`assembleSessionRunServices` |
| [session-run-engine.ts](./session-run-engine.ts) | `SessionRunEngineContext`、`SessionRunEngine` |
| [session-run-executor-assembly.ts](./session-run-executor-assembly.ts) | `SessionRunExecutorAssemblyOptions`、`assembleSessionRunExecutor` |
| [session-run-executor.ts](./session-run-executor.ts) | `SessionRunExecutorContext`、`ExecuteSessionRunInput`、`SessionRunExecutor` |
| [session-workspace-changes.ts](./session-workspace-changes.ts) | `WorkspaceChangeResult`、`WorkspaceBaselineResult`、`WORKSPACE_CAPTURE_BUDGET_MS`、`WORKSPACE_SETTLE_BUDGET_MS` 等 |

## 测试与维护

一次运行从接纳到完成的控制放在这里；输入内容解析放在 interactions，目标续跑放在 goals。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
