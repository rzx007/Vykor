# @vykor/jobs

统一长时间工作的查询和控制接口，包括按所属会话列出任务、读取输出、等待、发送输入和取消。任务快照可以通过 HTTP 返回，不携带进程句柄或等待中的 Promise。

## 目录导航

| 目录 | 用途 |
| --- | --- |
| [src](src/README.md) | 数据契约、筛选函数、组合任务宿主和测试 |

`@vykor/jobs` 对应 [src/index.ts](src/index.ts)，提供 `AgentJobHost`、请求类型、筛选函数和 `RoutedAgentJobHost`。`@vykor/jobs/contracts` 对应 [src/contracts.ts](src/contracts.ts)，仅公开任务数据类型，入口声明见 [package.json](package.json)。

消费方将终端、后台命令或子 Agent 等任务投影成快照，再实现统一接口。组合宿主汇总多个来源，并把控制请求转交给实际持有该任务的来源。

实际执行和存储仍由生产任务的一方负责：终端保存在终端提供方，后台进程、子 Agent 和工作流由各自管理器保存，持久执行摘要由 `SessionExecutionRecord` 描述。本包只在组合宿主中缓存任务所属来源。

生命周期、输出游标及适配要求见 [Jobs 统一后台任务协议](../../docs/jobs-protocol.md)，Task 与 Workflow 的接口调整见 [Jobs Task/Workflow Convergence](../../docs/jobs-task-workflow-convergence.md)。新增共用逻辑放 `src/`，测试放 [src/__test__](src/__test__/)。
