# Node 共用任务接线

SDK 和 daemon 都从 [node-job-bindings.ts](node-job-bindings.ts) 组装同一套来源。

- [child-job-source.ts](child-job-source.ts)：从 child 目录定点取得真实 handle，按 runId 读取或等待 requests 中的那一轮；预期轮次匹配后才接纳继续输入。
- [process-job-source.ts](process-job-source.ts)：直接使用 supervisor 的进程、日志和完成通知，提供 Shell 创建端口及纯快照转换。
- [node-job-bindings.ts](node-job-bindings.ts)：为 agent、shell、dream、terminal、workflow 固定来源，返回 Jobs 与后台 Shell 工具端口。

结果、停止请求和启动幂等状态分别留在 ChildManager 与 supervisor。此目录没有独立观察表、Shell 请求表或生命周期管理器。归档端口只读；只在实时索引明确不存在时使用，存储错误直接返回。

来源接线放这里，执行规则改对应执行器。测试在 [__test__/](__test__/)，跨入口真实工厂验收在仓库 tests/agent-integration。
