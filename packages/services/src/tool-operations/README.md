# 工具操作记录

`SessionStore.toolOperations` 在调用工具前保存操作身份、授权版本和实际尝试，在调用后保存完整结果。主要实现为 [tool-operation-repository.ts](tool-operation-repository.ts)，公开入口为 [index.ts](index.ts)。

[commands.ts](commands.ts) 的 `StoredToolOperationIntent` 只接收运行身份、工具名称与输入等数据；完整框架意图可按结构传入，但捕获的工具绑定、函数和执行环境不进入存储合同。可选 signal 只检查本次取消，不持久化。

宿主先调用 `prepare`，传入可信工具来源版本 `toolIdentity`、操作类型及可选业务键；未声明类型按不能安全重放处理，声明幂等写入必须提供稳定业务键。相同 session、Run、generationId 和 toolCallId 只准备一次；参数、工具来源或父操作变化报冲突。generationId 由宿主标识模型回合，因此不同回合复用 provider 调用 ID 仍是独立操作；显式 runTool 不提供回合身份时保留同 ID 重投语义。SQLite 的 logical_call_id 保存回合与原调用 ID 的组合，原始 ID 留在记录和结果中。traceId 只用于审计。

`authorize` 记录当前强制规则版本；`dispatch` 再检查操作修订、规则版本、owner、会话、Run 和未知写操作阻塞，随后保存独立 Attempt 并返回派发回执。工具实际调用由 core 负责。`settle` 检查回执及结果身份，保存完整结果；重复相同结果可重复提交，不同结果不能覆盖已确认结果。`reject` 只接受可信执行层的失败且未启动结果，派发前中断记为 cancelled，其余拒绝记为 rejected。所有方法同步提交，Server 将其适配为异步 Gate。

未知写操作阻止同一会话后续危险派发，换工具或新建操作不能绕过，只读工具仍可核对。`reconcile` 仅供可信宿主传入只读查询的非空证据；不能从错误文本推断未生效。核对为 `not_applied` 后，经过当前授权才可创建新的 Attempt。确认已生效需要可信完整结果，缺失结果时保持 unknown。每次核对证据追加到操作及原尝试，保留历史。

启动时宿主确认旧 owner 失活，在取得写入权的同一事务内重新读取持久状态，再调用 `recoverDispatching` 将所有遗留未结算尝试标记 unknown；固定 ownerId 也不能跳过旧派发。不重新调用工具。合法迟到结果可将同一个 unknown Attempt 确认为 completed，即使 Run 已结束，但不能重新交付模型或取得新派发权。

人工核对曾标记 `not_applied`，但同一 active Attempt 后来送达真实完成回执时，以该回执收敛为 confirmed，并保留操作及原 Attempt 的核对历史。回执仍须匹配尝试编号、修订号、owner 和结果身份；已经产生新 Attempt 时，旧回执不能覆盖它。

状态归属为共享 SessionState、MutationBuffer 及同一个 SQLite 连接，memory 会话按 sessionId 路由到内存。写入使用原有 owner 校验、事务和回滚日志；会话删除一起删除三个新集合，普通保留清理不删除这些审计记录。新增操作状态与核对逻辑放本目录，真实临时 SQLite 测试放 [__test__/tool-operation-repository.test.ts](__test__/tool-operation-repository.test.ts)。

人工检查使用 `listReviewCandidates()` 先投影 unknown 和 dispatching 的有限身份、状态和版本字段，不复制输入、原始结果或内部实现身份；Server 再排除原 Run 仍活跃的 dispatching。`getSummary()` 用于宿主先核验归属，之后 `getReviewPreview()` 才生成各最多 4000 字符的输入和原始结果预览，以及最近 20 条有界证据。详情可能含原始工具数据，只供已认证宿主人工查看，不自动写入模型上下文。原始正文与 Attempt 仍只保存在原操作记录中。

`reconcile` 的 `applied` 只有收到明确标记 `executionState: completed` 且身份匹配的真实结果才转为 confirmed；省略执行状态、结果缺失或仍未知都继续保持 unknown。证据追加到操作和原 Attempt，原未知回执不被核对结果覆盖。
