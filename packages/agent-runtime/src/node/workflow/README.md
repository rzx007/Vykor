# 工作流宿主

管理工作流的启动、等待、恢复、取消和 worker 执行。worker 是工作流为某一步创建的执行者，可由 agent 子运行承担。

| 文件 | 用途 |
| --- | --- |
| `index.ts` | 工作流公开能力汇总，由 `@vykor/agent-runtime/node/workflow` 导出 |
| `workflow-host.ts` | `WorkflowHost`，持有运行与 worker，协调状态变化和关闭 |
| `workflow-host-directory.ts` | 按归属查找工作流宿主 |
| `agent-workflow-runner.ts` | 把工作流步骤接到真实子 agent 的启动和结果 |
| `file-workflow-run-repository.ts` | 文件形式的工作流运行仓库 |
| `memory-workflow-run-repository.ts` | 内存形式的运行仓库 |
| `workflow-actions.ts` | 校验、历史、时间线、模板和恢复动作 |
| `workflow-presentation.ts` | 过滤、格式化和展示工作流信息 |
| `__test__/` | 宿主、仓库、动作、worker 和关闭取消测试 |

宿主接收工作流请求，读取或创建运行记录，再通过 runner 启动 worker；步骤结果更新仓库并驱动后续步骤，结束时保存终态。活动任务保存在宿主中，持久记录由注入的仓库负责。

新增本机工作流运行规则放在这里；纯流程定义和调度约定放在 `@vykor/coordinator`，产品存储实现放在提供方包。测试放在同层 `__test__/`。


## 共用执行核心（阶段 A）

Workflow Jobs 使用原始 runId 作为 jobId。停止接线携带已捕获 childId/runId 调 interruptRun；runner 的进一步收拢留到阶段 C。
