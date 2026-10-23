# 数据保留策略

按保留策略清理不再需要的应用记录与相关内容。

## 入口与流程

`ApplicationRetentionService` 调用保留能力，结合当前应用状态执行清理并返回结果。

## 状态归属

策略和待清理数据由存储与保留能力管理，本服务只负责应用侧协调。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [application-retention-service.ts](./application-retention-service.ts) | `RetentionStoreOperations`、`ApplicationRetentionService` |

## 测试与维护

保留策略触发与应用协调放在这里，通用存储扫描和人工清理放在 maintenance。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
