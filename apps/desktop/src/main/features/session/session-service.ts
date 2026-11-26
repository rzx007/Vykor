/**
 * 桌面主进程的会话入口（兼容门面）。
 *
 * 拆分后内部委派给：
 * 1. DaemonConnectionService：守护进程生命周期、连接与 Client 单例/刷新
 * 2. SessionSubscriptionService：会话订阅、快照与 SSE 增量推送
 * 3. SessionOperations：会话生命周期、Prompt、Permission、Goal 与项目操作
 */
import { app, BrowserWindow, dialog, type OpenDialogOptions, type WebContents } from "electron"
import { getDataRoot, getWorkspacesDir, isHiddenManagedProjectPath } from "@vykor/host-config/paths"

import type { HttpTransport, VykorClient } from "@rzx/client"
import type { PluginAppConversationRequest } from "@vykor/protocol"
import { SystemResource } from "@vykor/daemon-admin/configuration"
import { KnowledgeResource } from "@vykor/daemon-admin/knowledge"
import { CommandCatalogResource, DevelopmentResource } from "@vykor/daemon-admin/workspace"
import { ProjectResource } from "./project-resource"
import type {
  CheckoutDesktopProjectBranchInput,
  CloseDesktopAuxSessionInput,
  CompactDesktopSessionInput,
  CreateDesktopProjectBranchInput,
  CreateDesktopSessionInput,
  DesktopBootstrapData,
  DesktopCommandCatalogEntry,
  DesktopCompactSessionResult,
  DesktopDaemonStatus,
  DesktopPermissionMode,
  DesktopProject,
  DesktopProjectDetails,
  DesktopProjectDirectory,
  DesktopSessionRecord,
  DesktopSessionLists,
  DesktopSessionSearchResult,
  SearchSessionsOptions,
  DesktopSessionView,
  DesktopAgentActivity,
  ReadDesktopAgentActivityInput,
  DesktopSessionUpdateAck,
  DesktopSessionUpdateAckResult,
  DesktopSessionResyncRequest,
  EditLatestDesktopPromptInput,
  ForkDesktopSessionInput,
  InterruptDesktopSessionInput,
  PromoteDesktopQueuedPromptInput,
  CancelDesktopQueuedPromptInput,
  OpenDesktopAuxSessionInput,
  PinDesktopSessionInput,
  PinDesktopProjectInput,
  RenameDesktopProjectInput,
  RenameDesktopSessionInput,
  ReplyDesktopPermissionInput,
  SetDefaultDesktopProjectShellInput,
  SendDesktopPromptInput,
  SetDefaultDesktopModelInput,
  SetDefaultDesktopPermissionModeInput,
  UpdateDesktopSessionModelInput,
  UpdateDesktopSessionPermissionModeInput,
  UpdateDesktopSessionEffortInput,
  UpdateDesktopSessionPluginSelectionInput,
  GetDesktopContextUsageInput,
  GetDesktopSessionGoalInput,
  CreateDesktopSessionGoalInput,
  UpdateDesktopSessionGoalInput,
  DesktopSessionGoalActionInput,
  SessionGoal,
} from "../../../shared/session-types"
import { resolveDesktopAttachmentSupport } from "../../../shared/attachment-types"
import { IpcEvents } from "../../../shared/ipc-channels"
import { requireDesktopPluginCapabilities } from "../../../shared/plugin-capabilities"
import type { DesktopContextUsageSnapshot } from "../../../shared/context-usage-types"
import {
  isLegacyOutsideProjectWorkspacePath,
  normalizeWorkspacePath,
} from "./outside-project-workspace"
import { isChannelSessionMetadata } from "../../../shared/channel-types"
import { workspaceService } from "../workspace/workspace-service"
import { readToolImagePreview } from "./read-tool-image-preview"
import { readDesktopWorkflows } from "./read-workflows"
import type {
  DesktopWorkflowInput,
  DesktopWorkflowCancelInput,
  DesktopWorkflowSnapshot,
} from "../../../shared/workflow-types"
import { resolveDesktopRuntimeSnapshot } from "./runtime-selection"
import { DaemonConnectionService } from "./daemon-connection-service"
import { browserAgentService } from "../browser/browser-agent-service"
import { startBrowserBridge } from "../browser/browser-bridge"
import { getDesktopPreferences } from "../settings/desktop-preferences"
import type { ComputerInteraction } from "../computer/interaction"
import { ComputerPromptNotSubmittedError } from "../computer/computer-bridge"
import type { DesktopComputerControl } from "../../../shared/computer-types"
import { SessionSubscriptionService, toDesktopSessionRecord } from "./session-subscription-service"
import { GlobalActivitySubscriptionService } from "../activity/global-activity-subscription-service"
import type { DesktopActivityUpdate } from "../../../shared/activity-types"
import {
  normalizePermissionMode,
  requirePermissionMode,
  requireString,
  resolveProviderForModel,
  SessionOperations,
  toDesktopProject,
} from "./session-operations"

