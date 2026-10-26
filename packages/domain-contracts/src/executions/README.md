# 执行与工具操作记录合同

[records.ts](records.ts) 定义 Execution 头、工具操作、独立派发尝试和只读核对证据；[index.ts](index.ts) 通过 `@vykor/domain-contracts/executions` 导出纯数据类型。

Services 在准备工具前保存操作意图，授权后为实际派发创建 Attempt，工具返回后保存完整结果和时间。Operation 同时绑定会话、Run、Execution、调用身份、来源版本、规范输入及摘要；Attempt 绑定派发 owner 和不可变回执身份。Execution 状态跟随 Run，未知工具结果独立保留，不因 Run 结束而消失。

类型本身不保存状态。宿主函数、绑定定义、signal 和凭据不进入记录，实际数据由 Services 的共享 SQLite 或 memory 会话存储保存。新增相关记录放本目录，实际状态迁移及持久化测试放 Services 的 `tool-operations/__test__/`。

同一 `records.ts` 还定义人工核对的 `ToolOperationSummary`、`ToolOperationReviewPreview` 和 `ReconcileToolOperationRequest` 纯数据合同。Services 和 Protocol 共用这些类型，预览不携带可执行能力；核对授权与状态变更仍由 Server 和 Services 实施。
