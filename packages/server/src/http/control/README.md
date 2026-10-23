# HTTP 请求追踪

为单个请求分配并复用追踪标识，供中间件和路由关联日志。

## 入口与流程

`RequestTraceRegistry.assign()` 接收可用的外部标识或生成新值，`get()` 在同一请求上返回相同标识。

## 状态归属

请求与标识的关联保存在 WeakMap，随请求释放，不写入业务存储。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [request-trace-registry.ts](./request-trace-registry.ts) | `RequestTraceRegistry` |

## 测试与维护

请求范围的追踪和协调放在这里，通用日志格式放在 shared。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