export type DesktopSessionConnection = Pick<
  DaemonConnectionService,
  | "getClient"
  | "getDaemonStatus"
  | "onInvalidated"
  | "refreshClient"
  | "restart"
  | "switchDataDirectory"
  | "dispose"
  | "freezeForDataRootMigration"
> & Partial<Pick<DaemonConnectionService, "getTransport" | "getComputerBridge" | "revokeComputerRun" | "revokeComputerApp" | "replyComputerApproval" | "pauseComputer" | "resumeComputer" | "setComputerCapture" | "confirmComputerCleanup" | "disconnectComputer" | "closeComputerAdmission" | "invalidateComputerView" | "yieldComputerInputToBrowser">>

export class DesktopSessionService {
  async readAgentActivity(owner: WebContents, input: ReadDesktopAgentActivityInput): Promise<DesktopAgentActivity | null> {
    const sessionId = requireString(input?.sessionId, "会话 ID")
    const jobId = requireString(input?.jobId, "任务 ID")
    const runId = requireString(input?.runId, "运行 ID")
    const token = this.subscriptions.getOwnerSessionToken(owner.id, sessionId)
    if (!token) throw new Error("请先打开所属会话。")
    const client = await this.agentClient()
    if (this.subscriptions.getOwnerSessionToken(owner.id, sessionId) !== token) throw new Error("会话已切换。")
    const read = await client.jobs.read({ kind: "agent", jobId, runId }, { sessionId, maxChars: 1, signal: AbortSignal.timeout(10_000) })
    if (this.subscriptions.getOwnerSessionToken(owner.id, sessionId) !== token) throw new Error("会话已切换。")
    const job = read.snapshot
    if (job.id !== jobId || job.kind !== "agent" || job.ownerSession !== sessionId || job.status !== "running" ||
        job.target.kind !== "agent" || job.target.jobId !== jobId || job.target.runId !== runId) return null
    const activity = asRecord(read.details?.activity)
    if (activity?.runId !== runId) return null
    const model = asRecord(activity.model)
    if (!model || typeof model.startedAt !== "number" || !Number.isFinite(model.startedAt)) return { runId }
    return { runId, model: {
      startedAt: model.startedAt,
      ...(typeof model.lastStreamAt === "number" && Number.isFinite(model.lastStreamAt) ? { lastStreamAt: model.lastStreamAt } : {}),
      ...(typeof model.lastProgressAt === "number" && Number.isFinite(model.lastProgressAt) ? { lastProgressAt: model.lastProgressAt } : {}),
    } }
  }

  async readWorkflows(
    owner: WebContents,
    input: DesktopWorkflowInput
  ): Promise<DesktopWorkflowSnapshot> {
    const sessionId = requireString(input?.sessionId, "会话 ID")
    const token = this.subscriptions.getOwnerSessionToken(owner.id, sessionId)
    if (!token || this.subscriptions.getOwnerSessionId(owner.id) !== sessionId)
      throw new Error("请先打开所属会话。")
    const client = await this.agentClient()
    if (this.subscriptions.getOwnerSessionToken(owner.id, sessionId) !== token)
      throw new Error("会话已切换。")
    if (input.jobId !== undefined && !input.jobId.trim()) throw new Error("无效的编排 ID。")
    const snapshot = await readDesktopWorkflows(client, sessionId, input.jobId)
    if (this.subscriptions.getOwnerSessionToken(owner.id, sessionId) !== token)
      throw new Error("会话已切换。")
    return snapshot
  }

