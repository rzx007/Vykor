# 会话记录投影与事件发布

把执行变化转换为持久消息和可订阅事件，并整理会话引用的文本。

## 入口与流程

投影器接收执行消息与部件变化，更新会话记录；事件发布器从已提交记录推进通知；图片元数据与会话摘要辅助函数提供展示所需信息。

## 状态归属

消息、部件和事件事实保存在会话存储中，投影过程中的关联信息由投影器管理。

工具完成事件中的类型化 `resultRef` 写入受控 `resultRef` 与 `toolResultReferenceVersion: 1` 元数据，供关闭数据库并重新加载后恢复补读引用。自由工具元数据里的同名字段会被过滤，不能伪造宿主引用。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [session-conversation-context.ts](./session-conversation-context.ts) | `ConversationContextCatalogStore`、`conversationContextCatalog` |
| [session-event-publisher.ts](./session-event-publisher.ts) | `SessionEventCursor`、`SessionEventSink`、`SessionEventPublisher` |
| [session-execution-projector.ts](./session-execution-projector.ts) | `SessionChildExecutionBridge`、`ExecutionInfo`、`ChildAgentRegistry`、`DetachedProcessRuntime` 等 |
| [transcript-image-metadata.ts](./transcript-image-metadata.ts) | `recordValue`、`generatedImageAssets` |
| [transcript-projection.ts](./transcript-projection.ts) | `ActiveTranscriptProjectionState`、`AppliedTranscriptStreamEvent`、`SessionTranscriptProjection` |

## 测试与维护

执行结果转写、事件发布与摘要提取放在这里；通用导出和文本回退算法放在 src/session。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
