# 应用维护与用量管理

统一处理存储扫描、清理策略、用量报表及维护准备。

## 入口与流程

维护应用服务读取策略与存储情况，在具备维护条件时协调备份和清理；用量模块按查询条件汇总运行消耗。

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
