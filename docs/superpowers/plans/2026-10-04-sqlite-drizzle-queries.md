# SQLite 日常读写迁入 Drizzle 实现计划

> **For agentic workers:** Use scoped parallel implementation tasks and review the integrated diff. Steps use checkboxes to track completion.

**Goal:** 将现有 SQLite 日常记录读写迁入 Drizzle，消除业务查询中的手写 SQL 和位置参数维护。

**Architecture:** `SessionDatabase` 在已有连接上提供带 schema 类型的 `orm`。各领域使用该对象的同步查询构造器；现有内存状态、事务协调、事件通知和 checkpoint 行为保持一致。第二阶段再建立可替换的持久化接口，不在本阶段实现 MySQL、PostgreSQL 或内存后端。

**Tech Stack:** TypeScript、已安装的 drizzle-orm 0.45.2、better-sqlite3、Vitest。

**Spec:** 本聊天中确认的两个阶段范围；本计划只执行第一阶段。

## Global Constraints

- 不修改现有表定义、迁移链或公开同步方法签名。
- 不增加依赖，不提交或覆盖其他任务的修改。
- 保留 SQLite 连接配置、备份和现有事务边界；日常 CRUD 改用 Drizzle。
- `.get()`/`.all()`/`.run()` 同步执行查询；不能遗漏执行导致只生成查询。
- 批量操作复用 Drizzle 构造器的 `.prepare()` 查询，循环内绑定命名参数；不使用原生连接的手写 SQL 查询。
- 字段使用 schema 定义；已有 JSON 编码、null 表示、排序、冲突处理保持一致。
- 不用通用 SQL 转换器、不增加未来数据库占位实现。

## Task 1: 共用连接与会话持久化

**Files:** `database/session-database.ts` 及测试、`database/read-model.ts`、`database/event-sequence.ts`、`session-runtime/store-persistence.ts`、`session-runtime/store.ts`、`conversations/incremental-output.ts`、`conversations/conversation-tree-operations.ts`。

**Interfaces:** `SessionDatabase.orm: BetterSQLite3Database<typeof schema>`；`StorageContext` 仍通过 `database` 提供同一连接。

- [x] 在现有 database 测试中验证 typed 读写参与外层事务，失败后记录回滚；运行测试观察新入口尚不存在的失败。
- [x] 在构造函数中执行 `drizzle(connection, { schema })`，复用同一个 connection。
- [x] 用带命名字段的查询替换读模型、upsert、删除、owner lease、delta flush 和树删除。例如：

```ts
database.orm.update(sessionEventSequence)
  .set({ reservedThrough: 42 })
  .where(eq(sessionEventSequence.id, 1)).run();
```

- [x] 运行 database、会话事务、流式保存和 store 的现有测试。

## Task 2: 项目、计划任务和渠道

**Files:** `projects/project-repository.ts`、`schedules/schedule-repository.ts`、`channels/channel-repository.ts` 及现有领域测试。

**Interfaces:** 消费 `storage.database.orm`；现有返回值和事务入口不变。

- [x] 先运行上述领域现有测试，建立行为基线。
- [x] 使用命名字段、`eq`/`and`/`inArray`、排序和 upsert 转换全部日常 SQL；保持条件更新的 `.changes` 判断和现有事务。
- [x] 运行上述领域测试并检查范围内无 `.prepare()` 日常查询残留。

## Task 3: Goal 和附件元数据

**Files:** `goals/goal-repository.ts`、`attachments/persistence/attachment-repository.ts` 及现有领域测试。

**Interfaces:** 消费 `storage.database.orm`；共享业务规则和 JSON 编码保持原样。

- [x] 先运行相关现有测试，建立行为基线。
- [x] 转换 CRUD、去重插入、GC 和条件更新，保留唯一冲突处理与引用关系。
- [x] 运行相关测试；若 Drizzle 包装错误，沿 cause 识别原 SQLite 约束信息，保留业务错误行为。

## Task 4: 工作流与维护记录

**Files:** `workflows/workflow-repository.ts`、`session-runtime/session-retention.ts`、`session-runtime/projection-settlements.ts` 及现有相关测试。

**Interfaces:** Repository 消费 `storage.database.orm`；维护函数接收 typed ORM，根代理更新调用者。

- [x] 先运行相关现有测试，建立行为基线。
- [x] 转换工作流快照、事件、claim、retention、settlement 查询；保留插入序号、排序和受影响行数的原语义。
- [x] 运行领域与维护测试。

## Integrated Verification

- [x] `pnpm --filter @vykor/services check-types`。
- [x] 运行 services 数据库、所有变更领域、会话事务、流式保存和 store 测试；不重复完整 workspace 套件。
- [x] 检查生产日常 CRUD 无原生连接的手写 SQL 查询，SQL 迁移和 SQLite 配置仍保留。
- [x] 检查 schema/migrations 无差异；独立审查字段映射、更新范围、事务回滚和事件顺序。

## 验证结果

- Drizzle 共用连接检查先失败、实现后通过，验证外层 SQLite 事务回滚。
- 受影响存储测试：23 个文件、283 项通过；之后补充并验证 2 项分页回归，相关领域最终 74 项通过。
- services 和 server 类型检查通过；CLI/Desktop 打包布局的数据库初始化与重开检查通过。
- 架构边界和 clean-slate 检查通过；日常生产 CRUD 无原生连接的手写 SQL 查询。批量操作使用 Drizzle 自身的预编译入口复用查询。
- 独立逐文件审查未发现需要修复的问题；表定义、迁移和依赖没有改动。

## 提交前审核修复

- 重新审核后发现批量操作逐条准备查询的性能回归：会话批量保存、流式正文、工作流任务快照和历史事件清理均恢复为按批次复用 Drizzle 查询。新增回归测试实际统计 SQLite 查询准备次数，并验证保存结果。
- Goal continuation 恢复原有忽略唯一、主键、非空及 CHECK 约束违规的行为；外键和触发器错误继续抛出。新增回归测试先复现 NaN 导致的行为变化，再确认修复和外键错误保留。
- 修复后的完整受影响测试：24 个文件、291 项通过。services 类型检查通过。
- 只提交本次存储代码及对应文档，其他任务改动不纳入提交。
