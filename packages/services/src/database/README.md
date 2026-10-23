# 数据库打开与共享上下文

打开 SQLite、应用迁移链，并为领域模块提供数据库和共享状态接口。

## 入口与流程

`SessionDatabase.open()` 创建连接、配置 SQLite 并应用迁移；`StorageContext` 连接数据库、内存状态、修改记录和提交能力；事务和持久化实现见子目录。

## 状态归属

连接由 SessionDatabase 持有，打开期间的状态与资源由 SessionStore 组装和关闭。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [index.ts](./index.ts) | 汇总本分类的接口 |
| [migrations.ts](./migrations.ts) | `applySessionMigrations` |
| [session-database.ts](./session-database.ts) | `SessionDatabaseOptions`、`SessionDatabase` |
| [storage-context.ts](./storage-context.ts) | `StorageContext` |

## 子目录

| 目录 | 用途 |
| --- | --- |
| [transactions/](./transactions/README.md) | 让一次相关修改一起提交，并在失败时恢复原来的记录。 |
| [persistence/](./persistence/README.md) | 提供会话状态的加载、提交、增量保存、事件序号及临时控制记录。 |

## 测试与维护

连接、迁移定位和共享上下文留在本层，事务机制与会话持久化分别放入对应子目录。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
