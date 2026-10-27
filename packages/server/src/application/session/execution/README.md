# 会话运行流程

负责输入准入、排队控制、运行组装与执行，以及工作目录变化和后台 Shell。

## 入口与流程

准入服务检查输入并创建或排队运行；控制服务处理推进、等待和中断；运行引擎与执行器获取 Agent、执行、结算，再触发审查及后续维护。

`assembleSessionRunServices` 创建运行引擎后，将同一个队列能力对象交给准入和控制服务；查询、取消、等待和补充输入直接连接引擎持有的 `SessionRunCoordinator`（按会话串行执行长任务的队列）。只有接纳模型运行的入口保留用户输入抢占自动审查的规则，重放和被拒后的补充输入恢复也经过此入口。引擎在实际执行前调用准入服务重新核实，再交给执行器；等待运行完成包括后续 Goal 结算。

插件界面操作通过引擎的 `enqueueHostWork` 加入同一个队列，共用排序、取消和等待；它不接收补充输入，也不执行模型或结算 Goal。`SessionOperationRunner` 仍单独串行处理准入时的状态操作，不持有长任务队列。两者的职责不合并。

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
| [tool-operation-review-service.ts](./tool-operation-review-service.ts) | 已认证宿主查看未知操作身份与有界预览，提交人工核对证据，保留原始审计 |
| [tool-result-service.ts](./tool-result-service.ts) | 将补读能力绑定当前运行和实际工具来源；每次检查会话、运行状态及权限版本 |
| [session-run-executor.ts](./session-run-executor.ts) | `SessionRunExecutorContext`、`ExecuteSessionRunInput`、`SessionRunExecutor` |
| [session-workspace-changes.ts](./session-workspace-changes.ts) | `WorkspaceChangeResult`、`WorkspaceBaselineResult`、`WORKSPACE_CAPTURE_BUDGET_MS`、`WORKSPACE_SETTLE_BUDGET_MS` 等 |

## 测试与维护

一次运行从接纳到完成的控制放在这里；输入内容解析放在 interactions，目标续跑放在 goals。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。

`ToolOperationService` 在同一存储事务内复核当前 owner、会话归属、运行是否仍接收派发，以及权限配置版本，再授权或记录实际派发。操作记录成功保存后，执行核心才调用工具；完整结果保存后才交付完成事件。运行开始时建立 Execution 头记录（一次运行的操作归属，不是续跑检查点）。

未获宿主明确验证的工具按 `non_replayable`（不承诺可安全重放）处理，不采信工具名、`safeToRetry` 或 MCP 提示。宿主若提供 `describe`，必须按实际捕获的定义身份或调用函数验证声明；只有明确声明的只读核对可穿过未知写入阻塞。未知危险操作阻止同一根会话及其子会话后续危险派发，包括新调用 ID、其他工具入口和新建兄弟子会话；无关根会话不受影响。结果未提交且所属运行已结束的 `dispatching` 操作也按未决操作阻塞，不必等到重启。取消或运行终态仍可保存属于当前 owner 的合法迟到回执，旧 owner 不可写入。`reconcile` 仅供授权宿主提交只读查询证据，没有对模型开放核对写入口。

S1 不提供重启续跑。默认来源身份含当前宿主捕获的实现身份；重启后的同名实现不会自动继承旧实现的重放承诺。

用户可为排队输入指定 `outputSchema`。准入前验证支持范围并固定快照，保存到 Input/Run 的既有 metadata；相同输入 ID 更换格式会冲突。执行器据此建立本轮 `outputContract`，完成投影保存 `metadata.delivery`。`steer` 与活跃子 Agent 的补充输入不能更换正在运行的合同。重试/重放沿用原输入合同，未配置时仍使用普通聊天。

新请求用 `validateOutputSchemaRequest` 处理显式字段，拒绝 metadata/runMetadata 隐式入口；保存快照使用 `outputSchemaMetadata`。执行、重放使用 `readStoredOutputSchema` 读取旧 Input/Run 快照并拒绝两者冲突，不迁移旧数据。编辑与 resume 的 HTTP 和客户端入口也使用显式字段。

`ToolResultService.forRun(scope, bindings)` 从当前实际工具集合建立只读补读能力。旧记录的来源必须与当前获准工具来源精确相符，历史实现版本不影响读取。每次查询重新检查应用 owner、精确会话、运行是否结束或取消、工作目录及权限配置版本；父子或兄弟会话不能互读。正文仍由 S1 操作记录保存，本服务不复制正文，也不重新执行原操作。

