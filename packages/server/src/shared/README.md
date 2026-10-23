# 服务端共用基础能力

提供应用错误、结构化日志、运行指标和用量估算。

## 入口与流程

业务模块使用 `ApplicationError` 表达错误，使用日志函数记录带追踪标识的信息，并通过纯函数汇总指标与估算费用。

## 状态归属

本目录以类型和纯转换为主；日志写向输出，指标事实由调用方提供。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [application-error.ts](./application-error.ts) | `ApplicationErrorCode`、`APPLICATION_ERROR_HTTP_STATUS`、`ApplicationError` |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [observability.ts](./observability.ts) | `TRACE_ID_HEADER`、`ObservabilityLevel`、`ObservabilityEvent`、`StructuredLogger` 等 |
| [runtime-metrics.ts](./runtime-metrics.ts) | `RuntimeMetricHistogram`、`RuntimeMetricsSnapshot`、`emptyRuntimeMetricsSnapshot`、`buildRuntimeMetricsSnapshot` |
| [usage.ts](./usage.ts) | `estimateCostUsd` |

## 测试与维护

跨多个服务端分类共用的基础能力放在这里；具体业务辅助函数留在所属分类。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
