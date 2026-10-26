# 守护进程启动与后台服务

组装常驻服务，管理 Agent 加载、渠道连接、定时调度和服务登记。

## 入口与流程

`startVykorDaemon()` 准备路径和配置后启动应用及 HTTP 服务；Agent 加载器提供执行实例；渠道和定时服务随守护进程启动与停止。

## 状态归属

登记文件记录服务地址与进程信息；活跃连接、调度计时器及运行引用保存在服务实例中，业务记录交给应用存储。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [channel-runtime-factory.ts](./channel-runtime-factory.ts) | `createDefaultChannelRuntime` |
| [channel-runtime-service.ts](./channel-runtime-service.ts) | `ChannelRuntimeError`、`ChannelRuntimeService`、`workspaceDirName` |
| [channel-runtime-types.ts](./channel-runtime-types.ts) | `ChannelRuntimeApplicationPort`、`ChannelAttachmentDownload`、`ChannelAttachmentDownloadInput`、`ConnectorRuntimeHandle` 等 |
| [daemon-agent.ts](./daemon-agent.ts) | `CreateDaemonAgentContext`、`CreateDaemonAgent`、`LoadDaemonAgentContext`、`LoadDaemonAgent` 等 |
| [default-daemon.ts](./default-daemon.ts) | `VykorDaemonOptions`、`startVykorDaemon` |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [paths.ts](./paths.ts) | `DaemonExecutionSurface`、`DaemonRegistry`、`createDaemonRegistryEntry`、`getDefaultSessionStorePath` 等 |
| [scheduled-task-service.ts](./scheduled-task-service.ts) | `ScheduledTaskExecutionResult`、`ScheduleOperations`、`ScheduledTaskServiceOptions`、`ScheduledTaskService` |

## 测试与维护

常驻服务的启动、关闭和运行适配放在这里；系统服务安装与进程终止放在 daemon-host。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。

默认应用为 Agent 加载器注入成对的 `toolSafety`，覆盖根运行、子运行与手动工具入口。宿主登记从 Node 的实际运行范围捕获工具定义和环境，权限及审批继续经过原有检查流程。
