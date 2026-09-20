# @openharness/services

共享持久化与领域服务。业务代码通过 Repository（负责一个领域的读写）和 Transaction（负责需要原子完成的跨表操作）访问状态；`SessionStore` 只保留数据库生命周期、owner lease、事件 waiter/listener、启动恢复和维护入口。

## 功能

- **Scheduled recurrence**: 校验一次性时间和 RRULE，并按时区计算下一次运行时间
- **Repository**: Projects、Schedules、Workflows、Channels、Sessions、Conversations、Runs、Goals、Permissions 和 Attachments 的当前读写入口
- **Transaction**: prompt 准入、会话树操作、Goal、Attachment 等需要一起提交或一起回滚的操作
- **Attachment 领域根**: `src/attachments/` 是唯一入口。`persistence/` 管 SQLite 记录，`storage/` 管 Blob 和完整性，`processing/` 管 OCR 与图片标准化，`content/` 管不依赖存储的文本分类。应用用例不在本包，而在 Server 的 `AttachmentService`
- **Database kernel**: SQLite 打开/关闭、事务协调、增量输出、owner lease、恢复与维护；不提供旧 Store 转发入口
- **standalone session files**: 只接受当前 schema 的项目级 snapshot 与 transcript 导出；不供 daemon/TUI 保存权威状态
- **LspClient**: 代码智能服务 (stub；ripgrep 查询走统一 Sandbox argv 入口)
- **Execution services**: detached process 和 framework child 的进程内句柄；durable 投影仍由 daemon 保存

外部工作负载进程不在 services 内直接 `spawn/exec`：`DetachedProcessSupervisor`、autodream 和 LSP 查询统一委托 `@openharness/sandbox`。framework child Agent 的回调句柄只放在 `ChildAgentExecutionRegistry`；跨端执行投影与 Scheduled Task 状态仍由 daemon `SessionStore` 持久化。

数据库包含基线 `0000_current_schema.sql` 及其后的增量迁移。从空目录一次建立当前 schema，二次打开幂等；基线前旧库在启动时按基线快照一次性接管补齐（补列、建索引、清理废弃表），再应用增量迁移。

## 测试

```bash
pnpm --filter @openharness/services test
```
