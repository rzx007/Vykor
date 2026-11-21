# 会话运行流程

负责输入准入、排队控制、运行组装与执行，以及工作目录变化和后台 Shell。

## 入口与流程

准入服务检查输入并创建或排队运行；控制服务处理推进、等待和中断；运行引擎与执行器获取 Agent、执行、结算，再触发审查及后续维护。

`assembleSessionRunServices` 创建运行引擎后，将同一个队列能力对象交给准入和控制服务；查询、取消、等待和补充输入直接连接引擎持有的 `SessionRunCoordinator`（按会话串行执行长任务的队列）。只有接纳模型运行的入口保留用户输入抢占自动审查的规则，重放和被拒后的补充输入恢复也经过此入口。引擎在实际执行前调用准入服务重新核实，再交给执行器；等待运行完成包括后续 Goal 结算。

插件界面操作通过引擎的 `enqueueHostWork` 加入同一个队列，共用排序、取消和等待；它不接收补充输入，也不执行模型或结算 Goal。`SessionOperationRunner` 仍单独串行处理准入时的状态操作，不持有长任务队列。两者的职责不合并。

普通提示的首行以 `observe-session` 指定目标会话时，接纳服务将目标会话 ID 和当时选中的运行 ID 写入当前消息新建的运行记录。工具规则允许时，执行器向这一轮提供 `SessionObserve`，并在调用和返回前检查当前规则。用户入口见[跨会话进度观察](../../../../../../docs/product-surface-integration.md#在当前对话观察另一条会话)。

工具从已有运行和审批记录读取状态，按固定的运行 ID 查找直接关联的待审批和待回答请求。默认立即返回状态摘要。请求等待时，通过现有事件流接收变化，最长等待 30 秒。目标启动下一轮时，状态摘要仍指向接纳时选中的那一轮。

普通 HTTP 提示新建的合格排队 Run 还可通过 `SessionLookup` 按标题查询状态。接纳时在本轮记录中保存查询标记。执行器凭标记调用工具工厂，由工厂核对实际会话和输入资格，调用继续经过普通工具审批。查询从来源会话保存的工作目录查找可用持久根会话，返回标题、运行状态和更新时间。查询结果是当时的状态，精确等待仍需单独指定观察目标。

### 普通任务收尾验收

在桌面聊天输入 `/`，选择 `/check`（收尾验收）。接着填写一条可在当前工作区运行的命令，按 `Shift+Enter` 换行写任务。验收任务需要单独运行。当前会话忙时，桌面会把 `/check` 消息排队。如果正在查看活动子 Agent 的对话，请在普通对话发送验收任务。

```text
/check pnpm --filter @vykor/core check-types
修复查询引擎的类型错误。
```

Agent 准备交付时，后台按当前会话的 Shell 权限在同一次运行中执行命令。退出码为 0 后才交付最终回复。命令返回非零退出码时，Agent 可以根据输出返工一次，最多使用四个模型回合。返工产生新工具结果后可以再次验收。每次命令执行最多 60 秒，检查无法正常退出时可查看对应 Shell 结果。

重放旧消息时也支持 `验收命令:` 格式。

## 状态归属

输入和运行结果通过存储保存；活跃 Agent、取消信号与计时器由注入的运行资源及本目录服务持有。

普通权限与审批通过后，执行入口调用当前 Run 的 `checkToolDispatch`，核对 owner、会话、Run、输入归属、cwd、最终工具绑定和运行修订。检查失败终止本 Run；工具普通错误与 unknown 只反馈本次调用，不限制其他新调用，也不自动重试。实际调用 Promise 一直跟踪到工具真正结束。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [background-shell-service.ts](./background-shell-service.ts) | `BackgroundShellSessionQueries`、`BackgroundShellTaskOperations`、`BackgroundShellStore`、`BackgroundShellError` 等 |
| [completion-check-command.ts](./completion-check-command.ts) | 识别并校验首行的验收命令，要求该任务在普通对话单独运行 |
| [run-admission-service.ts](./run-admission-service.ts) | `AdmitPromptInput`、`AdmitPromptResult`、`RunAdmissionSessionQueries`、`RunAdmissionConversationTransactions` 等 |
| [run-admission-work.ts](./run-admission-work.ts) | `inputItems`、`admitPromptWork` |
| [run-auto-review.ts](./run-auto-review.ts) | `captureAutoReviewBaseline`、`reviewAutoReview`、`settleUnreviewedAutoReview` |
| [run-control-service.ts](./run-control-service.ts) | `RunControlDurableSessions`、`RunControlDurableRuns`、`RunControlDurableInputs`、`RunControlRuntime` 等 |
| [run-stall-watchdog.ts](./run-stall-watchdog.ts) | `RunStallWatchdogOptions`、`RunStallWatchdog` |
| [session-discovery-tool.ts](./session-discovery-tool.ts) | 按工作目录和已保存标题查询会话状态 |
| [session-observation-grant.ts](./session-observation-grant.ts) | 首行指令、目标选择和每轮授权 |
| [session-observation-tool.ts](./session-observation-tool.ts) | 只读状态、人工待办和短时等待 |
| [session-run-assembly.ts](./session-run-assembly.ts) | `SessionRunAssemblyOptions`、`assembleSessionRunServices` |
| [session-run-engine.ts](./session-run-engine.ts) | `SessionRunEngineContext`、`SessionRunEngine` |
| [session-run-executor-assembly.ts](./session-run-executor-assembly.ts) | `SessionRunExecutorAssemblyOptions`、`assembleSessionRunExecutor` |
| [tool-result-service.ts](./tool-result-service.ts) | 将补读能力绑定当前运行和实际工具来源；每次检查会话、运行状态及权限版本 |
| [session-run-executor.ts](./session-run-executor.ts) | `SessionRunExecutorContext`、`ExecuteSessionRunInput`、`SessionRunExecutor` |
| [session-workspace-changes.ts](./session-workspace-changes.ts) | `WorkspaceChangeResult`、`WorkspaceBaselineResult`、`WORKSPACE_CAPTURE_BUDGET_MS`、`WORKSPACE_SETTLE_BUDGET_MS` 等 |

## 测试与维护

一次运行从接纳到完成的控制放在这里；输入内容解析放在 interactions，目标续跑放在 goals。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。

`tool-dispatch-check.ts` 的工厂绑定当前范围及最终工具对象，不落盘。`ToolResultService.forRun(scope, bindings)` 保存已返回正文，并按当前 owner、Run、运行修订和来源权限提供 list/read/search。父子和兄弟会话不自动互读，补读工具自身不归档。

`tool_result` 保存失败终止当前 Run，不改写已知 completed 事实、不重试工具，也不形成其他 Run 的封锁记录。超时后的工具仍由 Runtime 等待真实结束，不补记迟到审计。

## 共用执行核心（阶段 A）

BackgroundShellService 只核对会话、提供 SQLite 预留/读取/保存和环境获取端口。进程启动、去重、启动中取消与环境释放归 supervisor；不再保存独立 starting 或 lease 目录。

`tool-dispatch-check.ts` 为每个 Run 绑定执行前检查，验证当前 owner、运行状态、输入、目录和最终工具绑定；自身不保存状态。
