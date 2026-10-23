# HTTP 服务入口

把 HTTP 请求转换为应用调用，提供中间件、事件流与响应。

## 入口与流程

`VykorHttpServer` 组装协议校验、中间件与路由；路由调用应用服务，mappers 转换结果；`startVykorServer()` 监听并返回地址与关闭能力。

## 状态归属

应用持有业务状态；HTTP 层保存服务句柄、请求追踪和配置更新协调状态。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [protocol-middleware.ts](./protocol-middleware.ts) | `protocolMiddleware` |
| [provider-configuration-update.ts](./provider-configuration-update.ts) | `withProviderConfigurationUpdate` |
| [server.ts](./server.ts) | `VykorServerServices`、`VykorServerOptions`、`ListenResult`、`VykorHttpServer` 等 |
| [support.ts](./support.ts) | `JsonRecord`、`HttpPermissionStatus`、`VykorServerHealth`、`SseClient` 等 |

## 子目录

| 目录 | 用途 |
| --- | --- |
| [control/](./control/README.md) | 为单个请求分配并复用追踪标识，供中间件和路由关联日志。 |
| [mappers/](./mappers/README.md) | 把应用返回的数据转换为协议中的响应形状。 |
| [routes/](./routes/README.md) | 按会话、项目、模型、渠道、设置等资源组织接口入口。 |

## 测试与维护

HTTP 组装与通用请求处理放在本层，资源入口放在 routes，返回格式转换放在 mappers。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
