# 会话存储生命周期

组装各领域读写能力，管理应用独占使用许可、事件等待、恢复和保留策略。

## 入口与流程

`SessionStore.open()` 打开数据库并装入共享状态，创建各领域 Repository 与 Transaction；提交后发布事件通知，关闭时保存剩余增量并释放资源。

## 状态归属

SessionStore 持有当前连接、共享状态、订阅与使用许可；正式记录写入 SQLite，临时会话保存在内存。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [commands.ts](./commands.ts) | `CreateProjectionSettlementInput`、`ListProjectionSettlementsOptions` |
| [index.ts](./index.ts) | 汇总本分类的接口 |
| [projection-settlements.ts](./projection-settlements.ts) | `createProjectionSettlement`、`getProjectionSettlement`、`listProjectionSettlements` 等 |
| [schema.ts](./schema.ts) | `sessions`、`projects`、`sessionPluginApps` 等 |
| [session-retention.ts](./session-retention.ts) | `RetentionPolicy`、`DEFAULT_RETENTION_POLICY`、`applyRetention` 等 |
| [store.ts](./store.ts) | `ApplicationOwnerLease`、`ApplicationOwnerConflictError`、`SessionStore` |

## 子目录

| 目录 | 用途 |
| --- | --- |
| [events/](./events/README.md) | 集中定义可保存的事件类型及其数据校验规则。 |
| [persistence/](./persistence/README.md) | 定义打开期间的会话状态、配置和记录辅助函数，并把变更写入数据库。 |
| [migrations/](./migrations/README.md) | 保存当前数据库基线、后续增量 SQL 和 Drizzle 生成的迁移元数据。 |

## 测试与维护

跨领域组装、生命周期和维护留在本层，事件注册及共享状态保存放在子目录，领域规则放回各自目录。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
