# 执行头记录

`SessionStore.executions` 提供每个 Run 的执行头。Run 是一次模型任务，Execution 是其工具操作审计记录的共同归属，S1 不保存续跑检查点。

主要文件是 [execution-repository.ts](execution-repository.ts)，公开入口为 [index.ts](index.ts)。宿主调用 `ensure({ sessionId, runId })`，或首次准备工具操作时自动创建；同一 Run 重复调用返回已有记录。`get` 和 `list` 返回副本，Run 状态变化时同步保存执行状态和结束时间。

状态保存在 SessionStore 的共享状态及同一个 SQLite 数据库中。memory 会话只进入内存存储，写入复用事务、当前 owner 校验和回滚日志。新增执行头字段及查询放本目录；工具派发状态放相邻的 [tool-operations](../tool-operations/README.md)，跨目录测试放工具操作的 `__test__/`。
