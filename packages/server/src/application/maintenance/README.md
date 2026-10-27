# 应用维护与用量管理

统一处理存储扫描、清理策略、用量报表及维护准备。

## 入口与流程

维护应用服务读取策略与存储情况，在具备维护条件时协调备份和清理；用量模块按查询条件汇总运行消耗。

按年龄批量清理根会话时，预览和实际删除前都检查整棵子会话树。任一后代存在 prepared、authorized、dispatching 或 unknown 工具操作就保护整棵树，即使 Run 已结束；确认完成或明确取消的操作不单独阻止清理。用户明确删除单个会话仍走原有会话命令入口。

每次工具操作保护判断只读取一次 `listSafetyStates()` 有限元数据，用目标树的会话 ID 集合筛选，不读取或复制完整工具结果。执行删除前会重新读取，预览后新增的未决操作同样受保护。

## 状态归属

持久策略由策略仓储保存，统计事实来自会话存储和文件系统，独占维护由 control 协调。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [cleanup-settings.ts](./cleanup-settings.ts) | `MaintenanceCleanupService` |
| [maintenance-application-service.ts](./maintenance-application-service.ts) | `MaintenanceApplicationContext`、`createMaintenanceApplicationService`、`MaintenanceApplicationService` |
| [maintenance-policy-repository.ts](./maintenance-policy-repository.ts) | `createMaintenancePolicyRepository` |
| [query-models.ts](./query-models.ts) | `UsageFilter`、`UsageRequest`、`UsageReport`、`StorageCategory` 等 |
| [storage-settings.ts](./storage-settings.ts) | `maintenanceDirectories`、`scanStorage` |
| [usage-settings.ts](./usage-settings.ts) | `defaultUsageSettings`、`readUsageReport` |

## 测试与维护

全应用维护、存储与用量规则放在这里；单会话压缩、回退与运行后维护放在 session/maintenance。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
