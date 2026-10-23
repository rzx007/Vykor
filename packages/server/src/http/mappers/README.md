# HTTP 返回格式转换

把应用返回的数据转换为协议中的响应形状。

## 入口与流程

各映射函数接收应用结果，整理会话部件、插件应用、市场、维护和执行观察字段，再交给路由响应。

## 状态归属

转换结果属于当前响应，业务事实仍由应用服务和存储管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [execution-observability.ts](./execution-observability.ts) | `executionObservationDto` |
| [maintenance.ts](./maintenance.ts) | `usageReportDto`、`storageReportDto`、`cleanupPreviewDto`、`cleanupResultDto` |
| [marketplace.ts](./marketplace.ts) | `marketplaceSourcesDto`、`marketplaceCatalogDto`、`marketplacePreviewDto`、`marketplaceOperationDto` |
| [part-wire-view.ts](./part-wire-view.ts) | `publicPart`、`summarizePart`、`publicPartEvent`、`summarizePartEvent` |
| [plugin-apps.ts](./plugin-apps.ts) | `pluginAppToolInput`、`pluginAppConversationInput` |
| [session.ts](./session.ts) | `sessionCreateInput`、`sessionForkInput`、`sessionUpdateInput`、`sessionClearWorktreeInput` |

## 测试与维护

新增或调整协议展示字段在这里转换；业务规则留在应用目录，并补充对应转换测试。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
