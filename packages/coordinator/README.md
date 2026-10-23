# @vykor/coordinator

协调多个 Agent：解析角色定义、生成协调模式提示词、管理团队，并按任务依赖和并发上限执行工作流。

## 文档

| 文档 | 内容 |
|------|------|
| [`docs/coordinator-hard-scheduler-flow.md`](../../docs/coordinator-hard-scheduler-flow.md) | **权威运行时调用链**（工具 → 调度 → runner → 持久化） |
| [`docs/coordinator-hard-scheduler-design.md`](../../docs/coordinator-hard-scheduler-design.md) | 动机、分工、版本路线图 |
| [`docs/coordinator-agents-design.md`](../../docs/coordinator-agents-design.md) | Agent 加载与 coordinator mode 还原 |

## 包内结构

| 模块 | 职责 |
|------|------|
| [src](src/README.md) | 公开导出和分类导航 |
| [src/runtime](src/runtime/README.md) | 协调模式开关、提示词和任务通知 |
| [src/definitions](src/definitions/README.md) | 角色类型、Markdown 头部解析和内置定义 |
| [src/teams](src/teams/README.md) | 团队、成员和团队消息的内存注册表 |
| [src/workflow](src/workflow/README.md) | 工作流校验、调度、预算、快照和持久化接口 |

公开入口为 [`src/index.ts`](src/index.ts)，对应 `@vykor/coordinator`。还提供 `/coordinator-mode`、`/definitions`、`/teams`、`/workflow` 四个子入口，映射见 [`package.json`](package.json)。

调用方提供 `WorkflowSpec` 和单任务执行函数，`runWorkflow()` 校验依赖后挑选可执行任务，按并发、写入范围和预算限制执行，再返回结果并发出快照、事件回调。运行中的队列和结果保存在调度函数内存中，团队由 `TeamRegistry` 保存。快照与事件的长期保存通过 `WorkflowRunRepository` 交给宿主，本包不实现磁盘 store。

真实 worker 执行由 `@vykor/agent-runtime/node/workflow` 的宿主和 runner 负责，`@vykor/tools` 的 Workflow 工具负责适配调用。新增代码按上表职责放置，测试放在对应分类的同层 `__test__/`；跨分类测试放在 [`src/__test__`](src/__test__)。

## 测试

```bash
pnpm --filter @vykor/coordinator test
```
