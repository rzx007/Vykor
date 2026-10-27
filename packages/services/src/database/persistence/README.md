# 会话数据持久化

提供会话状态的加载、提交、增量保存、事件序号及临时控制记录。

## 入口与流程

ChatPersistence 规定同步读写接口，SQLite 实现调用状态加载和保存函数；DeltaCheckpoint 决定何时保存增量，DurableEventSequence 预留事件序号。

## 状态归属

正式会话写入 SQLite；临时会话与临时控制记录保存在内存；检查点、序号预留和计时器由对应实例管理。

执行头、工具操作与派发尝试也经 ChatPersistenceRouter 按 sessionId 分流；正式数据在 read-model 中加载，memory 会话关闭后不留下 SQLite 记录。删除会话同时删除三个集合，普通保留清理保留工具审计与未决操作。

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

## 历史增长基准

`__test__/storage-growth.bench.mjs` 用当前迁移构造自己的临时 SQLite 数据库，依次为 100、1,000、10,000 Run 的 4 KiB 正文组以及 10,000 Run 零正文组各启动三个新进程。当前会话固定 10 Run，其余为无关历史；不读取用户数据库或调用模型。构造、owner 接管、查询和三个内存采样点分别记录，查询的原始 `.all()` 行数组在测试侧统计。

从仓库根运行：

```powershell
pnpm --filter @vykor/services exec node --expose-gc --import ../../apps/cli/node_modules/tsx/dist/loader.mjs src/database/persistence/__test__/storage-growth.bench.mjs
```

可传 `--output=<聚合 JSON 路径>`，并会生成各 worker 原始 JSON；这是基准输出选项，不是产品配置。运行基准时不要并行跑重测试。两轮同 Node、同脚本、同数据，变更测量口径后须重跑 baseline。

2026-10-27 的 256 行 rowid 分批候选证明四表原始集合有界，但 1,000 Run 构造中位数增加 24.32% 且增加 18.493 ms，触发事先门槛，因此加载器与读事务候选已回滚；当前仍一次读取四表。基准保留用于复测，不代表已经减少生产加载峰值。完整 baseline/candidate 三样本、各组中位数、原始集合统计、Node/脚本 SHA、回滚依据及驻留限制见[存储手册](../../../../../docs/session-runtime-storage-architecture.md#历史增长基准与有界加载评估2026-10-27)。
