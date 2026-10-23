# 执行记录查询

汇总会话运行与工作流执行信息，供状态页和诊断接口查询。

## 入口与流程

`ExecutionObservationService` 分派查询；会话和工作流读取器从各自记录中生成统一观察结果；query-models 定义筛选与返回形状。

## 状态归属

事实来自已保存的执行记录与工作流接口，本目录组织查询结果，不接管运行。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [execution-observation-service.ts](./execution-observation-service.ts) | `ExecutionObservationServiceInput`、`ExecutionObservationService` |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [query-models.ts](./query-models.ts) | `EXECUTION_KINDS`、`EXECUTION_OUTCOMES`、`EXECUTION_FAILURE_KINDS`、`ExecutionKind` 等 |
| [session-execution-observation-reader.ts](./session-execution-observation-reader.ts) | `SessionObservationSource`、`SessionObservationReadResult`、`readSessionExecutionObservations` |
| [workflow-execution-observation-reader.ts](./workflow-execution-observation-reader.ts) | `WorkflowObservationSource`、`WorkflowObservationReadResult`、`readWorkflowExecutionObservations` |

## 测试与维护

执行观察、筛选与归一化放在这里；HTTP 返回格式转换放在 http/mappers。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
