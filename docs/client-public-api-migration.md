# OpenHarness Client 公共 API 迁移指南

> 状态：当前生效的客户端公共 API 迁移与兼容收敛规则。

在 Stage 7（Public API Convergence）中，OpenHarness Client 的公共 API 全面收敛为按领域划分的**命名 Resource API**。

为保证平滑过渡，原有平铺在 `client` 顶层的方法已被标记为 `@deprecated`，但保留完全向后兼容的薄转发实现，计划在 Stage 8 满足双发行门槛后正式移除。

## 核心变更概述

客户端实例结构如下：
- `client.protocol`：协议握手、版本兼容性检查、服务健康探测与能力查询 (`ProtocolClient`)
- `client.system`：系统配置、命令注册表、MCP 状态、Dream、记忆等系统级功能 (`SystemResource`)
- `client.providers`：模型提供商配置、Catalog 连接与模型列表 (`ProviderResource`)
- `client.auth`：第三方身份认证与登录/注销 (`AuthResource`)
- `client.projects`：项目目录绑定、别名与元数据管理 (`ProjectResource`)
- `client.plugins`：插件发现、安装、启用/禁用与重载 (`PluginResource`)
- `client.development`：技能（Skills）、Agent Persona 与 Hook 管理 (`DevelopmentResource`)
- `client.sessions`：会话生命周期、Prompt 准入排队、快照与 Goal 管理 (`SessionResource`)
- `client.attachments`：附件二进制流上传、获取、删除与存储维护 (`AttachmentResource`)
- `client.permissions`：权限请求查询与决策回复 (`PermissionResource`)
- `client.schedules`：定时任务与调度执行记录 (`ScheduleResource`)
- `client.jobs`：后台作业管理、流式通信与取消 (`JobResource`)
- `client.terminals`：持久化 PTY 终端会话与事件流 (`TerminalResource`)
- `client.channels`：持久化消息通道送达与投递确认 (`ChannelResource`)
- `client.events`：会话与系统 SSE 事件流订阅 (`EventResource`)

此外，`client.transport`、`client.sse`、`client.baseUrl`、`client.token`、`client.fetchImpl` 属于长期支持的底层通讯入口，不受影响。

## 弃用方法与新 Resource 映射表

