# 应用运行控制

协调应用是否接受操作、独占维护，以及运行状态诊断。

## 入口与流程

`DaemonOperationGate` 为普通操作和维护屏障分配使用许可；`DaemonControlService` 汇总状态和控制流程；运行检查器读取已保存的运行与投影信息。

## 状态归属

进行中的许可和屏障保存在进程内，诊断事实从存储和活跃运行接口读取。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [daemon-control-service.ts](./daemon-control-service.ts) | `DaemonControlServiceContext`、`DaemonControlService` |
| [daemon-operation-gate.ts](./daemon-operation-gate.ts) | `DaemonOperationScope`、`DaemonOperationBarrier`、`DaemonOperationLease`、`DaemonMaintenanceInfo` 等 |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [run-inspector.ts](./run-inspector.ts) | `RunInspectionWarning`、`RunInspectorStore`、`RunInspection`、`inspectDurableRun` 等 |

## 测试与维护

全应用互斥、就绪检查和运行诊断放在这里；单个会话的串行操作留在 session。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
