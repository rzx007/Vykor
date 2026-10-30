# 已有运行能力与后台任务

| 文件 | 用途 |
| --- | --- |
| [runtime-resource.ts](./runtime-resource.ts) | `RuntimeResource` 只读查询模型、Agent persona、技能和会话 MCP 状态 |
| [job-resource.ts](./job-resource.ts) | `JobResource` 查询、读取、等待、输入和取消后台任务及子任务 |

`client.runtime.listModels`、`listAgentPersonas`、`listSkills`、`getSessionMcp` 读取 daemon 已配置的能力，不写入提供商凭据、全局设置或插件。调用方从读取结果中选择模型及能力，再提交会话操作。

`client.jobs.list({ sessionId })` 返回 `{ jobs, errors }`。read/wait/send/cancel 使用快照中的完整 `JobTarget`；Agent target 包含 kind、jobId、runId，其余任务包含 kind、jobId。send 可以返回新一轮输入的接纳回执。任务状态保存在 daemon，SDK 不建立本地任务执行器。

Git、开发环境管理和持久终端管理迁入 [私有应用客户端](../../../../application-client/README.md)。新增只读能力描述或任务操作放对应文件，测试放 [`__test__/`](./__test__)。
