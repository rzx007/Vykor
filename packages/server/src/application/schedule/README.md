# 定时任务执行

把持久定时任务转换为应用中的会话与输入执行。

## 入口与流程

`ScheduledTaskExecutor` 接收待执行任务，解析输入，创建或选择会话并提交运行，返回任务执行结果。

## 状态归属

任务计划与结果由定时任务存储保存；定时唤醒由 daemon 中的调度服务管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [inputs.ts](./inputs.ts) | `CreateScheduledTaskInput`、`UpdateScheduledTaskInput` |
| [scheduled-task-executor.ts](./scheduled-task-executor.ts) | `ScheduledTaskExecutorOptions`、`ScheduledTaskExecutor` |

## 测试与维护

定时任务如何进入会话放在这里；计时、扫描和服务生命周期放在 daemon。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