当前捕获的内置结果读取工具自身输出不进入 `list`，也不能通过推测引用再 `read/search`，避免查询结果逐层变成新的补读正文。识别依赖定义身份和执行函数，不按名称屏蔽普通替换工具。历史权限仍按工具名和来源核对：可信宿主以相同 builtin 来源更换实现时，视为同一授权来源；如需区分这类历史实现语义，需另行保存持久能力标记。

回执提交失败时，宿主立即按操作 ID 保存内存阻塞，即使所属运行仍显示运行中，也禁止同树其他运行新派发危险操作。已开始的调用仍可结算；只有对应操作成功保存确定结果，或可信核对确认已生效/未生效，才清除该项阻塞。一次成功结算不会清除其他操作的失败；重启后由持久 `dispatching` 记录转为未知继续保护。

结算成功、提交失败及人工核对后的状态判断只读取已有 `getSummary()` 摘要，不复制完整输入与结果。完整回执的保存、比较和显式读取仍保留原有复制规则。

`ToolOperationReviewService` 是宿主人工核对入口，通过 daemon 的窄 `toolOperationReview` 属性接到 HTTP。列表返回同根会话树的 unknown，以及原 Run 已结束但仍为 dispatching 的操作身份、状态和版本；按 ID 查询才返回各最多 4000 字符的输入及原始结果预览，以及最近 20 条有界证据。预览可能含原工具数据，仅供已认证宿主人工检查，不能作为模型指令，也不会自动写入模型上下文。

dispatching 尚不能提交人工结论。列表、详情和拒绝响应的 `recoveryHint` 提示先排查存储失败，等待实际调用结束，确认旧 daemon 停止后重启；经过既有启动恢复，再刷新记录进行核对。接口不在线释放这类记录，也不自动重放。

入口先检查当前 owner、服务是否接收请求及请求会话是否可用；提交时还检查操作属于同根树、原 Run 已结束、`expectedRevision` 一致，以及非空且不超过 8192 字符的 `evidence`。`unknown` 仅追加证据；`not_applied` 解除该操作的未知状态；`applied` 没有经人工核实的明确 completed 结果时仍是 unknown。提供的结果最多 65536 字符，身份必须匹配原操作。原 Attempt 的未知结果与审计记录保留，所有核对都不会自动重试工具。

具体 HTTP 调用（地址、token、sessionId 和 operationId 替换为当前值；协议版本用 `/capabilities` 返回的 `protocol.version`）：

```sh
curl -H "Authorization: Bearer TOKEN" -H "x-vykor-protocol-version: VERSION"   "http://127.0.0.1:PORT/sessions/SESSION/tool-operations"
curl -H "Authorization: Bearer TOKEN" -H "x-vykor-protocol-version: VERSION"   "http://127.0.0.1:PORT/sessions/SESSION/tool-operations/OPERATION"
curl -X POST -H "Authorization: Bearer TOKEN" -H "x-vykor-protocol-version: VERSION"   -H "Content-Type: application/json"   -d '{"expectedRevision":4,"outcome":"not_applied","evidence":"人工只读查询确认目标记录不存在"}'   "http://127.0.0.1:PORT/sessions/SESSION/tool-operations/OPERATION/reconcile"
```

POST 返回新的有限操作信息。若返回 409，重新读取详情并核对新版本，不能沿用旧修订号自动重提；若 `applied` 只有存在性证据，可省略 result 并保留 unknown，等待真实完成回执。

工具超时或取消后，原调用可能仍在本进程执行。`ToolOperationService` 按 Core 登记的实际调用 Promise 暂存未结束操作；此时即使 Run 已终态，也拒绝 `applied` 和 `not_applied`，只允许追加 `unknown` 证据。调用实际返回或拒绝后才移除该保护，正常返回 unknown 不会永久占用它。此追踪不持久化，也不从工具结果 metadata 推断；重启后仍按持久未知状态核对。

活跃父会话可以查看并核对已归档子会话留下的未知操作，只要仍属同一根树且原 Run 已结束；归档不会移除未知写入阻断。请求入口会话本身仍须可用，正在关闭的目标会话不可核对。危险派发被阻断时，错误包含首个未决操作 ID 和同根会话的 GET 核对地址，不包含输入或结果正文。
