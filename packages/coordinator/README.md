# @vykor/coordinator

多 Agent 协调：内置 / 用户 / 插件 Agent 定义、Coordinator mode prompt，以及**硬调度器**（`WorkflowSpec` / `runWorkflow` / 持久化 store）。

## 文档

| 文档 | 内容 |
|------|------|
| [`docs/coordinator-hard-scheduler-flow.md`](../../docs/coordinator-hard-scheduler-flow.md) | **权威运行时调用链**（工具 → 调度 → runner → 持久化） |
| [`docs/coordinator-hard-scheduler-design.md`](../../docs/coordinator-hard-scheduler-design.md) | 动机、分工、版本路线图 |
| [`docs/coordinator-agents-design.md`](../../docs/coordinator-agents-design.md) | Agent 加载与 coordinator mode 还原 |

## 包内结构

| 模块 | 职责 |
|------|------|
| `workflow/` | Workflow 的数据结构、校验、执行、快照与持久化 |
| `workflow/model.ts` | `WorkflowSpec`、plan、snapshot、notification、reconciliation 等核心类型 |
| `workflow/validation.ts` | DAG、三种 mode、依赖、writeScope 与 spec 校验 |
| `workflow/budget.ts` | budget preset、hard/soft limit、usage 汇总 |
| `workflow/runner.ts` | 纯内存调度循环：ready queue、并发、失败策略、budget、blocked task |
| `workflow/task-runner.ts` | 单 task 执行、retry、timeout、progress budget |
| `workflow/snapshot.ts` | run id、snapshot、summary、snapshot/result 转换 |
| `workflow/notification.ts` | `<workflow-notification>` formatter/parser |
| `workflow/reconciliation.ts` | changed-file / write-scope overlap 检测、summary、follow-up spec |
| `workflow/store.ts` | `.vykor/workflows` 快照 + events；resume/cancel/list |
| `coordinator-mode.ts` | `getCoordinatorTools` / prompt / user context |
| `agent-loader.ts` / `agent-definitions.ts` | frontmatter 加载与 builtin 合并 |
| `index.ts` | 导出 + `COORDINATOR_SYSTEM_PROMPT` |

真实 worker 执行在 `@vykor/tools` 的 `createAgentWorkflowRunner` / `Workflow` 工具，本包不依赖 swarm。

## 测试

```bash
pnpm --filter @vykor/coordinator test
```
