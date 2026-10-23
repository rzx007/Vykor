# 工作流运行记录

保存工作流运行、任务尝试、事件及执行占用记录。

## 入口与流程

WorkflowRepository 接收运行和任务更新，写入事件并处理执行占用的申请与释放，供宿主恢复或查询工作流。

## 状态归属

事实保存在 SQLite，工作流调度、步骤执行和取消由工作流宿主管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [index.ts](./index.ts) | 汇总本分类的接口 |
| [workflow-records.ts](./workflow-records.ts) | `StoredWorkflowRunInput`、`StoredWorkflowRunRecord`、`StoredWorkflowEventInput` 等 |
| [workflow-repository.ts](./workflow-repository.ts) | `WorkflowRepository` |

## 测试与维护

工作流记录转换、读写和执行占用放在这里，实际流程执行由其他包提供。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
