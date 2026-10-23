# 会话应用服务

提供会话命令、查询、输入操作与运行服务的共同入口。

## 入口与流程

命令服务创建或修改会话，查询服务读取快照；`SessionOperationRunner` 按会话串行执行变更，并协调就绪检查、操作许可和事件发布；各子目录完成具体职责。

## 状态归属

会话、输入、消息和运行记录通过 services 保存，串行等待队列保存在操作运行器中；执行实例由 AgentPool 与 runtime 管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [inputs.ts](./inputs.ts) | `CreateSessionInput`、`ForkSessionInput`、`UpdateSessionInput`、`ClearSessionWorktreeBindingInput` 等 |
| [query-models.ts](./query-models.ts) | `SessionStateSnapshot` |
| [session-application-error.ts](./session-application-error.ts) | `SessionApplicationError` |
| [session-command-service.ts](./session-command-service.ts) | `CreateSessionCommand`、`ForkSessionCommand`、`UpdateSessionCommand`、`SessionCommandStoreOperations` 等 |
| [session-operation-runner.ts](./session-operation-runner.ts) | `SessionOperationRunnerContext`、`SessionOperationRunner` |
| [session-query-service.ts](./session-query-service.ts) | `ListSessionsQuery`、`ListMessagesQuery`、`ListMessagePartsQuery`、`SessionQueryStore` 等 |

## 子目录

| 目录 | 用途 |
| --- | --- |
| [configuration/](./configuration/README.md) | 组合会话运行配置，并发现当前目录可用的技能、插件和模型限制。 |
| [execution/](./execution/README.md) | 负责输入准入、排队控制、运行组装与执行，以及工作目录变化和后台 Shell。 |
| [goals/](./goals/README.md) | 协调会话目标的启动、暂停、续跑和外部等待。 |
| [interactions/](./interactions/README.md) | 处理用户输入的解析、编辑、队列操作和权限回复。 |
| [maintenance/](./maintenance/README.md) | 处理单会话导出、回退、压缩、运行后记忆维护以及工作流恢复。 |
| [plugins/](./plugins/README.md) | 管理会话插件选择、能力授权、插件应用调用、通知与历史展示记录读取。 |
| [transcript/](./transcript/README.md) | 把执行变化转换为持久消息和可订阅事件，并整理会话引用的文本。 |

## 测试与维护

跨分类协调、公共命令类型与查询模型留在本层，具体执行、插件和记录处理放入下方分类。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
