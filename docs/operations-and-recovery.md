# Operations and Recovery

> 状态：当前 daemon 启动、停机、恢复、清理和备份的权威操作手册。最后核对：2026-08-23。

## 最重要的原则

- 同一个数据目录同一时刻只允许一个 Durable Application 写入。
- 重启只恢复记录，不复活已经消失的模型请求、Tool 进程或 live Handle。
- 看见 `running` 不代表一定还在跑；必须同时检查 Application owner 和 live runtime。
- 每次打开应用迁移链；不做旧库接管。与当前基线不匹配的库会带提示失败，删除重建即可；不要手改 __drizzle_migrations。

## 启动到 ready 的顺序

```text
打开 SQLite
  -> 应用迁移链（基线 + 增量）
  -> 取得 Application Owner 租约
  -> 恢复 Projection Settlement
  -> 收束失去进程的 Run / Attempt / Permission / Child
  -> 恢复或中断 Workflow
  -> 启动定时任务和应用服务
  -> ready
  -> HTTP 开始接收正常业务请求
```

`ready()` 没完成时，Application 不能接受 prompt。任何恢复失败都会让启动失败，不允许一边报错一边继续写数据库。

## Application Owner

Owner 是数据库里的一条带 generation 的写入租约，作用是阻止两个 daemon 同时操作同一份数据。

- 正常情况下每 5 秒更新心跳。
- 默认 30 秒没有心跳才允许新进程接管。
- 接管会增加 generation；旧进程即使恢复运行，也会因为 generation 不符而被拒绝写入。
- 心跳失败后 Application 进入 failed，停止继续接受正常操作。

不要通过删 owner 行强行并行启动两个实例。若确认旧进程已经退出，应等待 stale 时间后让新实例正常接管。

## 异常退出后的收束

Application 重启时按事实处理：

| 找到的状态 | 处理方式 |
|---|---|
| pending/running Run Attempt，但没有原进程 | 标为 `cancelled` |
| Run 仍活动 | 根据已保存事实标为 `interrupted` 或 `failed` |
| Permission 仍 pending | 标为 `expired`，不能沿用旧的人工确认 |
| child/task 仍活动 | 结束 durable 记录并释放路由；不会重建旧 child |
| Workflow 仍 running | 通过 claim 和 snapshot 判断；不能安全继续时明确中断 |
| orphan Input，没有 owner Run | 建立一条 `interrupted` Run 解释原因，不调用模型 |
| Projection Settlement pending | 先按保存的 action 重试或补偿；失败则继续保持 pending |

“Tool 可能已经执行，但结果没有成功保存”属于结果未知。此时应保留失败和 warning，不能自动重跑写操作。人工确认后再创建新的 Run。

## 正常停机顺序

```text
Operation Gate 进入 closing，停止新准入
  -> 等待已有维护租约退出
  -> Run Engine 停止排队并中断 active/queued lane
  -> Scheduled Tasks 停止触发
  -> 关闭 AgentPool，尝试关闭每个 root 和 child
  -> 强制 flush transcript 和 text checkpoint
  -> 再处理一次 Projection Settlement
  -> 关闭 SSE / HTTP / store
  -> 释放 Application Owner
```

每个阶段即使失败，后面的清理仍要继续。最后把多个错误一起返回，不能因为第一个 close 报错就跳过其余资源。

## 排障顺序

1. `GET /health`：确认 daemon 是否 ready，以及 active/queued Run 数。
2. `GET /debug/runtime`：看 lane、AgentPool、child、Job、owner 和 pending settlement 数。
3. `GET /debug/runs/:runId`：按 Run 汇总 Input、Attempt、消息、Tool、Workflow 和恢复关系。
4. `GET /debug/projection-settlements`：查看哪条投影失败、尝试次数和最后错误。
5. 查看结构化日志中的 `traceId`、`sessionId`、`runId`，不要用消息正文搜索。
6. 如果 owner 丢失或格式不符，停止写操作，先保留数据库副本再处理。

正常静止状态应满足：没有 active lane、没有 active Attempt、没有 pending Permission、没有 live child，`projectionSettlements.pending = 0`。

## Retention 清理

Retention 是按策略删除过期终态记录，不是“把数据库清空”。

- 只处理策略明确允许的 terminal Run、Workflow、事件和相关数据。
- 活动 Workflow、活动 Run、pending Settlement 和仍被引用的记录不能删。
- 实际删除与 `retention_audit` 在同一个事务里提交。
- 每次清理结果都能从审计记录看到。

修改清理规则时，必须先增加“活动记录不会被删”和“删除与审计一起回滚”的测试。

## 备份

Application backup 可以包含：

- SQLite 数据库；
- 显式指定的 artifacts；
- Memory 目录；
- execution output 目录。

备份会写 manifest 和每个文件的 SHA-256。符号链接及其他特殊文件会被拒绝，备份目标不能放在被备份的源目录里面。

推荐步骤：

1. 让 Application 停止接收新工作并完成 drain。
2. 创建 backup。
3. 保存 manifest、checksums 和完整目录，不单独复制 SQLite 文件。
4. 在另一处空目录执行一次恢复演练。

## 恢复

恢复只允许写入空目标：目标数据库不能已存在，目标目录必须为空。程序会先检查 manifest、所有 checksum 和目录规则，全部通过后才复制。

恢复完成后：

- 不会恢复旧 PID、模型连接、Tool 进程或 live child；
- 第一次启动会取得新的 owner；
- 仍为活动态的记录会走普通启动恢复；
- 迁移链必须完整：基线 `0000_current_schema.sql` 与其后增量迁移的 journal 与文件一一对应。

不要手工改 `__drizzle_migrations`；与当前基线不匹配的库不做兼容，删除重建即可。

## schema 演进

- 迁移链以 `0000_current_schema.sql` 为基线，其后为增量迁移；每次打开时按 `__drizzle_migrations` 水位线应用。
- 不做旧库接管：与当前基线不匹配的库会在启动时带提示失败，删除重建即可。
- 改名/改类型/数据变换等不可加性变更必须写显式迁移文件。

## Native Plugin 恢复

`plugins/installed.json` 是安装和启停真相，`plugins/cache/` 保存不可变版本，`plugins/data/` 独立保存跨版本数据。升级先写完整新 cache，再原子更新 installed record；转换、校验或写状态失败时旧 record 仍指向旧版本。普通卸载保留 data。

坏 artifact 不会从管理列表静默消失，而是显示 invalid 和结构化诊断。应重新转换或重新安装到新 cache 后 reload，不要手工覆盖 current cache 目录。

## 相关文档与测试

- 数据格式：[Durable Execution Data Model](./durable-execution-data-model.md)
- 收尾规则：[Agent Lifecycle Contract](./agent-lifecycle-contract.md)
- 投影修复：[Projection Settlement ADR](./adr/0001-projection-settlement-failure-policy.md)
- 日志与运行快照：[Observability](./observability.md)
- 关键边界测试：`packages/server/src/application/__test__/durability-boundaries.test.ts`
- 启动和关闭测试：`packages/server/src/application/__test__/durable-agent-application.test.ts`
