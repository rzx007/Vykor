# 会话工作流记录接入

把工作流运行记录连接到服务端会话存储。

## 入口与流程

`SessionWorkflowRunRepository` 实现工作流所需的记录接口，转换状态并委托持久会话存储读写。

## 状态归属

工作流运行事实通过传入的会话存储保存，本目录不拥有工作流执行器。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [session-workflow-run-repository.ts](./session-workflow-run-repository.ts) | `WorkflowStorage`、`WorkflowSessionEvents`、`SessionWorkflowRunRepositoryOptions`、`SessionWorkflowRunRepository` |

## 测试与维护

工作流记录映射放在这里；运行恢复放在 session/maintenance，实际工作流宿主由 agent-runtime 提供。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
