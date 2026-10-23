# 会话数据持久化

提供会话状态的加载、提交、增量保存、事件序号及临时控制记录。

## 入口与流程

ChatPersistence 规定同步读写接口，SQLite 实现调用状态加载和保存函数；DeltaCheckpoint 决定何时保存增量，DurableEventSequence 预留事件序号。

## 状态归属

正式会话写入 SQLite；临时会话与临时控制记录保存在内存；检查点、序号预留和计时器由对应实例管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [chat-persistence.ts](./chat-persistence.ts) | `assertSynchronousCommit`、`ChatPersistence`、`ChatStoragePersistence` 等 |
| [delta-checkpoint.ts](./delta-checkpoint.ts) | `DeltaCheckpointOptions`、`DeltaCheckpointSnapshot`、`DeltaCheckpoint` |
| [event-sequence.ts](./event-sequence.ts) | `EVENT_SEQUENCE_BLOCK_SIZE`、`EventSequenceSnapshot`、`DurableEventSequence` |
| [read-model.ts](./read-model.ts) | `LoadedSessionReadModel`、`loadSessionReadModel` |
| [sqlite-chat-persistence.ts](./sqlite-chat-persistence.ts) | `SqliteChatPersistence` |
| [temporary-control-records.ts](./temporary-control-records.ts) | `TemporaryControlSnapshot`、`TemporaryControlRecords` |

## 测试与维护

数据库侧读写机制放在这里，具体哪些领域记录需要改变由 Repository 和 Transaction 决定。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