| 旧入口 (`@deprecated`) | 新入口 (推荐) | 弃用阶段 | Stage 8 移除门槛 |
|---|---|---|---|
| `client.health()` | `client.protocol.health()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.capabilities()` | `client.protocol.capabilities()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.uploadAttachment()` | `client.attachments.upload()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getAttachment()` | `client.attachments.get()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.downloadAttachment()` | `client.attachments.download()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.deleteAttachment()` | `client.attachments.delete()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.scanAttachmentStorage()` | `client.attachments.scanStorage()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.repairAttachmentStorage()` | `client.attachments.repairStorage()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.gcAttachmentStorage()` | `client.attachments.gcStorage()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.handleChannelMessage()` | `client.channels.handleMessage()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.recordChannelDelivery()` | `client.channels.recordDelivery()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getChannelStatus()` | `client.channels.getStatus()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listPendingChannelDeliveries()` | `client.channels.listPendingDeliveries()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listCommands()` | `client.system.listCommands()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getSettings()` | `client.system.getSettings()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.patchSettings()` | `client.system.patchSettings()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listProviders()` | `client.providers.listProviders()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.createCustomProvider()` | `client.providers.createCustomProvider()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.connectCatalogProvider()` | `client.providers.connectCatalogProvider()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.disconnectCatalogProvider()` | `client.providers.disconnectCatalogProvider()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.updateCustomProvider()` | `client.providers.updateCustomProvider()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.removeCustomProvider()` | `client.providers.removeCustomProvider()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listModels()` | `client.providers.listModels()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getSessionMcp()` | `client.system.getSessionMcp()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listMemory()` | `client.system.listMemory()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getMemory()` | `client.system.getMemory()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.addMemory()` | `client.system.addMemory()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.removeMemory()` | `client.system.removeMemory()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getAuthStatus()` | `client.auth.getStatus()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.authLogin()` | `client.auth.login()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.authLogout()` | `client.auth.logout()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listContextPlugins()` | `client.system.listContextPlugins()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getContextPreview()` | `client.system.getContextPreview()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getContextStatus()` | `client.system.getContextStatus()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getContextUsage()` | `client.system.getContextUsage()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.compactSession()` | `client.sessions.compact()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getSessionGoal()` | `client.sessions.getGoal()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.createSessionGoal()` | `client.sessions.createGoal()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.updateSessionGoal()` | `client.sessions.updateGoal()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.applySessionGoalAction()` | `client.sessions.applyGoalAction()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.rewindSession()` | `client.sessions.rewind()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.rememberSession()` | `client.sessions.remember()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.startDream()` | `client.system.startDream()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getProfileStatus()` | `client.system.getProfileStatus()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.initProfile()` | `client.system.initProfile()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listOutputStyles()` | `client.system.listOutputStyles()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.initProject()` | `client.projects.init()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listPlugins()` | `client.plugins.list()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.enablePlugin()` | `client.plugins.enable()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.disablePlugin()` | `client.plugins.disable()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.installLocalPlugin()` | `client.plugins.installLocal()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.previewPluginArchive()` | `client.plugins.previewArchive()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.installPluginArchive()` | `client.plugins.installArchive()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.previewPluginGit()` | `client.plugins.previewGit()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.installPluginGit()` | `client.plugins.installGit()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.uninstallPlugin()` | `client.plugins.uninstall()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.reloadPlugins()` | `client.plugins.reload()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listSkills()` | `client.development.listSkills()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.removeSkill()` | `client.development.removeSkill()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listAgentPersonas()` | `client.development.listAgentPersonas()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listHooks()` | `client.development.listHooks()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getGitDiff()` | `client.development.getGitDiff()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getGitBranch()` | `client.development.getGitBranch()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getGitStatus()` | `client.development.getGitStatus()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.gitCommit()` | `client.development.gitCommit()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getSessionUsage()` | `client.sessions.getUsage()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.exportSession()` | `client.sessions.export()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listSessions()` | `client.sessions.list()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listProjects()` | `client.projects.list()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.inspectProject()` | `client.projects.inspect()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.renameProject()` | `client.projects.rename()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.setProjectPinned()` | `client.projects.setPinned()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.setProjectDefaultShell()` | `client.projects.setDefaultShell()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.rebindProject()` | `client.projects.rebind()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.archiveProject()` | `client.projects.archive()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.createSession()` | `client.sessions.create()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getSession()` | `client.sessions.get()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.forkSession()` | `client.sessions.fork()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getSessionState()` | `client.sessions.getState()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.archiveSession()` | `client.sessions.archive()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.deleteSession()` | `client.sessions.delete()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.updateSession()` | `client.sessions.update()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listMessages()` | `client.sessions.listMessages()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listMessageParts()` | `client.sessions.listMessageParts()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.admitPrompt()` | `client.sessions.admitPrompt()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.editLatestPrompt()` | `client.sessions.editLatestPrompt()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.promoteQueuedPrompt()` | `client.sessions.promoteQueuedPrompt()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.cancelQueuedPrompt()` | `client.sessions.cancelQueuedPrompt()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.resumeInterruptedRun()` | `client.sessions.resumeInterruptedRun()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.interruptSession()` | `client.sessions.interrupt()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listEvents()` | `client.events.list()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listPermissions()` | `client.permissions.list()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.replyPermission()` | `client.permissions.reply()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getScheduledTaskStatus()` | `client.schedules.getStatus()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listScheduledTasks()` | `client.schedules.listTasks()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getScheduledTask()` | `client.schedules.getTask()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.createScheduledTask()` | `client.schedules.createTask()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.updateScheduledTask()` | `client.schedules.updateTask()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.removeScheduledTask()` | `client.schedules.removeTask()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.triggerScheduledTask()` | `client.schedules.triggerTask()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listScheduledRuns()` | `client.schedules.listRuns()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.setScheduledRunUnread()` | `client.schedules.setRunUnread()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.createTerminal()` | `client.terminals.create()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listJobs()` | `client.jobs.list()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.createBackgroundShell()` | `client.jobs.createBackgroundShell()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.readJob()` | `client.jobs.read()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.waitJob()` | `client.jobs.wait()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.sendJob()` | `client.jobs.send()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.cancelJob()` | `client.jobs.cancel()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.listTerminals()` | `client.terminals.list()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.getTerminal()` | `client.terminals.get()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.readTerminal()` | `client.terminals.read()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.writeTerminal()` | `client.terminals.write()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.resizeTerminal()` | `client.terminals.resize()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.signalTerminal()` | `client.terminals.signal()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.closeTerminal()` | `client.terminals.close()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.streamTerminalEvents()` | `client.terminals.streamEvents()` | stage-7 | 需两份发行证据（当前 pending） |
| `client.streamEvents()` | `client.events.stream()` | stage-7 | 需两份发行证据（当前 pending） |

## Stage 8 移除门槛规则

根据架构演进约定，平铺兼容层不会在 Stage 7 移除，其在 Stage 8 的正式移除必须同时满足以下硬性条件：
1. **首次弃用发行证据**（`deprecatedCarrierRelease`）：宿主承载包（默认 `@rzx/ohs` CLI）正式发布包含 Stage 7 弃用声明的版本（记录 version、date、commit/release URL）；
2. **保留期验证发行证据**（`retentionCarrierRelease`）：在首次弃用发布之后，至少再经历一个正式发行的完整周期，期间兼容层持续可用且验证无内部依赖；
3. 目前两项证据状态均为 `pending`。在任一证据就绪前，严禁删除任何兼容 facade 方法。