  async cancelWorkflow(owner: WebContents, input: DesktopWorkflowCancelInput): Promise<void> {
    const sessionId = requireString(input?.sessionId, "会话 ID")
    const target = input?.target
    if (target?.kind !== "workflow" || !target.jobId?.trim()) throw new Error("编排目标无效。")
    const token = this.subscriptions.getOwnerSessionToken(owner.id, sessionId)
    if (
      !token ||
      this.subscriptions.getOwnerSessionId(owner.id) !== sessionId
    )
      throw new Error("只能停止当前会话所属的编排。")
    const client = await this.agentClient()
    if (this.subscriptions.getOwnerSessionToken(owner.id, sessionId) !== token)
      throw new Error("会话已切换。")
    await client.jobs.cancel(target, { sessionId, reason: "用户在编排面板中停止了执行" })
  }
  readonly connection: DesktopSessionConnection
  readonly subscriptions = new SessionSubscriptionService()
  readonly activitySubscriptions = new GlobalActivitySubscriptionService(
    undefined,
    (ownerId, sessionIds) => this.subscriptions.closeDeletedSessions(ownerId, sessionIds)
  )
  readonly operations = new SessionOperations()
  private readonly pendingComputerPrompts = new Map<string, Set<{ stop: AbortController; view: AbortController }>>()

  constructor(connection?: DesktopSessionConnection) {
    this.connection = connection ?? new DaemonConnectionService({
      onConnected: ({ url, token }) => startBrowserBridge({
        baseUrl: url,
        token,
        releaseComputerInput: (sessionId) => this.connection.yieldComputerInputToBrowser?.(sessionId),
        getOwnerSessionToken: (ownerId, sessionId) =>
          this.subscriptions.getOwnerSessionToken(ownerId, sessionId),
      }),
      onComputerDaemonRestarted: (client) => this.notifyDaemonRestart(client),
    })
    this.connection.onInvalidated(() => this.subscriptions.clearAll())
  }

  async listSessions(): Promise<DesktopSessionLists> {
    const client = await this.agentClient()
    const allSessions = await client.sessions.list({ includeArchived: true, limit: 400 })
    return {
      sessions: sortSessions(
        allSessions
          .filter((session) => session.storage !== "memory" && session.status !== "archived")
          .map(toDesktopSessionRecord)
      ),
      archivedSessions: sortSessions(
        allSessions
          .filter((session) => session.storage !== "memory" && session.status === "archived")
          .map(toDesktopSessionRecord)
      ),
    }
  }

  async searchSessions(input: SearchSessionsOptions): Promise<DesktopSessionSearchResult[]> {
    const query = requireString(input?.query, "query")
    if (query.length > 256) throw new Error("搜索关键词不能超过 256 个字符")
    const client = await this.agentClient()
    const results = await client.sessions.search({ query, limit: 30 })
    return results.map((result) => ({ ...result, session: toDesktopSessionRecord(result.session) }))
  }

  async bootstrap(): Promise<DesktopBootstrapData> {
    workspaceService.configureAllowedRoots({
      configDir: getDataRoot(),
      workspacesDir: getWorkspacesDir(),
    })
    const client = await this.agentClient()
    const transport = await this.daemonTransport(client)
    const [settings, providers, allSessions, projectRecords, capabilities] = await Promise.all([
      new SystemResource(transport).getSettings(),
      client.runtime.listModels(),
      client.sessions.list({ includeArchived: true, limit: 400 }),
      new ProjectResource(transport).list(),
      client.protocol.capabilities(),
    ])
    requireDesktopPluginCapabilities(capabilities)
    const sessions = allSessions
      .filter((session) => session.storage !== "memory" && session.status !== "archived")
      .map(toDesktopSessionRecord)
    const archivedSessions = allSessions
      .filter((session) => session.storage !== "memory" && session.status === "archived")
      .map(toDesktopSessionRecord)
    const models = providers.flatMap((provider) => provider.models)
    const runtimeSnapshot = resolveDesktopRuntimeSnapshot(models, {
      model: settings["model"],
      provider: settings["provider"],
    })
    const defaultModel =
      settings.modelDisabled === true ? null : (runtimeSnapshot.defaultModel ?? null)
    const defaultProvider = runtimeSnapshot.defaultProvider
    const defaultPermissionMode = readSettingsPermissionMode(settings)

    const channelSessionCwds = new Set(
      allSessions
        .filter((session) => isChannelSessionMetadata(session.metadata ?? {}))
        .map((session) => normalizeWorkspacePath(session.cwd))
    )
    const documentsDir = app.getPath("documents")
    const projects = await Promise.all(
      projectRecords
        .filter(
          (project) =>
            !isLegacyOutsideProjectWorkspacePath(project.path, documentsDir) &&
            !isHiddenManagedProjectPath(project.path) &&
            !channelSessionCwds.has(normalizeWorkspacePath(project.path))
        )
        .map(toDesktopProject)
    )

    return {
      connected: true,
      projects,
      sessions: sortSessions(sessions),
      archivedSessions: sortSessions(archivedSessions),
      models: runtimeSnapshot.models,
      defaultModel,
      ...(defaultProvider ? { defaultProvider } : {}),
      defaultPermissionMode,
      attachments: resolveDesktopAttachmentSupport(capabilities, {
        isPackaged: app.isPackaged,
        forceDisable: process.env.VYKOR_DESKTOP_ATTACHMENTS === "0",
      }),
      outsideProjectWorkspaceRoot: getWorkspacesDir(),
    }
  }

