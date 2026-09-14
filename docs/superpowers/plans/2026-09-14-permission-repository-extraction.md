# Permission Repository 提取实现计划

> **面向 AI 代理的工作者：** 使用 executing-plans 逐项执行并保留独立提交。

**目标：** 提取 Permission 五操作，保持事务、事件、broker resolver 和兼容 API。

**架构：** 单一 PermissionRepository 使用 StorageContext.atomic、read model、mutation buffer 和注入的校验/event 回调；Server broker 继续拥有授权策略与活体等待。

**技术栈：** TypeScript、better-sqlite3、Vitest。

---

## 任务 1：Repository 与 Store

- 创建 `permissions/permission-records.ts`、`permission-repository.ts`、`index.ts`。
- Repository 实现 create/reply/expirePending/get/list。
- Store 构造 `permissions`，五个旧方法转发。
- 测试原子回滚、二次回复、恢复过期、owner fence、过滤和磁盘重载。

## 任务 2：Server 接线

- Broker 接收 permissions、Session lineage 查询和 event cursor 窄能力。
- Goal/control/inspector 改用 `store.permissions` 查询。
- Daemon composition 注入窄能力。
- 保留 resolver、abort、复用、日志和 SSE 行为。

## 任务 3：审查与收尾

- 子代理审查实现并修复 Critical/Important。
- 更新架构状态与只减不增基线。
- 运行 Services 全量、Server Permission/Goal/Control 测试、两包类型、架构、文档和 schema/migration 检查。
