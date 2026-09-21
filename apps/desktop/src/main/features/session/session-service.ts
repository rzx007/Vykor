/**
 * 桌面主进程的会话入口（兼容门面）。
 *
 * 拆分后内部委派给：
 * 1. DaemonConnectionService：守护进程生命周期、连接与 Client 单例/刷新
 * 2. SessionSubscriptionService：会话订阅、快照与 SSE 增量推送
 * 3. SessionOperations：会话生命周期、Prompt、Permission、Goal 与项目操作
 */
import { app, BrowserWindow, dialog, type OpenDialogOptions, type WebContents } from "electron"
import { homedir } from "node:os"
import { join } from "node:path"

import type { OpenHarnessClient } from "@openharness/client"
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
  DesktopSessionRecord,
  DesktopSessionLists,
  DesktopSessionView,
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
  GetDesktopContextUsageInput,
  GetDesktopSessionGoalInput,
  CreateDesktopSessionGoalInput,
  UpdateDesktopSessionGoalInput,
  DesktopSessionGoalActionInput,
  SessionGoal,
} from "../../../shared/session-types"
import { resolveDesktopAttachmentSupport } from "../../../shared/attachment-types"
import { requireDesktopPluginCapabilities } from "../../../shared/plugin-capabilities"
import type { DesktopContextUsageSnapshot } from "../../../shared/context-usage-types"
import {
  buildOutsideProjectRoot,
  isChannelProjectHidden,
  normalizeWorkspacePath,
} from "./outside-project-workspace"
import { isChannelSessionMetadata } from "../../../shared/channel-types"
import { workspaceService } from "../workspace/workspace-service"
import { resolveDesktopRuntimeSnapshot } from "./runtime-selection"
import { DaemonConnectionService } from "./daemon-connection-service"
import { SessionSubscriptionService, toDesktopSessionRecord } from "./session-subscription-service"
import { GlobalActivitySubscriptionService } from "../activity/global-activity-subscription-service"
import type { DesktopActivityUpdate } from "../../../shared/activity-types"
import {
  requirePermissionMode,
  requireString,
  resolveProviderForModel,
  SessionOperations,
  toDesktopProject,
} from "./session-operations"

export class DesktopSessionService {
  readonly connection = new DaemonConnectionService()
  readonly subscriptions = new SessionSubscriptionService()
  readonly activitySubscriptions = new GlobalActivitySubscriptionService(
    undefined,
    (ownerId, sessionIds) => this.subscriptions.closeDeletedSessions(ownerId, sessionIds)
  )
  readonly operations = new SessionOperations()

  async listSessions(): Promise<DesktopSessionLists> {
    const client = await this.getClient()
    const allSessions = await client.sessions.list({ includeArchived: true, limit: 400 })
    return {
      sessions: sortSessions(
        allSessions.filter((session) => session.status !== "archived").map(toDesktopSessionRecord)
      ),
      archivedSessions: sortSessions(
        allSessions.filter((session) => session.status === "archived").map(toDesktopSessionRecord)
      ),
    }
  }

