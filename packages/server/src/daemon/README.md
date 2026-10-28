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



prepareModelMetadata 接收当前 session；默认应用沿现有 settings/catalog reader 为 validateModelSelection 提供实时查询。此回调复用既有 validateRequestSelection，并随原模型元数据传入 Node；Server 不复制 child 的环境申请、运行、取消或卸载状态。

普通权限与审批通过后，执行入口调用当前 Run 的 `checkToolDispatch`，核对 owner、会话、Run、输入归属、cwd、最终工具绑定和运行修订。检查失败终止本 Run；工具普通错误与 unknown 只反馈本次调用，不限制其他新调用，也不自动重试。实际调用 Promise 一直跟踪到工具真正结束。
