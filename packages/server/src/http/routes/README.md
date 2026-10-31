# 按资源划分的 HTTP 路由

按会话、项目、模型、渠道、设置等资源组织接口入口。

## 入口与流程

路由读取请求，使用协议解析器校验参数，调用窄范围的应用服务，再通过映射函数生成响应或错误。

## 状态归属

请求数据属于当前调用；会话和运行状态由应用服务维护，路由不直接接管存储。

事件流仅在 HTTP 下游请求读取时才取下一条应用事件，字节流不提前排队。空闲读取等待事件或 15 秒心跳，等待中的单条事件请求跨心跳复用，而且只注册一次完成处理；每次读取最多保留一个可清理的心跳计时器和唤醒回调，没有读取需求时不发送心跳。应用订阅超限会立即使响应流报错并清理连接、等待、计时器和取消监听，客户端从最后实际应用的事件恢复。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [attachment.ts](./attachment.ts) | `AttachmentRouteService`、`createAttachmentRoutes`、`contentDisposition` |
| [auth.ts](./auth.ts) | `AuthRoutesContext`、`createAuthRoutes` |
| [background-shell.ts](./background-shell.ts) | `BackgroundShellRoutesContext`、`createBackgroundShellRoutes` |
| [channel-control.ts](./channel-control.ts) | `ChannelControlRoutesContext`、`createChannelControlRoutes` |
| [channel.ts](./channel.ts) | `createChannelRoutes` |
| [events.ts](./events.ts) | `HttpEventHub` |
| [facts.ts](./facts.ts) | `FactsRoutesContext`、`createFactsRoutes` |
| [git.ts](./git.ts) | `GitRoutesContext`、`createGitRoutes` |
| [job.ts](./job.ts) | `createJobRoutes` |
| [maintenance.ts](./maintenance.ts) | `createMaintenanceRoutes` |
| [marketplace.ts](./marketplace.ts) | `createMarketplaceRoutes` |
| [mcp.ts](./mcp.ts) | `McpRoutesContext`、`createMcpRoutes` |
| [memory.ts](./memory.ts) | `MemoryRoutesContext`、`createMemoryRoutes` |
| [notes.ts](./notes.ts) | `NoteRoutesContext`、`createNoteRoutes` |
| [permission.ts](./permission.ts) | `PermissionRoutesContext`、`createPermissionRoutes` |
| [project.ts](./project.ts) | `createProjectRoutes` |
| [run-execution.ts](./run-execution.ts) | `RunExecutionRoutesContext`、`createRunExecutionRoutes` |
| [schedules.ts](./schedules.ts) | `ScheduleRoutesContext`、`createScheduleRoutes` |
| [service.ts](./service.ts) | `ServiceRoutesContext`、`createServiceRoutes` |
| [session-goal.ts](./session-goal.ts) | `createSessionGoalRoutes` |
| [session-files.ts](./session-files.ts) | `SessionFileRouteService`、`createSessionFileRoutes`：会话工作区目录、信息、文本和文件搜索的五个只读 GET 入口 |
| [session-plugin-apps.ts](./session-plugin-apps.ts) | `createSessionPluginAppsRoutes` |
| [session-utility.ts](./session-utility.ts) | `SessionUtilityRoutesContext`、`createSessionUtilityRoutes` |
| [session.ts](./session.ts) | `SessionRoutesContext`、`createSessionRoutes` |
| [system.ts](./system.ts) | `SystemRoutesContext`、`createSystemRoutes` |
| [terminal.ts](./terminal.ts) | `TerminalHttpEventHub`、`createTerminalRoutes` |

历史展示记录的读取路由保留在本目录，与当前应用操作分开处理。

会话文件路由挂在 `/sessions/:sessionId/files`，只接收相对路径和协议规定的查询参数，拒绝重复参数与未知字段。路由把请求取消信号单独传给应用服务；应用决定实际目录、读取权限和操作上限，HTTP 层不创建 Agent。文件错误返回稳定的 `{ code, message }`，未知异常隐藏内部细节；未接入文件服务的宿主返回 501，能力列表也不声明 `sessionFiles`。

## 测试与维护

新接口放入对应资源文件，复杂业务放到 application，响应形状转换放到 mappers。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