  getDaemonStatus(): DesktopDaemonStatus {
    return this.connection.getDaemonStatus()
  }

  async chooseProject(webContents: WebContents): Promise<DesktopProjectDirectory | null> {
    const owner = BrowserWindow.fromWebContents(webContents) ?? undefined
    const options: OpenDialogOptions = {
      title: "选择项目目录",
      properties: ["openDirectory", "createDirectory"],
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    const path = result.filePaths[0]
    if (result.canceled || !path) return null
    return await this.readLocalProjectDirectory(path)
  }

  readLocalProjectDirectory(path: string): Promise<DesktopProjectDirectory> {
    return this.operations.readLocalProjectDirectory(path)
  }

  async inspectProject(inputPath: string): Promise<DesktopProjectDetails> {
    const client = await this.projectInspectionClient()
    return await this.operations.inspectProject(client, inputPath)
  }

  async listCommands(cwdInput: string): Promise<DesktopCommandCatalogEntry[]> {
    const client = { system: new CommandCatalogResource(await this.daemonTransport()) }
    return await this.operations.listCommands(client, cwdInput)
  }

  async listContextPlugins(cwdInput: string) {
    const client = { system: new KnowledgeResource(await this.daemonTransport()) }
    return await this.operations.listContextPlugins(client, cwdInput)
  }

  async compactSession(input: CompactDesktopSessionInput): Promise<DesktopCompactSessionResult> {
    const client = await this.agentClient()
    return await this.operations.compactSession(client, input)
  }

  async getGoal(input: GetDesktopSessionGoalInput): Promise<SessionGoal | null> {
    const client = await this.agentClient()
    return await this.operations.getGoal(client, input)
  }

  async getMessagePart(
    input: import("../../../shared/session-types").GetDesktopMessagePartInput
  ): Promise<import("../../../shared/session-types").DesktopSessionPart> {
    const client = await this.agentClient()
    for (const value of [input.sessionId, input.messageId, input.partId]) {
      if (typeof value !== "string" || !value.trim())
        throw new Error("会话、消息和内容 ID 不能为空。")
    }
    return (await client.sessions.getMessagePart(
      input.sessionId,
      input.messageId,
      input.partId
    )) as import("../../../shared/session-types").DesktopSessionPart
  }

  async readToolImagePreview(
    input: import("../../../shared/session-types").GetDesktopMessagePartInput
  ): Promise<import("../../../shared/attachment-types").DesktopAttachmentPreview> {
    const part = await this.getMessagePart(input)
    const url = this.connection.getDaemonStatus().url
    if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname))
      throw new Error("远程后台的本地图片暂不支持预览")
    return await readToolImagePreview(part)
  }

  async createGoal(input: CreateDesktopSessionGoalInput): Promise<SessionGoal> {
    const client = await this.agentClient()
    return await this.operations.createGoal(client, input)
  }

  async updateGoal(input: UpdateDesktopSessionGoalInput): Promise<SessionGoal> {
    const client = await this.agentClient()
    return await this.operations.updateGoal(client, input)
  }

  async goalAction(input: DesktopSessionGoalActionInput): Promise<SessionGoal> {
    const client = await this.agentClient()
    return await this.operations.goalAction(client, input)
  }

  async checkoutProjectBranch(
    input: CheckoutDesktopProjectBranchInput
  ): Promise<DesktopProjectDetails> {
    const client = await this.projectInspectionClient()
    return await this.operations.checkoutProjectBranch(client, input)
  }

  async createProjectBranch(
    input: CreateDesktopProjectBranchInput
  ): Promise<DesktopProjectDetails> {
    const client = await this.projectInspectionClient()
    return await this.operations.createProjectBranch(client, input)
  }

  async createSession(input: CreateDesktopSessionInput): Promise<DesktopSessionRecord> {
    const client = await this.agentClient()
    const system = new SystemResource(await this.daemonTransport(client))
    return await this.operations.createSession({ sessions: client.sessions, runtime: client.runtime, system }, input)
  }

  async renameProject(input: RenameDesktopProjectInput): Promise<DesktopProject> {
    const client = { projects: new ProjectResource(await this.daemonTransport()) }
    return await this.operations.renameProject(client, input)
  }

  async setProjectPinned(input: PinDesktopProjectInput): Promise<DesktopProject> {
    const client = { projects: new ProjectResource(await this.daemonTransport()) }
    return await this.operations.setProjectPinned(client, input)
  }

  async setProjectDefaultShell(input: SetDefaultDesktopProjectShellInput): Promise<DesktopProject> {
    const client = { projects: new ProjectResource(await this.daemonTransport()) }
    return await this.operations.setProjectDefaultShell(client, input)
  }

  async removeProject(projectId: string): Promise<void> {
    const client = { projects: new ProjectResource(await this.daemonTransport()) }
    await this.operations.removeProject(client, projectId)
  }

  async resolveProjectDirectory(projectIdInput: string): Promise<string> {
    const client = { projects: new ProjectResource(await this.daemonTransport()) }
    return await this.operations.resolveProjectDirectory(client, projectIdInput)
  }

  async rebindProject(
    webContents: WebContents,
    projectIdInput: string
  ): Promise<DesktopProject | null> {
    const owner = BrowserWindow.fromWebContents(webContents) ?? undefined
    const options: OpenDialogOptions = {
      title: "重新绑定项目目录",
      properties: ["openDirectory"],
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    const path = result.filePaths[0]
    if (result.canceled || !path) return null
    const client = { projects: new ProjectResource(await this.daemonTransport()) }
    const project = await client.projects.rebind(requireString(projectIdInput, "Project ID"), path)
    return await toDesktopProject(project)
  }

  async openSession(webContents: WebContents, sessionIdInput: string): Promise<DesktopSessionView> {
    const client = await this.agentClient()
    return await this.subscriptions.openSession(client, webContents, sessionIdInput)
  }

  async checkPromptAccepted(input: { sessionId: string; inputId: string }): Promise<boolean> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const inputId = requireString(input.inputId, "输入 ID")
    const client = await this.agentClient()
    const snapshot = await client.sessions.getState(sessionId)
    return snapshot.inputs.some((value) => value.id === inputId)
  }

  acknowledgeSessionUpdate(
    ownerId: number,
    ack: DesktopSessionUpdateAck
  ): DesktopSessionUpdateAckResult {
    return this.subscriptions.acknowledgeUpdate(ownerId, ack)
  }

  requestSessionUpdateResync(
    ownerId: number,
    request: DesktopSessionResyncRequest
  ): DesktopSessionUpdateAckResult {
    return this.subscriptions.requestUpdateResync(ownerId, request)
  }

  async openActivity(webContents: WebContents): Promise<DesktopActivityUpdate> {
    const client = await this.agentClient()
    return this.activitySubscriptions.open(client, webContents)
  }

  closeSession(webContentsId: number): void {
    this.subscriptions.closeSession(webContentsId)
  }

  async openAuxSession(
    webContents: WebContents,
    input: OpenDesktopAuxSessionInput
  ): Promise<DesktopSessionView> {
    const client = await this.agentClient()
    return await this.subscriptions.openAuxSession(client, webContents, input)
  }

  closeAuxSession(webContentsId: number, input: CloseDesktopAuxSessionInput): void {
    this.subscriptions.closeAuxSession(webContentsId, input)
  }

  async sendPrompt(input: SendDesktopPromptInput, pluginAppContexts?: PluginAppConversationRequest[]): Promise<void> {
    const client = await this.agentClient()
    await this.operations.sendPrompt(client, input, pluginAppContexts)
  }

  async sendComputerPrompt(
    owner: WebContents,
    input: SendDesktopPromptInput,
    authorizeWindow: () => void,
    ownerSignal: AbortSignal,
    interaction?: ComputerInteraction,
  ): Promise<void> {
    const sessionId = requireString(input?.sessionId, "会话 ID")
    if (input.delivery === "steer" || input.expectedActiveRunId !== undefined || input.pluginAppContextIds?.length)
      throw new Error("电脑操作需要从主聊天发起一条新的用户消息。")
    const submission = { stop: new AbortController(), view: new AbortController() }
    const ordinarySignal = AbortSignal.any([ownerSignal, submission.stop.signal])
    const signal = AbortSignal.any([ordinarySignal, submission.view.signal])
    let requestedViewWasReset = false
    const authorize = (allowControlledReset = false) => {
      authorizeWindow()
      signal.throwIfAborted()
      const active = this.subscriptions.getOwnerSessionId(owner.id)
      if (active !== sessionId && !(allowControlledReset && active === undefined)) throw new Error("会话已切换。")
    }
    const pending = this.pendingComputerPrompts.get(sessionId) ?? new Set()
    pending.add(submission)
    this.pendingComputerPrompts.set(sessionId, pending)
    try {
      await this.operations.sendPrompt({
        sessions: { admitPrompt: async (id, prompt) => {
          let privateSubmit = false
          try {
            authorize()
            const bridge = await this.connection.getComputerBridge?.(() => authorize(requestedViewWasReset), ownerSignal, () => {
              requestedViewWasReset = this.subscriptions.getOwnerSessionId(owner.id) === sessionId
            }, interaction)
            if (!bridge) throw new Error("当前后台不支持电脑操作。")
            // Restore the current chat before admitting a run that can immediately ask for consent.
            if (requestedViewWasReset) await this.subscriptions.waitForPrimarySnapshot(owner.id, sessionId, signal)
            authorize()
            privateSubmit = true
            return await bridge.submit(id, prompt, authorize, signal, ordinarySignal)
          } catch (error) {
            if (privateSubmit && !(error instanceof ComputerPromptNotSubmittedError)) throw error
            // An ordinary message can still be sent when the view moved or the host never received its request.
            ordinarySignal.throwIfAborted()
            const client = await this.agentClient()
            ordinarySignal.throwIfAborted()
            return client.sessions.admitPrompt(id, prompt, { signal: ordinarySignal })
          }
        } },
      }, input)
    } finally {
      pending.delete(submission)
      if (!pending.size) this.pendingComputerPrompts.delete(sessionId)
    }
  }

  async editLatestPrompt(input: EditLatestDesktopPromptInput): Promise<void> {
    const interactiveUiEnabled = getDesktopPreferences().interactiveUiEnabled === true
    const client = await this.agentClient()
    await this.operations.editLatestPrompt(client, input, interactiveUiEnabled)
  }

  async promoteQueuedPrompt(input: PromoteDesktopQueuedPromptInput): Promise<void> {
    const client = await this.agentClient()
    await this.operations.promoteQueuedPrompt(client, input)
  }

  async cancelQueuedPrompt(input: CancelDesktopQueuedPromptInput): Promise<void> {
    const client = await this.agentClient()
    await this.operations.cancelQueuedPrompt(client, input)
  }

  async forkSession(input: ForkDesktopSessionInput): Promise<DesktopSessionRecord> {
    const client = await this.agentClient()
    return await this.operations.forkSession(client, input)
  }

  revokeComputerApp(appId: string): void {
    this.connection.revokeComputerApp?.(appId)
  }

  revokeComputerRun(sessionId: string, runId: string): void {
    this.connection.revokeComputerRun?.(sessionId, runId)
  }

  invalidateComputerView(nextSessionId?: string): void {
    for (const [sessionId, pending] of this.pendingComputerPrompts) {
      if (sessionId !== nextSessionId)
        for (const submission of pending) submission.view.abort(new Error("电脑操作的主聊天已切换或隐藏。"))
    }
    this.connection.invalidateComputerView?.(nextSessionId)
  }

  pauseComputer(sessionId: string, runId: string): boolean {
    return this.connection.pauseComputer?.(sessionId, runId) ?? false
  }

  disconnectComputer(): Promise<boolean> {
    this.invalidateComputerView()
    return this.connection.disconnectComputer?.() ?? Promise.resolve(true)
  }

  closeComputerAdmission(): Promise<boolean> {
    const cleanup = this.connection.closeComputerAdmission?.()
    this.invalidateComputerView()
    return cleanup ?? this.disconnectComputer()
  }

  async controlComputer({ action, sessionId, runId }: DesktopComputerControl): Promise<boolean> {
    switch (action) {
      case "pause": return this.pauseComputer(sessionId, runId)
        && (await this.connection.confirmComputerCleanup?.(sessionId, runId) ?? true)
      case "resume": return await this.connection.resumeComputer?.(sessionId, runId) ?? false
      case "disable_capture":
      case "enable_capture": return await this.connection.setComputerCapture?.(sessionId, runId, action === "enable_capture") ?? false
      case "stop": {
        const stopped = this.interruptSession({ sessionId, expectedRunId: runId })
        const [, cleaned] = await Promise.all([stopped, this.connection.confirmComputerCleanup?.(sessionId, runId)])
        return cleaned !== false
      }
    }
  }

  async interruptSession(input: InterruptDesktopSessionInput): Promise<void> {
    const sessionId = requireString(input?.sessionId, "会话 ID")
    const runId = input.expectedRunId === undefined ? undefined : requireString(input.expectedRunId, "预期运行 ID")
    this.connection.revokeComputerRun?.(sessionId, runId)
    if (!runId) {
      for (const pending of this.pendingComputerPrompts.get(sessionId) ?? []) {
        pending.stop.abort(new Error("电脑操作已停止。"))
      }
    }
    const client = await this.agentClient()
    await this.operations.interruptSession(client, input)
  }

  async replyPermission(
    input: ReplyDesktopPermissionInput, owner?: WebContents, authorizeComputer?: () => void,
  ): Promise<void> {
    const id = requireString(input?.permissionId, "权限请求 ID")
    const permission = owner && this.subscriptions.getOwnerPermission(owner.id, id)
    if (permission?.payload.computerApproval === true) {
      if (!authorizeComputer || !this.connection.replyComputerApproval || permission.status !== "pending")
        throw new Error("这次电脑操作的审批已失效。")
      if ((input.status !== "approved" && input.status !== "denied") ||
        (input.decision !== undefined && input.decision !== "once") || input.answer !== undefined) {
        throw new Error("电脑操作仅接受本次批准或拒绝。")
      }
      authorizeComputer()
      await this.connection.replyComputerApproval(permission.sessionId, id, input.status)
      return
    }
    const client = await this.agentClient()
    await this.operations.replyPermission(client, input)
  }

  async setDefaultModel(input: SetDefaultDesktopModelInput): Promise<DesktopBootstrapData> {
    const model = requireString(input.model, "模型")
    const client = await this.agentClient()
    const provider = await resolveProviderForModel(client, model, input.provider)
    if (input.effort !== undefined && typeof input.effort !== "string")
      throw new Error("推理强度必须是文本。")
    if (input.effort) {
      const known = (await client.runtime.listModels())
        .flatMap((item) => item.models)
        .find((item) => item.id === model && (!provider || item.providerName === provider))
      if (!known?.reasoningEfforts?.includes(input.effort))
        throw new Error("所选模型不支持这一推理强度。")
    }
    const system = new SystemResource(await this.daemonTransport(client))
    await system.patchSettings({
      model,
      modelDisabled: false,
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(provider ? { provider } : {}),
    })
    return await this.bootstrap()
  }

  async setDefaultPermissionMode(
    input: SetDefaultDesktopPermissionModeInput
  ): Promise<DesktopBootstrapData> {
    const permissionMode = requirePermissionMode(input.permissionMode)
    const system = new SystemResource(await this.daemonTransport())
    const settings = await system.getSettings()
    const permission = settings["permission"]
    await system.patchSettings({
      permission: {
        ...(permission && typeof permission === "object" && !Array.isArray(permission)
          ? permission
          : {}),
        mode: permissionMode,
      },
    })
    return await this.bootstrap()
  }

  async updateSessionModel(input: UpdateDesktopSessionModelInput): Promise<DesktopSessionRecord> {
    const client = await this.agentClient()
    return await this.operations.updateSessionModel(client, input)
  }

  async updateSessionPermissionMode(
    input: UpdateDesktopSessionPermissionModeInput
  ): Promise<DesktopSessionRecord> {
    const client = await this.agentClient()
    return await this.operations.updateSessionPermissionMode(client, input)
  }

  async updateSessionEffort(input: UpdateDesktopSessionEffortInput): Promise<DesktopSessionRecord> {
    const client = await this.agentClient()
    return await this.operations.updateSessionEffort(client, input)
  }

  async updateSessionPluginSelection(
    input: UpdateDesktopSessionPluginSelectionInput
  ): Promise<DesktopSessionRecord> {
    const client = await this.agentClient()
    return await this.operations.updateSessionPluginSelection(client, input)
  }

  async getContextUsage(input: GetDesktopContextUsageInput): Promise<DesktopContextUsageSnapshot> {
    const client = { system: new KnowledgeResource(await this.daemonTransport()) }
    return await this.operations.getContextUsage(client, input)
  }

  async renameSession(input: RenameDesktopSessionInput): Promise<DesktopSessionRecord> {
    const client = await this.agentClient()
    return await this.operations.renameSession(client, input)
  }

  async setSessionPinned(input: PinDesktopSessionInput): Promise<DesktopSessionRecord> {
    const client = await this.agentClient()
    return await this.operations.setSessionPinned(client, input)
  }

  async archiveSession(
    webContentsId: number,
    sessionIdInput: string
  ): Promise<DesktopSessionRecord> {
    const sessionId = requireString(sessionIdInput, "会话 ID")
    if (this.subscriptions.hasPrimary(webContentsId, sessionId)) {
      this.closeSession(webContentsId)
    }
    const client = await this.agentClient()
    const session = toDesktopSessionRecord(await client.sessions.archive(sessionId))
    const { gitSettingsService } = await import("../settings/git-settings-service")
    await gitSettingsService
      .autoCleanup()
      .catch(() => console.warn("[git] 自动清理未完成，可在 Git 设置中重新检查。"))
    return session
  }

  async deleteSession(webContentsId: number, sessionIdInput: string): Promise<string[]> {
    // Only one developer capture can exist, so stop it before the asynchronous
    // delete so nothing is readable while the session tree is being removed.
    browserAgentService.stopDeveloperDiagnostics()
    const sessionId = requireString(sessionIdInput, "会话 ID")
    if (this.subscriptions.hasPrimary(webContentsId, sessionId)) {
      this.closeSession(webContentsId)
    }
    const client = await this.agentClient()
    return await client.sessions.delete(sessionId)
  }

  async dispose(): Promise<void> {
    this.subscriptions.clearAll()
    this.activitySubscriptions.clearAll()
    await this.connection.dispose()
    await browserAgentService.dispose()
  }

  daemonTransport(client?: VykorClient): Promise<HttpTransport> {
    return this.connection.getTransport?.(client) ?? Promise.reject(new Error("此连接未提供桌面管理功能。"))
  }

  private async projectInspectionClient() {
    const transport = await this.daemonTransport()
    return { projects: new ProjectResource(transport), development: new DevelopmentResource(transport) }
  }
  onDaemonInvalidated(listener: () => void): () => void {
    return this.connection.onInvalidated(listener)
  }

  async refreshAgentClient(): Promise<VykorClient> {
    this.subscriptions.clearAll()
    const client = await this.connection.refreshClient()
    await this.activitySubscriptions.replaceClient(client)
    return client
  }

  async refreshDaemonTransport(): Promise<HttpTransport> {
    return this.daemonTransport(await this.refreshAgentClient())
  }

  async restartDaemon(options: { stopActive?: boolean } = {}): Promise<void> {
    const client = await this.connection.restart(options)
    await this.notifyDaemonRestart(client)
  }

  private async notifyDaemonRestart(client: VykorClient): Promise<void> {
    await this.activitySubscriptions.replaceClient(client)
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed())
        window.webContents.send(IpcEvents.sessionDaemonRestarted)
    }
  }

  async switchDataDirectory(
    _directory: string,
    _options: { stopActive?: boolean; storePath?: string } = {}
  ): Promise<void> {
    throw new Error("旧的只切换数据库入口已停用，请使用用户数据根迁移。")
  }

  agentClient(): Promise<VykorClient> {
    return this.connection.getClient()
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function sortSessions(sessions: DesktopSessionRecord[]): DesktopSessionRecord[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
}

function readSettingsPermissionMode(settings: Record<string, unknown>): DesktopPermissionMode {
  const permission = settings["permission"]
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) return "ask"
  return normalizePermissionMode((permission as Record<string, unknown>)["mode"]) ?? "ask"
}

export const desktopSessionService = new DesktopSessionService()
