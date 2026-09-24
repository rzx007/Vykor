# 历史 Bug 审计归档

> 状态：历史审计结果，最后复核：2026-08-23。文件名为保留旧链接，不是当前待修复列表。

这份文件最早记录 2026-06 代码审计发现的问题。项目架构后来删除了旧 REPL、BackendHost、TaskManager 和临时 Agent bridge，因此不能把旧条目继续当成当前事实。

## 本次复核结果

| 旧编号 | 当前结果 |
|---|---|
| M7：旧 CLI `loadSessionById` 异常处理 | 旧入口已删除；当前 snapshot 和持久数据使用严格解码，问题不再适用 |
| M8：MCP 工具用 `any` 读取 manager | 已改为明确的 `McpClientManager` 类型，并保留 manager 缺失时的可读错误 |
| M10、M11：旧 TaskManager/CronScheduler 收尾问题 | 相关旧路径已删除；当前长期工作通过 Session Execution、Jobs、Scheduled Task 和 Workflow 收尾 |
| L1：旧 teammate CLI 默认值 | 旧入口已删除 |
| L2：lock 文件可能永久阻塞 | 当前 lock 根据 mtime 识别 stale lock；活锁和旧锁有明确边界 |
| L3：Edit 多处匹配只报数量 | 已返回每个匹配的行号，并有回归测试 |
| L4：短 hash 冲突风险 | 当前使用 SHA-1 的 12 位十六进制摘要，不再使用旧短 hash |
| L5：旧 host 行处理异常 | 旧 BackendHost/LegacyJSON 路径已删除 |

本轮复核还发现并处理了三类没有写进旧清单的问题：

- 删除 `@vykor/services` 中无人使用的第二套 CompactService；Runtime 只保留 `@vykor/core` 的实现。
- Workflow live worker 元数据从旧领域名 `taskManagerTaskId` 硬切为 `workerTaskId`，不读取旧字段。
- HTTP/Execution 测试不再读取用户机器的 settings，也不再调用已经删除的 `options.requestPermission`；测试只使用当前 `hostCapabilities.permissions` 接口。

原清单中标为 H/M 的其他问题也已经修复、被新架构替代，或失去对应代码入口。本轮没有发现仍能在当前代码中复现的旧条目。

这句话不等于“项目永远没有 Bug”。新的缺陷必须附上当前文件、复现步骤和失败测试，进入 issue 或新的审计记录；不要继续往这份历史文件追加没有证据的猜测。

当前运行不变量和验证入口见：

- [Agent Lifecycle Contract](./agent-lifecycle-contract.md)
- [Durable Execution Data Model](./durable-execution-data-model.md)
- [Operations and Recovery](./operations-and-recovery.md)
- [契约与测试索引](./contract-test-index.md)
