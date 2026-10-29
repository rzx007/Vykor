# 会话输入与消息记录

管理输入、消息、消息部件、增量输出以及会话树操作。

## 入口与流程

Repository 提供查询和常规修改；ConversationTransactions 处理输入准入与跨表变更；IncrementalOutput 累计流式文本，树操作负责复制历史及删除关联记录。

`listMessageParts(sessionId, { runId })` 可只读取一次运行的消息部件；先按会话和运行过滤，再应用消息、位置与数量限制。Goal 续跑保护通过此入口读取本轮结果，不复制整个历史中的工具正文。

## 状态归属

当前会话记录位于共享内存状态，持久内容通过 ChatPersistence 写入 SQLite；临时会话使用内存保存。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [commands.ts](./commands.ts) | `AdmitPromptInput`、`AdmitPromptAttachmentInput`、`AdmitPromptWithRunInput` 等 |
| [conversation-repository.ts](./conversation-repository.ts) | `ConversationRepositoryOptions`、`ConversationRepository` |
| [conversation-transactions.ts](./conversation-transactions.ts) | `AdmitPromptTransactionInput`、`ConversationTransactionTestHooks`、`ConversationTransactionsOptions` 等 |
| [conversation-tree-operations.ts](./conversation-tree-operations.ts) | `forkSessionWithHistory`、`deleteSessionTree` |
| [incremental-output.ts](./incremental-output.ts) | `IncrementalOutputOptions`、`IncrementalOutput` |
| [index.ts](./index.ts) | 汇总本分类的接口 |
| [query-models.ts](./query-models.ts) | `SessionStateSnapshot` |

## 测试与维护

围绕输入和消息的记录、命令、查询模型及事务放在一起，数据库机制放在 database。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
