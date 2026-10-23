# 后台任务统一查询

把终端、子 Agent 和工作流任务转换为统一后台任务视图。

## 入口与流程

`DaemonJobService` 从各任务来源读取状态，快照函数生成统一结果，必要时路由读取输出、发送输入或停止请求。

## 状态归属

实际任务由终端、执行和工作流宿主管理，持久子活动从存储读取，本目录聚合查询与控制结果。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [child-activity.ts](./child-activity.ts) | `ChildActivityReader`、`readPersistedChildActivity` |
| [daemon-job-service.ts](./daemon-job-service.ts) | `JobSessionQueries`、`JobTaskOperations`、`JobSessionStore`、`DaemonJobService` |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [job-snapshots.ts](./job-snapshots.ts) | `terminalSnapshot`、`taskSnapshot`、`workflowSnapshot`、`taskAcceptsInput` 等 |

## 测试与维护

任务类型转换、输出限制和后台任务路由放在这里，具体进程生命周期交给对应宿主。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
