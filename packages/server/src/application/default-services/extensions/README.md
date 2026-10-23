# 扩展默认服务

实现插件、市场、Hook 和输出风格的应用接口。

## 入口与流程

默认工厂读取可用扩展；插件与市场服务完成来源预览、确认和安装更新；Hook 与输出风格服务返回可用配置。

## 状态归属

安装内容与来源记录由插件和配置服务管理，本目录将结果转换为应用接口返回值。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [hooks-service.ts](./hooks-service.ts) | `createDefaultHooksService` |
| [marketplace-service.ts](./marketplace-service.ts) | `MarketplaceServiceOptions`、`createMarketplaceService`、`PluginMarketplaceService` |
| [output-style-service.ts](./output-style-service.ts) | `createDefaultOutputStyleService` |
| [plugin-service.ts](./plugin-service.ts) | `PluginArchiveFailure`、`createDefaultPluginService` |

## 测试与维护

扩展目录查询、安装适配和默认接口实现放在这里；当前会话的插件授权与应用操作放在 session/plugins。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
