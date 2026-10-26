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
| [tool-operation-service.ts](./tool-operation-service.ts) | 将操作记录和强制规则接到当前 owner、会话和运行；提供只读证据核对入口 |
| [session-run-executor.ts](./session-run-executor.ts) | `SessionRunExecutorContext`、`ExecuteSessionRunInput`、`SessionRunExecutor` |
| [session-workspace-changes.ts](./session-workspace-changes.ts) | `WorkspaceChangeResult`、`WorkspaceBaselineResult`、`WORKSPACE_CAPTURE_BUDGET_MS`、`WORKSPACE_SETTLE_BUDGET_MS` 等 |

## 测试与维护

一次运行从接纳到完成的控制放在这里；输入内容解析放在 interactions，目标续跑放在 goals。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。

`ToolOperationService` 在同一存储事务内复核当前 owner、会话归属、运行是否仍接收派发，以及权限配置版本，再授权或记录实际派发。操作记录成功保存后，执行核心才调用工具；完整结果保存后才交付完成事件。运行开始时建立 Execution 头记录（一次运行的操作归属，不是续跑检查点）。

默认工具都按 `non_replayable`（不承诺可安全重放）处理，不采信工具名、`safeToRetry` 或 MCP 提示。宿主若提供 `describe`，必须按实际捕获的定义身份或调用函数验证声明；只有明确声明的只读核对可穿过未知写入阻塞。未知危险操作阻止同一根会话及其子会话后续危险派发，包括新调用 ID、其他工具入口和新建兄弟子会话；无关根会话不受影响。结果未提交且所属运行已结束的 `dispatching` 操作也按未决操作阻塞，不必等到重启。取消或运行终态仍可保存属于当前 owner 的合法迟到回执，旧 owner 不可写入。`reconcile` 仅供授权宿主提交只读查询证据，没有对模型开放核对写入口。

S1 不提供重启续跑。默认来源身份含当前宿主捕获的实现身份；重启后的同名实现不会自动继承旧实现的重放承诺。

回执提交失败时，宿主立即按操作 ID 保存内存阻塞，即使所属运行仍显示运行中，也禁止同树其他运行新派发危险操作。已开始的调用仍可结算；只有对应操作成功保存确定结果，或可信核对确认已生效/未生效，才清除该项阻塞。一次成功结算不会清除其他操作的失败；重启后由持久 `dispatching` 记录转为未知继续保护。
