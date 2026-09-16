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

此外，`client.transport`、`client.sse`、`client.baseUrl`、`client.token`、`client.fetchImpl` 在 Stage 7 继续保留，属于高级底层入口，但尚未形成长期兼容承诺；Stage 8 会根据真实外部使用情况单独评估，不能与平铺 facade 一并自动删除。

## 迁移示例

普通请求只改调用路径，参数和返回值不变：

```ts
// Stage 7 兼容写法
const session = await client.getSession(sessionId);

// 推荐写法
const session = await client.sessions.get(sessionId);
```

流式调用仍保持 `AsyncIterable` 和 `AbortSignal` 语义：

```ts
const controller = new AbortController();
for await (const event of client.events.stream({ sessionId, signal: controller.signal })) {
  consume(event);
}
```

## 弃用方法与新 Resource 映射表

| 旧入口 (`@deprecated`) | 新入口 (推荐) | 参数差异 | 弃用阶段 | Stage 8 移除门槛 |
|---|---|---|---|---|
| `client.health()` | `client.protocol.health()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.capabilities()` | `client.protocol.capabilities()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.uploadAttachment()` | `client.attachments.upload()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getAttachment()` | `client.attachments.get()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.downloadAttachment()` | `client.attachments.download()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.deleteAttachment()` | `client.attachments.delete()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.scanAttachmentStorage()` | `client.attachments.scanStorage()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.repairAttachmentStorage()` | `client.attachments.repairStorage()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.gcAttachmentStorage()` | `client.attachments.gcStorage()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.handleChannelMessage()` | `client.channels.handleMessage()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.recordChannelDelivery()` | `client.channels.recordDelivery()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getChannelStatus()` | `client.channels.getStatus()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listPendingChannelDeliveries()` | `client.channels.listPendingDeliveries()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listCommands()` | `client.system.listCommands()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getSettings()` | `client.system.getSettings()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.patchSettings()` | `client.system.patchSettings()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listProviders()` | `client.providers.listProviders()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.createCustomProvider()` | `client.providers.createCustomProvider()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.connectCatalogProvider()` | `client.providers.connectCatalogProvider()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.disconnectCatalogProvider()` | `client.providers.disconnectCatalogProvider()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.updateCustomProvider()` | `client.providers.updateCustomProvider()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.removeCustomProvider()` | `client.providers.removeCustomProvider()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listModels()` | `client.providers.listModels()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getSessionMcp()` | `client.system.getSessionMcp()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listMemory()` | `client.system.listMemory()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getMemory()` | `client.system.getMemory()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.addMemory()` | `client.system.addMemory()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.removeMemory()` | `client.system.removeMemory()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getAuthStatus()` | `client.auth.getStatus()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.authLogin()` | `client.auth.login()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.authLogout()` | `client.auth.logout()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listContextPlugins()` | `client.system.listContextPlugins()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getContextPreview()` | `client.system.getContextPreview()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getContextStatus()` | `client.system.getContextStatus()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getContextUsage()` | `client.system.getContextUsage()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.compactSession()` | `client.sessions.compact()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getSessionGoal()` | `client.sessions.getGoal()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.createSessionGoal()` | `client.sessions.createGoal()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.updateSessionGoal()` | `client.sessions.updateGoal()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.applySessionGoalAction()` | `client.sessions.applyGoalAction()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.rewindSession()` | `client.sessions.rewind()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.rememberSession()` | `client.sessions.remember()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.startDream()` | `client.system.startDream()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getProfileStatus()` | `client.system.getProfileStatus()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.initProfile()` | `client.system.initProfile()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listOutputStyles()` | `client.system.listOutputStyles()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.initProject()` | `client.projects.init()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listPlugins()` | `client.plugins.list()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.enablePlugin()` | `client.plugins.enable()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.disablePlugin()` | `client.plugins.disable()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.installLocalPlugin()` | `client.plugins.installLocal()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.previewPluginArchive()` | `client.plugins.previewArchive()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.installPluginArchive()` | `client.plugins.installArchive()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.previewPluginGit()` | `client.plugins.previewGit()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.installPluginGit()` | `client.plugins.installGit()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.uninstallPlugin()` | `client.plugins.uninstall()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.reloadPlugins()` | `client.plugins.reload()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listSkills()` | `client.development.listSkills()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.removeSkill()` | `client.development.removeSkill()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listAgentPersonas()` | `client.development.listAgentPersonas()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listHooks()` | `client.development.listHooks()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getGitDiff()` | `client.development.getGitDiff()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getGitBranch()` | `client.development.getGitBranch()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getGitStatus()` | `client.development.getGitStatus()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.gitCommit()` | `client.development.gitCommit()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getSessionUsage()` | `client.sessions.getUsage()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.exportSession()` | `client.sessions.export()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listSessions()` | `client.sessions.list()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listProjects()` | `client.projects.list()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.inspectProject()` | `client.projects.inspect()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.renameProject()` | `client.projects.rename()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.setProjectPinned()` | `client.projects.setPinned()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.setProjectDefaultShell()` | `client.projects.setDefaultShell()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.rebindProject()` | `client.projects.rebind()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.archiveProject()` | `client.projects.archive()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.createSession()` | `client.sessions.create()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getSession()` | `client.sessions.get()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.forkSession()` | `client.sessions.fork()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getSessionState()` | `client.sessions.getState()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.archiveSession()` | `client.sessions.archive()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.deleteSession()` | `client.sessions.delete()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.updateSession()` | `client.sessions.update()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listMessages()` | `client.sessions.listMessages()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listMessageParts()` | `client.sessions.listMessageParts()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.admitPrompt()` | `client.sessions.admitPrompt()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.editLatestPrompt()` | `client.sessions.editLatestPrompt()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.promoteQueuedPrompt()` | `client.sessions.promoteQueuedPrompt()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.cancelQueuedPrompt()` | `client.sessions.cancelQueuedPrompt()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.resumeInterruptedRun()` | `client.sessions.resumeInterruptedRun()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.interruptSession()` | `client.sessions.interrupt()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listEvents()` | `client.events.list()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listPermissions()` | `client.permissions.list()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.replyPermission()` | `client.permissions.reply()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getScheduledTaskStatus()` | `client.schedules.getStatus()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listScheduledTasks()` | `client.schedules.listTasks()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getScheduledTask()` | `client.schedules.getTask()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.createScheduledTask()` | `client.schedules.createTask()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.updateScheduledTask()` | `client.schedules.updateTask()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.removeScheduledTask()` | `client.schedules.removeTask()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.triggerScheduledTask()` | `client.schedules.triggerTask()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listScheduledRuns()` | `client.schedules.listRuns()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.setScheduledRunUnread()` | `client.schedules.setRunUnread()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.createTerminal()` | `client.terminals.create()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listJobs()` | `client.jobs.list()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.createBackgroundShell()` | `client.jobs.createBackgroundShell()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.readJob()` | `client.jobs.read()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.waitJob()` | `client.jobs.wait()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.sendJob()` | `client.jobs.send()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.cancelJob()` | `client.jobs.cancel()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.listTerminals()` | `client.terminals.list()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.getTerminal()` | `client.terminals.get()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.readTerminal()` | `client.terminals.read()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.writeTerminal()` | `client.terminals.write()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.resizeTerminal()` | `client.terminals.resize()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.signalTerminal()` | `client.terminals.signal()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.closeTerminal()` | `client.terminals.close()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.streamTerminalEvents()` | `client.terminals.streamEvents()` | 无 | stage-7 | 需两份发行证据（当前 pending） |
| `client.streamEvents()` | `client.events.stream()` | 无 | stage-7 | 需两份发行证据（当前 pending） |

