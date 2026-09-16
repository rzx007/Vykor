# Compatibility surface 实施审计

> 状态：当前。Stage 8A 已完成 Client facade 与兼容发行治理的删除裁定。

本页记录 clean-slate Stage 8A 的语义审计结论。它不是迁移指南；旧名称的唯一机器事实源是测试专用的 `scripts/forbidden-compatibility-surfaces.json`。

## 审计方法

执行了计划规定的四组扫描：兼容关键词、常见旧 Client 调用、HTTP 路由注册、CLI command/option 注册。关键词命中按实际运行职责归类，避免按名字批量删除。第三方 Provider 目录 `packages/api/src/models/api.json` 中的 deprecated/compatibility 文案整体视为外部目录数据，不逐项列入 forbidden 清单。

## 8A 删除项

| 符号/字符串 | 定义文件 | 生产调用者 | 当前替代入口 | 结论 | 理由 |
|---|---|---|---|---|---|
| `client.addMemory` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.system.addMemory` | 删除 | 仅转发到当前 Resource |
| `client.admitPrompt` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.admitPrompt` | 删除 | 仅转发到当前 Resource |
| `client.applySessionGoalAction` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.applyGoalAction` | 删除 | 仅转发到当前 Resource |
| `client.archiveProject` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.projects.archive` | 删除 | 仅转发到当前 Resource |
| `client.archiveSession` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.archive` | 删除 | 仅转发到当前 Resource |
| `client.authLogin` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.auth.login` | 删除 | 仅转发到当前 Resource |
| `client.authLogout` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.auth.logout` | 删除 | 仅转发到当前 Resource |
| `client.cancelJob` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.jobs.cancel` | 删除 | 仅转发到当前 Resource |
| `client.cancelQueuedPrompt` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.cancelQueuedPrompt` | 删除 | 仅转发到当前 Resource |
| `client.capabilities` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.protocol.capabilities` | 删除 | 仅转发到当前 Resource |
| `client.closeTerminal` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.terminals.close` | 删除 | 仅转发到当前 Resource |
| `client.compactSession` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.compact` | 删除 | 仅转发到当前 Resource |
| `client.connectCatalogProvider` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.providers.connectCatalogProvider` | 删除 | 仅转发到当前 Resource |
| `client.createBackgroundShell` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.jobs.createBackgroundShell` | 删除 | 仅转发到当前 Resource |
| `client.createCustomProvider` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.providers.createCustomProvider` | 删除 | 仅转发到当前 Resource |
| `client.createScheduledTask` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.schedules.createTask` | 删除 | 仅转发到当前 Resource |
| `client.createSession` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.create` | 删除 | 仅转发到当前 Resource |
| `client.createSessionGoal` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.createGoal` | 删除 | 仅转发到当前 Resource |
| `client.createTerminal` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.terminals.create` | 删除 | 仅转发到当前 Resource |
| `client.deleteAttachment` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.attachments.delete` | 删除 | 仅转发到当前 Resource |
| `client.deleteSession` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.delete` | 删除 | 仅转发到当前 Resource |
| `client.disablePlugin` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.plugins.disable` | 删除 | 仅转发到当前 Resource |
| `client.disconnectCatalogProvider` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.providers.disconnectCatalogProvider` | 删除 | 仅转发到当前 Resource |
| `client.downloadAttachment` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.attachments.download` | 删除 | 仅转发到当前 Resource |
| `client.editLatestPrompt` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.editLatestPrompt` | 删除 | 仅转发到当前 Resource |
| `client.enablePlugin` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.plugins.enable` | 删除 | 仅转发到当前 Resource |
| `client.exportSession` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.export` | 删除 | 仅转发到当前 Resource |
| `client.forkSession` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.fork` | 删除 | 仅转发到当前 Resource |
| `client.gcAttachmentStorage` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.attachments.gcStorage` | 删除 | 仅转发到当前 Resource |
| `client.getAttachment` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.attachments.get` | 删除 | 仅转发到当前 Resource |
| `client.getAuthStatus` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.auth.getStatus` | 删除 | 仅转发到当前 Resource |
| `client.getChannelStatus` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.channels.getStatus` | 删除 | 仅转发到当前 Resource |
| `client.getContextPreview` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.system.getContextPreview` | 删除 | 仅转发到当前 Resource |
| `client.getContextStatus` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.system.getContextStatus` | 删除 | 仅转发到当前 Resource |
| `client.getContextUsage` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.system.getContextUsage` | 删除 | 仅转发到当前 Resource |
| `client.getGitBranch` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.development.getGitBranch` | 删除 | 仅转发到当前 Resource |
| `client.getGitDiff` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.development.getGitDiff` | 删除 | 仅转发到当前 Resource |
| `client.getGitStatus` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.development.getGitStatus` | 删除 | 仅转发到当前 Resource |
| `client.getMemory` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.system.getMemory` | 删除 | 仅转发到当前 Resource |
| `client.getProfileStatus` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.system.getProfileStatus` | 删除 | 仅转发到当前 Resource |
| `client.getScheduledTask` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.schedules.getTask` | 删除 | 仅转发到当前 Resource |
| `client.getScheduledTaskStatus` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.schedules.getStatus` | 删除 | 仅转发到当前 Resource |
| `client.getSession` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.get` | 删除 | 仅转发到当前 Resource |
| `client.getSessionGoal` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.getGoal` | 删除 | 仅转发到当前 Resource |
| `client.getSessionMcp` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.system.getSessionMcp` | 删除 | 仅转发到当前 Resource |
| `client.getSessionState` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.getState` | 删除 | 仅转发到当前 Resource |
| `client.getSessionUsage` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.getUsage` | 删除 | 仅转发到当前 Resource |
| `client.getSettings` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.system.getSettings` | 删除 | 仅转发到当前 Resource |
| `client.getTerminal` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.terminals.get` | 删除 | 仅转发到当前 Resource |
| `client.gitCommit` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.development.gitCommit` | 删除 | 仅转发到当前 Resource |
| `client.handleChannelMessage` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.channels.handleMessage` | 删除 | 仅转发到当前 Resource |
| `client.health` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.protocol.health` | 删除 | 仅转发到当前 Resource |
| `client.initProfile` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.system.initProfile` | 删除 | 仅转发到当前 Resource |
| `client.initProject` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.projects.init` | 删除 | 仅转发到当前 Resource |
| `client.inspectProject` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.projects.inspect` | 删除 | 仅转发到当前 Resource |
| `client.installLocalPlugin` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.plugins.installLocal` | 删除 | 仅转发到当前 Resource |
| `client.installPluginArchive` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.plugins.installArchive` | 删除 | 仅转发到当前 Resource |
| `client.installPluginGit` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.plugins.installGit` | 删除 | 仅转发到当前 Resource |
| `client.interruptSession` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.interrupt` | 删除 | 仅转发到当前 Resource |
| `client.listAgentPersonas` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.development.listAgentPersonas` | 删除 | 仅转发到当前 Resource |
| `client.listCommands` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.system.listCommands` | 删除 | 仅转发到当前 Resource |
| `client.listContextPlugins` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.system.listContextPlugins` | 删除 | 仅转发到当前 Resource |
| `client.listEvents` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.events.list` | 删除 | 仅转发到当前 Resource |
| `client.listHooks` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.development.listHooks` | 删除 | 仅转发到当前 Resource |
| `client.listJobs` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.jobs.list` | 删除 | 仅转发到当前 Resource |
| `client.listMemory` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.system.listMemory` | 删除 | 仅转发到当前 Resource |
| `client.listMessageParts` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.listMessageParts` | 删除 | 仅转发到当前 Resource |
| `client.listMessages` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.listMessages` | 删除 | 仅转发到当前 Resource |
| `client.listModels` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.providers.listModels` | 删除 | 仅转发到当前 Resource |
| `client.listOutputStyles` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.system.listOutputStyles` | 删除 | 仅转发到当前 Resource |
| `client.listPendingChannelDeliveries` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.channels.listPendingDeliveries` | 删除 | 仅转发到当前 Resource |
| `client.listPermissions` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.permissions.list` | 删除 | 仅转发到当前 Resource |
| `client.listPlugins` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.plugins.list` | 删除 | 仅转发到当前 Resource |
| `client.listProjects` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.projects.list` | 删除 | 仅转发到当前 Resource |
| `client.listProviders` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.providers.listProviders` | 删除 | 仅转发到当前 Resource |
| `client.listScheduledRuns` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.schedules.listRuns` | 删除 | 仅转发到当前 Resource |
| `client.listScheduledTasks` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.schedules.listTasks` | 删除 | 仅转发到当前 Resource |
| `client.listSessions` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.list` | 删除 | 仅转发到当前 Resource |
| `client.listSkills` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.development.listSkills` | 删除 | 仅转发到当前 Resource |
| `client.listTerminals` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.terminals.list` | 删除 | 仅转发到当前 Resource |
| `client.patchSettings` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.system.patchSettings` | 删除 | 仅转发到当前 Resource |
| `client.previewPluginArchive` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.plugins.previewArchive` | 删除 | 仅转发到当前 Resource |
| `client.previewPluginGit` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.plugins.previewGit` | 删除 | 仅转发到当前 Resource |
| `client.promoteQueuedPrompt` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.promoteQueuedPrompt` | 删除 | 仅转发到当前 Resource |
| `client.readJob` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.jobs.read` | 删除 | 仅转发到当前 Resource |
| `client.readTerminal` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.terminals.read` | 删除 | 仅转发到当前 Resource |
| `client.rebindProject` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.projects.rebind` | 删除 | 仅转发到当前 Resource |
| `client.recordChannelDelivery` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.channels.recordDelivery` | 删除 | 仅转发到当前 Resource |
| `client.reloadPlugins` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.plugins.reload` | 删除 | 仅转发到当前 Resource |
| `client.rememberSession` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.remember` | 删除 | 仅转发到当前 Resource |
| `client.removeCustomProvider` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.providers.removeCustomProvider` | 删除 | 仅转发到当前 Resource |
| `client.removeMemory` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.system.removeMemory` | 删除 | 仅转发到当前 Resource |
| `client.removeScheduledTask` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.schedules.removeTask` | 删除 | 仅转发到当前 Resource |
| `client.removeSkill` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.development.removeSkill` | 删除 | 仅转发到当前 Resource |
| `client.renameProject` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.projects.rename` | 删除 | 仅转发到当前 Resource |
| `client.repairAttachmentStorage` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.attachments.repairStorage` | 删除 | 仅转发到当前 Resource |
| `client.replyPermission` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.permissions.reply` | 删除 | 仅转发到当前 Resource |
| `client.resizeTerminal` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.terminals.resize` | 删除 | 仅转发到当前 Resource |
| `client.resumeInterruptedRun` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.resumeInterruptedRun` | 删除 | 仅转发到当前 Resource |
| `client.rewindSession` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.rewind` | 删除 | 仅转发到当前 Resource |
| `client.scanAttachmentStorage` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.attachments.scanStorage` | 删除 | 仅转发到当前 Resource |
| `client.sendJob` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.jobs.send` | 删除 | 仅转发到当前 Resource |
| `client.setProjectDefaultShell` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.projects.setDefaultShell` | 删除 | 仅转发到当前 Resource |
| `client.setProjectPinned` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.projects.setPinned` | 删除 | 仅转发到当前 Resource |
| `client.setScheduledRunUnread` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.schedules.setRunUnread` | 删除 | 仅转发到当前 Resource |
| `client.signalTerminal` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.terminals.signal` | 删除 | 仅转发到当前 Resource |
| `client.startDream` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.system.startDream` | 删除 | 仅转发到当前 Resource |
| `client.streamEvents` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.events.stream` | 删除 | 仅转发到当前 Resource |
| `client.streamTerminalEvents` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.terminals.streamEvents` | 删除 | 仅转发到当前 Resource |
| `client.triggerScheduledTask` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.schedules.triggerTask` | 删除 | 仅转发到当前 Resource |
| `client.uninstallPlugin` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.plugins.uninstall` | 删除 | 仅转发到当前 Resource |
| `client.updateCustomProvider` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.providers.updateCustomProvider` | 删除 | 仅转发到当前 Resource |
| `client.updateScheduledTask` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.schedules.updateTask` | 删除 | 仅转发到当前 Resource |
| `client.updateSession` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.update` | 删除 | 仅转发到当前 Resource |
| `client.updateSessionGoal` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.sessions.updateGoal` | 删除 | 仅转发到当前 Resource |
| `client.uploadAttachment` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.attachments.upload` | 删除 | 仅转发到当前 Resource |
| `client.waitJob` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.jobs.wait` | 删除 | 仅转发到当前 Resource |
| `client.writeTerminal` | `packages/client/src/transport/http-client.ts` | 无生产调用者；旧 contract/兼容测试/迁移文档 | `client.terminals.write` | 删除 | 仅转发到当前 Resource |
| `client.transport` | `packages/client/src/transport/http-client.ts` | 无 | Resource 内部持有 `HttpTransport` | 删除 | 泄露底层传输实现，无当前外部职责 |
| `client.sse` | `packages/client/src/transport/http-client.ts` | 无 | `events` / `terminals` Resource 内部持有 | 删除 | 泄露底层 SSE 实现 |
| `client.baseUrl` | `packages/client/src/transport/http-client.ts` | 仅旧公共表面测试/文档 | 构造参数 | 删除 | 只读透传底层 transport |
| `client.token` | `packages/client/src/transport/http-client.ts` | 仅旧公共表面测试/文档 | 构造参数 | 删除 | 只读透传凭据，扩大泄露面 |
| `client.fetchImpl` | `packages/client/src/transport/http-client.ts` | 仅旧公共表面测试/文档 | Resource 内部传输 | 删除 | 只读透传实现细节 |
| A/B/C phase、ledger、integrity/removal gate、compat release evidence | `scripts/client-compat-*`、`.github/workflows/tag-release.yml` | 根 scripts/workflow | `release-safety.mjs` + 普通稳定发行 | 删除 | clean-slate 不再维护双发行窗口 |
| 旧 facade 迁移表 | 已删除的 client-public-api-migration 文档 | 旧 public-api 测试 | 当前 Resource 文档 | 删除 | 当前版本不提供旧 API 迁移承诺 |

## 保留项

| 符号/字符串或命中族 | 主要定义位置 | 当前调用者 | 当前入口 | 结论 | 理由 |
|---|---|---|---|---|---|
| OpenAI-compatible Provider | `packages/api`、Provider 配置 | Server/Desktop 当前 Provider 流程 | 当前 Provider API | 保留 | 外部互操作能力，不是 OpenHarness 历史入口 |
| Codex/Claude plugin converter | `packages/plugin-converters` | CLI/Desktop 当前显式导入 | converter API | 保留 | 主动导入外部格式 |
| capability / attachment capability | `packages/protocol`、attachment routing | Client/Server 当前请求 | 精确能力与路由检查 | 保留 | 当前模型能力路由 |
| Windows/WSL/PowerShell/Bash 分支 | `packages/environment`、`packages/tools`、Desktop/CLI | 当前平台启动与 shell 执行 | 平台选择器 | 保留 | 平台适配 |
| transaction、rollback、retry、cancel、recovery、safe fallback | services/server/runtime | 当前运行、恢复和清理路径 | 当前领域服务 | 保留 | 可靠性与安全失败，不承担旧格式转换 |
| HTTP 路由扫描命中 | `packages/server/src/http/routes` | 当前 Client Resource | 当前 REST 路由 | 保留 | 8A 未发现已被替代的重复 Client 专用路由 |
| CLI command/option 扫描命中（除 `--bare`） | `apps/cli/src` | 当前 CLI | 当前命令树 | 保留 | 都有当前用户流程 |

## 已识别、由后续 clean-slate 批次处理

| 符号/字符串 | 定义文件 | 当前调用者 | 当前替代入口 | 结论 | 处理批次 |
|---|---|---|---|---|---|
| `--bare` / `options.bare` | `apps/cli/src/index.ts` | CLI 启动参数 | `--no-plugins` / `options.plugins` | 删除 | 8C |
| 旧 shell 标量、`legacyShellDescriptor` | environment/tools | 环境与 shell 测试 | `shellDescriptor` | 删除 | 8C |
| `.claude/skills` 扫描 | skills | skills 发现测试 | `.agents/skills`、`.openharness-ts/skills` | 删除 | 8C |
| plugin manifest compatibility / environment aliases / project-local scope | plugins/agent-runtime/converters | 插件加载与转换测试 | 当前 Native Plugin schema、user/managed scope | 删除 | 8C |
| 历史数据库 migration 与旧配置/schema 字段 | services/config/protocol | 启动与数据库测试 | 单一当前 schema 基线 | 删除 | 8D |
| 旧/未来协议协商降级 | protocol/client/server | 首次业务请求 | 精确 `/capabilities` 握手 | 删除并提升版本 | 8D |

## 结论

8A 只删除 Client 顶层 facade 和与其绑定的发行治理。当前 Resource、外部格式互操作、平台适配、事务、恢复、重试、取消和安全失败路径均保留。后续批次的删除候选没有提前放入 active forbidden 数组，避免在它们尚未原子删除时让架构门禁失效。