  async bootstrap(): Promise<DesktopBootstrapData> {
    workspaceService.configureAllowedRoots({
      configDir: process.env.OPENHARNESS_CONFIG_DIR ?? join(homedir(), ".openharness-ts"),
      documentsPath: app.getPath("documents"),
    })
    const client = await this.getClient()
    const [settings, providers, allSessions, projectRecords, capabilities] = await Promise.all([
      client.system.getSettings(),
      client.providers.listModels(),
      client.sessions.list({ includeArchived: true, limit: 400 }),
      client.projects.list(),
      client.protocol.capabilities(),
    ])
    requireDesktopPluginCapabilities(capabilities)
    const sessions = allSessions
      .filter((session) => session.status !== "archived")
      .map(toDesktopSessionRecord)
    const archivedSessions = allSessions
      .filter((session) => session.status === "archived")
      .map(toDesktopSessionRecord)
    const models = providers.flatMap((provider) => provider.models)
    const runtimeSnapshot = resolveDesktopRuntimeSnapshot(models, {
      model: settings["model"],
      provider: settings["provider"],
    })
    const defaultModel = runtimeSnapshot.defaultModel
    const defaultProvider = runtimeSnapshot.defaultProvider
    const defaultPermissionMode = readSettingsPermissionMode(settings)

    if (!defaultModel) {
      throw new Error("没有找到可用模型，请先在 OpenHarness 设置中配置模型。")
    }

    if (runtimeSnapshot.needsModelPatch || runtimeSnapshot.needsProviderPatch) {
      await client.system.patchSettings({
        model: defaultModel,
        ...(defaultProvider ? { provider: defaultProvider } : {}),
      })
    }
    const documentsPath = app.getPath("documents")
    const channelSessionCwds = new Set(
      allSessions
        .filter((session) => isChannelSessionMetadata(session.metadata ?? {}))
        .map((session) => normalizeWorkspacePath(session.cwd))
    )
    const projects = await Promise.all(
      projectRecords
        .filter(
          (project) => !isChannelProjectHidden(project.path, channelSessionCwds, documentsPath)
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
        forceDisable: process.env.OPENHARNESS_DESKTOP_ATTACHMENTS === "0",
      }),
      outsideProjectWorkspaceRoot: buildOutsideProjectRoot(app.getPath("documents")),
    }
  }

  getDaemonStatus(): DesktopDaemonStatus {
    return this.connection.getDaemonStatus()
  }

  async chooseProject(webContents: WebContents): Promise<DesktopProjectDetails | null> {
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
    return await this.inspectProject(path)
  }

  async inspectProject(inputPath: string): Promise<DesktopProjectDetails> {
    const client = await this.getClient()
    return await this.operations.inspectProject(client, inputPath)
  }

  async listCommands(cwdInput: string): Promise<DesktopCommandCatalogEntry[]> {
    const client = await this.getClient()
    return await this.operations.listCommands(client, cwdInput)
  }

  async listContextPlugins(cwdInput: string) {
    const client = await this.getClient()
    return await this.operations.listContextPlugins(client, cwdInput)
  }

  async compactSession(input: CompactDesktopSessionInput): Promise<DesktopCompactSessionResult> {
    const client = await this.getClient()
    return await this.operations.compactSession(client, input)
  }

  async getGoal(input: GetDesktopSessionGoalInput): Promise<SessionGoal | null> {
    const client = await this.getClient()
    return await this.operations.getGoal(client, input)
  }

  async createGoal(input: CreateDesktopSessionGoalInput): Promise<SessionGoal> {
    const client = await this.getClient()
    return await this.operations.createGoal(client, input)
  }

  async updateGoal(input: UpdateDesktopSessionGoalInput): Promise<SessionGoal> {
    const client = await this.getClient()
    return await this.operations.updateGoal(client, input)
  }

  async goalAction(input: DesktopSessionGoalActionInput): Promise<SessionGoal> {
    const client = await this.getClient()
    return await this.operations.goalAction(client, input)
  }

  async checkoutProjectBranch(
    input: CheckoutDesktopProjectBranchInput
  ): Promise<DesktopProjectDetails> {
    const client = await this.getClient()
    this.operations.setEphemeralClient(client)
    return await this.operations.checkoutProjectBranch(input)
  }

  async createProjectBranch(
    input: CreateDesktopProjectBranchInput
  ): Promise<DesktopProjectDetails> {
    const client = await this.getClient()
    this.operations.setEphemeralClient(client)
    return await this.operations.createProjectBranch(input)
  }

  async createSession(input: CreateDesktopSessionInput): Promise<DesktopSessionRecord> {
    const client = await this.getClient()
    return await this.operations.createSession(client, input)
  }

  async renameProject(input: RenameDesktopProjectInput): Promise<DesktopProject> {
    const client = await this.getClient()
    return await this.operations.renameProject(client, input)
  }

  async setProjectPinned(input: PinDesktopProjectInput): Promise<DesktopProject> {
    const client = await this.getClient()
    return await this.operations.setProjectPinned(client, input)
  }

  async setProjectDefaultShell(input: SetDefaultDesktopProjectShellInput): Promise<DesktopProject> {
    const client = await this.getClient()
    return await this.operations.setProjectDefaultShell(client, input)
  }

  async removeProject(projectId: string): Promise<void> {
    const client = await this.getClient()
    await this.operations.removeProject(client, projectId)
  }

  async resolveProjectDirectory(projectIdInput: string): Promise<string> {
    const client = await this.getClient()
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
    const client = await this.getClient()
    const project = await client.projects.rebind(requireString(projectIdInput, "Project ID"), path)
    return await toDesktopProject(project)
  }

  async openSession(webContents: WebContents, sessionIdInput: string): Promise<DesktopSessionView> {
    const client = await this.getClient()
    return await this.subscriptions.openSession(client, webContents, sessionIdInput)
  }

  async openActivity(webContents: WebContents): Promise<DesktopActivityUpdate> {
    const client = await this.getClient()
    return this.activitySubscriptions.open(client, webContents)
  }

  closeSession(webContentsId: number): void {
    this.subscriptions.closeSession(webContentsId)
  }

  async openAuxSession(
    webContents: WebContents,
    input: OpenDesktopAuxSessionInput
  ): Promise<DesktopSessionView> {
    const client = await this.getClient()
    return await this.subscriptions.openAuxSession(client, webContents, input)
  }

  closeAuxSession(webContentsId: number, input: CloseDesktopAuxSessionInput): void {
    this.subscriptions.closeAuxSession(webContentsId, input)
  }

  async sendPrompt(input: SendDesktopPromptInput): Promise<void> {
    const client = await this.getClient()
    await this.operations.sendPrompt(client, input)
  }

  async editLatestPrompt(input: EditLatestDesktopPromptInput): Promise<void> {
    const client = await this.getClient()
    await this.operations.editLatestPrompt(client, input)
  }

  async promoteQueuedPrompt(input: PromoteDesktopQueuedPromptInput): Promise<void> {
    const client = await this.getClient()
    await this.operations.promoteQueuedPrompt(client, input)
  }

  async cancelQueuedPrompt(input: CancelDesktopQueuedPromptInput): Promise<void> {
    const client = await this.getClient()
    await this.operations.cancelQueuedPrompt(client, input)
  }

  async forkSession(input: ForkDesktopSessionInput): Promise<DesktopSessionRecord> {
    const client = await this.getClient()
    return await this.operations.forkSession(client, input)
  }

  async interruptSession(input: InterruptDesktopSessionInput): Promise<void> {
    const client = await this.getClient()
    await this.operations.interruptSession(client, input)
  }

  async replyPermission(input: ReplyDesktopPermissionInput): Promise<void> {
    const client = await this.getClient()
    await this.operations.replyPermission(client, input)
  }

  async setDefaultModel(input: SetDefaultDesktopModelInput): Promise<DesktopBootstrapData> {
    const model = requireString(input.model, "模型")
    const client = await this.getClient()
    const provider = await resolveProviderForModel(client, model, input.provider)
    await client.system.patchSettings({
      model,
      ...(provider ? { provider } : {}),
    })
    return await this.bootstrap()
  }

  async setDefaultPermissionMode(
    input: SetDefaultDesktopPermissionModeInput
  ): Promise<DesktopBootstrapData> {
    const permissionMode = requirePermissionMode(input.permissionMode)
    const client = await this.getClient()
    const settings = await client.system.getSettings()
    const permission = settings["permission"]
    await client.system.patchSettings({
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
    const client = await this.getClient()
    return await this.operations.updateSessionModel(client, input)
  }

  async updateSessionPermissionMode(
    input: UpdateDesktopSessionPermissionModeInput
  ): Promise<DesktopSessionRecord> {
    const client = await this.getClient()
    return await this.operations.updateSessionPermissionMode(client, input)
  }

  async updateSessionEffort(input: UpdateDesktopSessionEffortInput): Promise<DesktopSessionRecord> {
    const client = await this.getClient()
    return await this.operations.updateSessionEffort(client, input)
  }

  async getContextUsage(input: GetDesktopContextUsageInput): Promise<DesktopContextUsageSnapshot> {
    const client = await this.getClient()
    return await this.operations.getContextUsage(client, input)
  }

  async renameSession(input: RenameDesktopSessionInput): Promise<DesktopSessionRecord> {
    const client = await this.getClient()
    return await this.operations.renameSession(client, input)
  }

  async setSessionPinned(input: PinDesktopSessionInput): Promise<DesktopSessionRecord> {
    const client = await this.getClient()
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
    const client = await this.getClient()
    return toDesktopSessionRecord(await client.sessions.archive(sessionId))
  }

  async deleteSession(webContentsId: number, sessionIdInput: string): Promise<string[]> {
    const sessionId = requireString(sessionIdInput, "会话 ID")
    if (this.subscriptions.hasPrimary(webContentsId, sessionId)) {
      this.closeSession(webContentsId)
    }
    const client = await this.getClient()
    return await client.sessions.delete(sessionId)
  }

  async dispose(): Promise<void> {
    this.subscriptions.clearAll()
    this.activitySubscriptions.clearAll()
    await this.connection.dispose()
  }

  daemonClient(): Promise<OpenHarnessClient> {
    return this.connection.getClient()
  }

  async refreshDaemonClient(): Promise<OpenHarnessClient> {
    this.subscriptions.clearAll()
    const client = await this.connection.refreshClient()
    await this.activitySubscriptions.replaceClient(client)
    return client
  }

  get clientPromise(): Promise<OpenHarnessClient> | null {
    return (this.connection as unknown as { clientPromise: Promise<OpenHarnessClient> | null })
      .clientPromise
  }

  set clientPromise(promise: Promise<OpenHarnessClient> | null) {
    ;(
      this.connection as unknown as { clientPromise: Promise<OpenHarnessClient> | null }
    ).clientPromise = promise
  }

  private getClient(): Promise<OpenHarnessClient> {
    return this.connection.getClient()
  }
}

function sortSessions(sessions: DesktopSessionRecord[]): DesktopSessionRecord[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
}

function normalizePermissionMode(value: unknown): DesktopPermissionMode | undefined {
  return value === "default" || value === "plan" || value === "full_auto" ? value : undefined
}

function readSettingsPermissionMode(settings: Record<string, unknown>): DesktopPermissionMode {
  const permission = settings["permission"]
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) return "default"
  return normalizePermissionMode((permission as Record<string, unknown>)["mode"]) ?? "default"
}

export const desktopSessionService = new DesktopSessionService()