## Stage 8 移除门槛规则

根据架构演进约定，平铺兼容层不会在 Stage 7 移除，其在 Stage 8 的正式移除必须同时满足以下硬性条件：
1. **首次弃用发行证据**（`deprecatedCarrierRelease`）：宿主承载包固定为 `@rzx/ohs` CLI；正式发布包含 Stage 7 弃用声明的版本后，记录 `carrier`、`version`、`date`、`channel`，以及 `releaseNoteUrl` 或 `commit`；
2. **保留期验证发行证据**（`retentionCarrierRelease`）：在首次弃用发布之后，至少再经历一个正式发行的完整周期，期间兼容层持续可用且验证无内部依赖，并记录相同结构的证据；
3. 目前两项证据状态均为 `pending`。在任一证据就绪前，严禁删除任何兼容 facade 方法。

证据关联规则：`commit` 必须是该 carrier 版本实际构建所使用的 OpenHarness-ts 提交；`version` 必须与同一次 CLI 发布标签或 release note 对应。不得用分支头、未发布构建或 Desktop 的另一版本替代。只有发行流程明确改为由 Desktop 承载 Client 时，才能一次性修改契约中的默认 carrier，不能逐个方法混用 carrier。

Stage 8A 已将固定的 118 项旧名称迁入独立、持久的 `scripts/client-compat-removal-ledger.json`。`pnpm check:client-compat-integrity` 是普通开发和 CI 使用的完整性检查：证据 pending 时允许正常开发，但减少、改名、改分类或复活旧方法都会失败。`pnpm check:client-removal-gate` 是显式删除授权检查，会验证 stable channel、真实本地 commit、tag 指向、Stage 7 祖先关系、两次发行顺序、ledger 摘要和 major target；当前因 A/B 尚未发布而按设计返回 BLOCKED。历史 tag 不能倒填，只有包含本次 Stage 7 弃用声明的实际发布才可作为首次证据。
