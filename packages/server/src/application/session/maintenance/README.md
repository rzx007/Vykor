# 会话维护与恢复

处理单会话导出、回退、压缩、运行后记忆维护以及工作流恢复。

## 入口与流程

维护服务检查活跃工作与操作许可，再调用导出、回退或记忆能力；运行后维护只在相应运行阶段触发；工作流恢复接回未完成任务。

## 状态归属

会话历史与维护结果写入既有存储，活跃资源由注入的 AgentPool 与运行控制接口管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [session-maintenance-service.ts](./session-maintenance-service.ts) | `SessionMaintenanceError`、`SessionMaintenanceServiceContext`、`SessionMaintenanceService` |
| [session-post-run-maintenance.ts](./session-post-run-maintenance.ts) | `SessionPostRunMaintenanceContext`、`SessionPostRunMaintenance` |
| [workflow-recovery.ts](./workflow-recovery.ts) | `WorkflowRecoveryContext`、`recoverInterruptedWorkflows` |

## 测试与维护

单会话维护与运行后的收尾放在这里；全应用备份、存储清理放在 application/maintenance 和 backup。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
