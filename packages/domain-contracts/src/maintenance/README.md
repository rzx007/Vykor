# 数据保留与备份清单

定义数据保留设置和备份包清单，让备份创建、恢复和展示使用相同字段。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | `@vykor/domain-contracts/maintenance` 公开入口 |
| [records.ts](records.ts) | 保留天数、最近执行时间、备份版本、目录与附件统计和恢复约束 |

消费方用 `StorageRetentionPolicy` 交换保留策略，用 `MaintenanceBackupManifest` 描述备份内容。清单约定恢复时不复活进程，并在启动时关闭旧的活动记录；实际恢复步骤由消费方实现。

设置、备份文件和清理进度由消费方保存，本目录仅定义数据，不删除文件或恢复数据库。新增维护数据字段放本目录，相关测试建议放同层 `__test__/`。
