# 附件记录与事务

保存附件资产、表示形式、使用许可及其状态变化。

## 入口与流程

`AttachmentRepository` 负责记录查询与写入，`AttachmentTransactions` 把需要一起生效的状态变化放进同一事务；记录转换函数处理数据库行。

## 状态归属

持久附件记录位于 SQLite；修改期间的回滚与通知通过传入的 StorageContext 协调。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [attachment-records.ts](./attachment-records.ts) | `CreateAttachmentRepresentationInput`、`AttachmentLeaseRecord`、`AcquireAttachmentLeasesInput` 等 |
| [attachment-repository.ts](./attachment-repository.ts) | `AttachmentRepository` |
| [attachment-transactions.ts](./attachment-transactions.ts) | `AttachmentTransactionsOptions`、`AttachmentTransactions` |

## 测试与维护

附件表的记录转换、读写和跨表事务一起放在这里，文件内容保存在 storage。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
