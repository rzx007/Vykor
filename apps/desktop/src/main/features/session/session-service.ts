/**
 * 桌面主进程的会话入口：连 daemon、attach 会话、把状态推给渲染进程。
 *
 * 打开一个会话不是拉 GET /events。syncEvents(sessionId) 会先 GET /sessions/:id/state
 * 拿当前消息快照，再接 GET /events/stream 跟后续增量。发消息走 admitPrompt，与 attach 无关。
 */
import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import {
  OpenHarnessClient,
  parseCreateSessionGoalInput,
  parseUpdateSessionGoalInput,
  parseGoalActionInput,
  syncEvents,
  type OpenHarnessClientState,
  type ProjectRecord,
  type SessionAttachmentMessagePartRecord,
  type SessionMessagePartRecord,
  type SessionRecord,
  type SessionTransformationMessagePartRecord,
  type SyncEventUpdate,
} from "@openharness/client"
import { type OpenHarnessHttpServer } from "@openharness/server"
import {
  clearDaemonRegistry,
  createBearerToken,
  readDaemonRegistry,
  startOpenHarnessDaemon,
  writeDaemonRegistry,
} from "@openharness/server/daemon-host"
import { app, BrowserWindow, dialog, type OpenDialogOptions, type WebContents } from "electron"

import { IpcEvents } from "../../../shared/ipc-channels"
import type {
  CheckoutDesktopProjectBranchInput,
  CloseDesktopAuxSessionInput,
  CompactDesktopSessionInput,
  CreateDesktopProjectBranchInput,
  CreateDesktopSessionInput,
  DesktopCommandCatalogEntry,
  DesktopCompactSessionResult,
  DesktopBootstrapData,
  DesktopAuxSessionUpdate,
  DesktopDaemonStatus,
  DesktopDaemonStatusPhase,
  DesktopModel,
  DesktopProject,
  DesktopProjectDetails,
  DesktopPermissionMode,
  DesktopSessionRecord,
  DesktopSessionPart,
  DesktopStandardSessionPart,
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
  SessionUserInputItem,
  SetDefaultDesktopModelInput,
  SetDefaultDesktopPermissionModeInput,
  UpdateDesktopSessionModelInput,
  UpdateDesktopSessionPermissionModeInput,
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
import { parseDesktopContextUsageSnapshot } from "../../../shared/parse-context-usage-snapshot"
import {
  allocateOutsideProjectWorkspace,
  buildOutsideProjectRoot,
  isOutsideProjectWorkspacePath,
  removeEmptyOutsideProjectWorkspace,
} from "./outside-project-workspace"
import { workspaceService } from "../workspace/workspace-service"
import { resolveDesktopRuntimeSnapshot } from "./runtime-selection"
import { reserveSubscriptionSnapshot, SessionSubscriptionRegistry } from "./session-subscriptions"

const execFileAsync = promisify(execFile)

const primarySubscriptionSlot = "primary"
const DESKTOP_SESSION_COMMAND_NAMES = new Set(["/compact", "/goal", "/status", "/skills"])

export class DesktopSessionService {
  private clientPromise: Promise<OpenHarnessClient> | null = null
  private embeddedServer: OpenHarnessHttpServer | null = null
  private embeddedUrl: string | null = null
  private daemonStatus: DesktopDaemonStatus = createDaemonStatus("idle", "等待连接 daemon")
  private readonly subscriptions = new SessionSubscriptionRegistry()

  /**
   * 启动壳层数据：项目、侧边栏会话列表、模型与默认权限。
   * 走 GET /sessions 和 /projects，不拉某个会话的消息。
   * 对话正文要等 openSession → GET /sessions/:id/state。
   * 设置里没有可用模型时，会把解析出的默认 model/provider 写回 daemon。
   */
  async bootstrap(): Promise<DesktopBootstrapData> {
    workspaceService.configureAllowedRoots({
      configDir: process.env.OPENHARNESS_CONFIG_DIR ?? join(homedir(), ".openharness-ts"),
      documentsPath: app.getPath("documents"),
    })
    const client = await this.getClient()
    const [settings, providers, allSessions, projectRecords, capabilities] = await Promise.all([
      client.getSettings(),
      client.listModels(),
      client.listSessions({ includeArchived: true, limit: 400 }),
      client.listProjects(),
      client.capabilities(),
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
      await client.patchSettings({
        model: defaultModel,
        ...(defaultProvider ? { provider: defaultProvider } : {}),
      })
    }
    const projects = await Promise.all(
      projectRecords
        .filter((project) => !isOutsideProjectWorkspacePath(project.path, app.getPath("documents")))
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
    return this.daemonStatus
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
    const path = resolveRequiredPath(inputPath)
    const info = await stat(path)
    if (!info.isDirectory()) throw new Error("选择的项目路径不是目录。")

    const client = await this.getClient()
    const project = await toDesktopProject(await client.inspectProject(path))
    let git = false
    let branch: string | null = null
    let branches: string[] = []
    try {
      await execGit(path, ["rev-parse", "--show-toplevel"])
      git = true
      try {
        branch = parseCurrentBranch(await client.getGitBranch({ cwd: path }))
      } catch {
        branch = null
      }
      try {
        branches = await listLocalBranches(path)
      } catch {
        branches = []
      }
    } catch {
      git = false
      branch = null
      branches = []
    }

    return { project, git, branch, branches }
  }

  async listCommands(cwdInput: string): Promise<DesktopCommandCatalogEntry[]> {
    const cwd = resolveRequiredPath(cwdInput)
    const commands = await (await this.getClient()).listCommands({ cwd })
    return commands.flatMap((command): DesktopCommandCatalogEntry[] => {
      if (command.kind === "template") {
        if (!command.path) return []
        return [{ ...command, kind: "template", path: command.path }]
      }
      return DESKTOP_SESSION_COMMAND_NAMES.has(command.name)
        ? [{ ...command, kind: "session" }]
        : []
    })
  }

  async listContextPlugins(cwdInput: string) {
    return (await this.getClient()).listContextPlugins({ cwd: resolveRequiredPath(cwdInput) })
  }

  async compactSession(input: CompactDesktopSessionInput): Promise<DesktopCompactSessionResult> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const result = await (await this.getClient()).compactSession(sessionId)
    return { messageCount: result.messageCount }
  }

  async getGoal(input: GetDesktopSessionGoalInput): Promise<SessionGoal | null> {
    return await (await this.getClient()).getSessionGoal(requireString(input.sessionId, "会话 ID"))
  }

  async createGoal(input: CreateDesktopSessionGoalInput): Promise<SessionGoal> {
    const { sessionId, ...body } = input
    return await (
      await this.getClient()
    ).createSessionGoal(requireString(sessionId, "会话 ID"), parseCreateSessionGoalInput(body))
  }

  async updateGoal(input: UpdateDesktopSessionGoalInput): Promise<SessionGoal> {
    const { sessionId, goalId, ...body } = input
    return await (
      await this.getClient()
    ).updateSessionGoal(
      requireString(sessionId, "会话 ID"),
      requireString(goalId, "目标 ID"),
      parseUpdateSessionGoalInput(body)
    )
  }

  async goalAction(input: DesktopSessionGoalActionInput): Promise<SessionGoal> {
    const { sessionId, goalId, ...body } = input
    return await (
      await this.getClient()
    ).applySessionGoalAction(
      requireString(sessionId, "会话 ID"),
      requireString(goalId, "目标 ID"),
      parseGoalActionInput(body)
    )
  }

  async checkoutProjectBranch(
    input: CheckoutDesktopProjectBranchInput
  ): Promise<DesktopProjectDetails> {
    const path = resolveRequiredPath(input.path)
    const branch = requireGitBranchName(input.branch)
    await execGit(path, ["switch", branch])
    return await this.inspectProject(path)
  }

  async createProjectBranch(
    input: CreateDesktopProjectBranchInput
  ): Promise<DesktopProjectDetails> {
    const path = resolveRequiredPath(input.path)
    const branch = requireGitBranchName(input.branch)
    await execGit(path, ["check-ref-format", "--branch", branch])
    await execGit(path, ["switch", "-c", branch])
    return await this.inspectProject(path)
  }

  async createSession(input: CreateDesktopSessionInput): Promise<DesktopSessionRecord> {
    const model = requireString(input.model, "模型")
    const permissionMode = normalizePermissionMode(input.permissionMode)
    const client = await this.getClient()
    const provider = await resolveProviderForModel(client, model, input.provider)
    const projectId = input.projectId ? requireString(input.projectId, "Project ID") : undefined
    const cwd = projectId
      ? resolveRequiredPath(input.cwd)
      : await allocateOutsideProjectWorkspace(app.getPath("documents"))

    try {
      const session = await client.createSession({
        ...(projectId ? { projectId } : {}),
        cwd,
        model,
        title: "",
        metadata: {
          ...(!projectId ? { desktop: { workspaceMode: "outside_project" } } : {}),
          runtime: {
            model,
            ...(provider ? { provider } : {}),
            ...(permissionMode ? { permissionMode } : {}),
          },
        },
      })
      return toDesktopSessionRecord(session)
    } catch (error) {
      if (!projectId) await removeEmptyOutsideProjectWorkspace(cwd)
      throw error
    }
  }

  async renameProject(input: RenameDesktopProjectInput): Promise<DesktopProject> {
    const name = requireString(input.name, "项目名称")
    return await toDesktopProject(
      await (await this.getClient()).renameProject(input.projectId, name)
    )
  }

  async setProjectPinned(input: PinDesktopProjectInput): Promise<DesktopProject> {
    return await toDesktopProject(
      await (await this.getClient()).setProjectPinned(input.projectId, input.pinned)
    )
  }

  async setProjectDefaultShell(input: SetDefaultDesktopProjectShellInput): Promise<DesktopProject> {
    return await toDesktopProject(
      await (await this.getClient()).setProjectDefaultShell(input.projectId, input.shell)
    )
  }

  async removeProject(projectId: string): Promise<void> {
    await (await this.getClient()).archiveProject(requireString(projectId, "Project ID"))
  }

  async resolveProjectDirectory(projectIdInput: string): Promise<string> {
    const projectId = requireString(projectIdInput, "Project ID")
    const client = await this.getClient()
    const project = (await client.listProjects()).find((item) => item.id === projectId)
    if (!project) throw new Error(`Project ${projectId} does not exist.`)

    const info = await stat(project.path)
    if (!info.isDirectory()) throw new Error(`Project ${project.name} directory is unavailable.`)
    return project.path
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
    const project = await (
      await this.getClient()
    ).rebindProject(requireString(projectIdInput, "Project ID"), path)
    return await toDesktopProject(project)
  }

  /**
   * 挂上指定会话：先等 snapshot（历史消息），立刻返回给窗口；SSE 增量放到 pumpSession 后台推。
   * 每个窗口只有一条 primary 订阅，再 open 会关掉上一条。
   */
  async openSession(webContents: WebContents, sessionIdInput: string): Promise<DesktopSessionView> {
    const sessionId = requireString(sessionIdInput, "会话 ID")
    this.closeSession(webContents.id)

    const controller = new AbortController()
    const subscription = { controller, sessionId }
    webContents.once("destroyed", () => this.closeSession(webContents.id))
    const { snapshot, iterator } = await reserveSubscriptionSnapshot(
      this.subscriptions,
      webContents.id,
      primarySubscriptionSlot,
      subscription,
      async () => {
        const client = await this.getClient()
        return syncEvents(client, {
          sessionId,
          signal: controller.signal,
        })[Symbol.asyncIterator]()
      },
      "无法加载会话状态。"
    )
    // 等本次 IPC 返回快照后再泵 live，避免第一帧和后续更新抢道。
    setTimeout(() => {
      void this.pumpSession(webContents, primarySubscriptionSlot, sessionId, controller, iterator)
    }, 0)

    return toDesktopSessionView(snapshot.state, sessionId, snapshot.source)
  }

  closeSession(webContentsId: number): void {
    this.subscriptions.clearOwner(webContentsId)
  }

  /** 同一窗口上额外挂一个会话（对比/子会话），订阅槽是 aux:{id}，不挤掉 primary。 */
  async openAuxSession(
    webContents: WebContents,
    input: OpenDesktopAuxSessionInput
  ): Promise<DesktopSessionView> {
    const subscriptionId = requireString(input.subscriptionId, "辅助订阅 ID")
    const sessionId = requireString(input.sessionId, "会话 ID")
    const slot = auxiliarySubscriptionSlot(subscriptionId)
    const controller = new AbortController()
    const subscription = { controller, sessionId }
    const { snapshot, iterator } = await reserveSubscriptionSnapshot(
      this.subscriptions,
      webContents.id,
      slot,
      subscription,
      async () => {
        const client = await this.getClient()
        return syncEvents(client, {
          sessionId,
          signal: controller.signal,
        })[Symbol.asyncIterator]()
      },
      "无法加载辅助会话状态。"
    )
    setTimeout(() => {
      void this.pumpSession(webContents, slot, sessionId, controller, iterator, subscriptionId)
    }, 0)
    return toDesktopSessionView(snapshot.state, sessionId, snapshot.source)
  }

  closeAuxSession(webContentsId: number, input: CloseDesktopAuxSessionInput): void {
    const subscriptionId = requireString(input.subscriptionId, "辅助订阅 ID")
    this.subscriptions.delete(webContentsId, auxiliarySubscriptionSlot(subscriptionId))
  }

  /** 往已 attach 的会话排队一句用户输入。结果仍从刚才那条 SSE 订阅回来。 */
  async sendPrompt(input: SendDesktopPromptInput): Promise<void> {
    const id = requireString(input.id, "输入 ID")
    const sessionId = requireString(input.sessionId, "会话 ID")
    const items = requirePromptItems(input.items)
    const attachments = normalizePromptAttachments(input.attachments, true)
    if (!hasPromptItems(items) && attachments.length === 0) {
      throw new Error("消息内容和附件不能同时为空。")
    }
    const client = await this.getClient()
    await client.admitPrompt(sessionId, {
      id,
      items,
      attachments,
      delivery: "queue",
      metadata: {
        origin: {
          client: "desktop",
          component: "composer",
          action: "append_prompt",
        },
      },
    })
  }

  async editLatestPrompt(input: EditLatestDesktopPromptInput): Promise<void> {
    const id = requireString(input.id, "编辑请求 ID")
    const sessionId = requireString(input.sessionId, "会话 ID")
    const items = requirePromptItems(input.items)
    const sourceMessageId = requireString(input.sourceMessageId, "原消息 ID")
    const attachments = normalizePromptAttachments(input.attachments, false)
    if (!hasPromptItems(items) && attachments.length === 0) {
      throw new Error("消息内容、附件和技能不能同时为空。")
    }
    const client = await this.getClient()
    await client.editLatestPrompt(sessionId, {
      id,
      items,
      sourceMessageId,
      attachments,
      metadata: {
        origin: {
          client: "desktop",
          component: "latest-message-editor",
          action: "edit_latest_prompt",
        },
      },
    })
  }

  async promoteQueuedPrompt(input: PromoteDesktopQueuedPromptInput): Promise<void> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const inputId = requireString(input.inputId, "输入 ID")
    const queuedRunId = requireString(input.queuedRunId, "排队运行 ID")
    const expectedActiveRunId = requireString(input.expectedActiveRunId, "当前运行 ID")
    const client = await this.getClient()
    await client.promoteQueuedPrompt(sessionId, inputId, {
      queuedRunId,
      expectedActiveRunId,
    })
  }

  async cancelQueuedPrompt(input: CancelDesktopQueuedPromptInput): Promise<void> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const inputId = requireString(input.inputId, "输入 ID")
    const queuedRunId = requireString(input.queuedRunId, "排队运行 ID")
    const client = await this.getClient()
    await client.cancelQueuedPrompt(sessionId, inputId, { queuedRunId })
  }

  async forkSession(input: ForkDesktopSessionInput): Promise<DesktopSessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const client = await this.getClient()
    return toDesktopSessionRecord(
      await client.forkSession(sessionId, {
        ...(input.beforeMessageId ? { beforeMessageId: input.beforeMessageId } : {}),
        ...(input.afterMessageId ? { afterMessageId: input.afterMessageId } : {}),
      })
    )
  }

  async interruptSession(input: InterruptDesktopSessionInput): Promise<void> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const expectedRunId =
      input.expectedRunId === undefined
        ? undefined
        : requireString(input.expectedRunId, "预期运行 ID")
    const client = await this.getClient()
    await client.interruptSession(sessionId, {
      ...(expectedRunId ? { expectedRunId } : {}),
    })
  }

  async replyPermission(input: ReplyDesktopPermissionInput): Promise<void> {
    const permissionId = requireString(input.permissionId, "权限请求 ID")
    const client = await this.getClient()
    await client.replyPermission(permissionId, {
      status: input.status,
      decision: input.decision ?? "once",
      clientId: "desktop",
    })
  }

  async setDefaultModel(input: SetDefaultDesktopModelInput): Promise<DesktopBootstrapData> {
    const model = requireString(input.model, "模型")
    const client = await this.getClient()
    const provider = await resolveProviderForModel(client, model, input.provider)
    await client.patchSettings({
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
    const settings = await client.getSettings()
    const permission = settings["permission"]
    await client.patchSettings({
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
    const sessionId = requireString(input.sessionId, "会话 ID")
    const model = requireString(input.model, "模型")
    const client = await this.getClient()
    const provider = await resolveProviderForModel(client, model, input.provider)
    return toDesktopSessionRecord(
      await client.updateSession(sessionId, {
        metadata: {
          runtime: {
            model,
            ...(provider ? { provider } : {}),
          },
        },
      })
    )
  }

  async updateSessionPermissionMode(
    input: UpdateDesktopSessionPermissionModeInput
  ): Promise<DesktopSessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const permissionMode = requirePermissionMode(input.permissionMode)
    return toDesktopSessionRecord(
      await (
        await this.getClient()
      ).updateSession(sessionId, {
        metadata: { runtime: { permissionMode } },
      })
    )
  }

  async getContextUsage(input: GetDesktopContextUsageInput): Promise<DesktopContextUsageSnapshot> {
    const cwd = requireString(input.cwd, "工作目录")
    const client = await this.getClient()
    const result = await client.getContextUsage({
      cwd,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.refresh !== undefined ? { refresh: input.refresh } : {}),
      ...(input.previousContextWindow !== undefined
        ? { previousContextWindow: input.previousContextWindow }
        : {}),
    })
    const snapshot = parseDesktopContextUsageSnapshot(result.snapshot)
    if (!snapshot) {
      throw new Error("Context usage 快照格式无效")
    }
    return snapshot
  }

  async renameSession(input: RenameDesktopSessionInput): Promise<DesktopSessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const title = requireString(input.title, "会话名称")
    const client = await this.getClient()
    return toDesktopSessionRecord(await client.updateSession(sessionId, { title }))
  }

  async setSessionPinned(input: PinDesktopSessionInput): Promise<DesktopSessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const client = await this.getClient()
    const session = (await client.listSessions({ includeArchived: true, limit: 1_000 })).find(
      (item) => item.id === sessionId
    )
    if (!session) throw new Error(`会话 ${sessionId} 不存在。`)
    const desktop = readDesktopMetadata(session.metadata)
    if (input.pinned) desktop.pinnedAt = Date.now()
    else delete desktop.pinnedAt
    return toDesktopSessionRecord(
      await client.updateSession(sessionId, {
        metadata: { desktop, runtime: { model: session.model } },
      })
    )
  }

  async archiveSession(
    webContentsId: number,
    sessionIdInput: string
  ): Promise<DesktopSessionRecord> {
    const sessionId = requireString(sessionIdInput, "会话 ID")
    const subscription = this.subscriptions.get(webContentsId, primarySubscriptionSlot)
    if (subscription?.sessionId === sessionId) this.closeSession(webContentsId)
    const client = await this.getClient()
    return toDesktopSessionRecord(await client.archiveSession(sessionId))
  }

  async deleteSession(webContentsId: number, sessionIdInput: string): Promise<string[]> {
    const sessionId = requireString(sessionIdInput, "会话 ID")
    const subscription = this.subscriptions.get(webContentsId, primarySubscriptionSlot)
    if (subscription?.sessionId === sessionId) this.closeSession(webContentsId)
    const client = await this.getClient()
    return await client.deleteSession(sessionId)
  }

  async dispose(): Promise<void> {
    this.subscriptions.clearAll()

    const server = this.embeddedServer
    const embeddedUrl = this.embeddedUrl
    this.embeddedServer = null
    this.embeddedUrl = null
    this.clientPromise = null
    if (!server) return

    try {
      const registry = readDaemonRegistry()
      if (registry?.pid === process.pid && registry.url === embeddedUrl) clearDaemonRegistry()
    } catch {
      clearDaemonRegistry()
    }
    await server.close()
  }

  daemonClient(): Promise<OpenHarnessClient> {
    return this.getClient()
  }

  refreshDaemonClient(): Promise<OpenHarnessClient> {
    this.clientPromise = null
    return this.getClient()
  }

  private async pumpSession(
    webContents: WebContents,
    slot: string,
    sessionId: string,
    controller: AbortController,
    iterator: AsyncIterator<SyncEventUpdate>,
    auxiliarySubscriptionId?: string
  ): Promise<void> {
    try {
      while (!controller.signal.aborted && !webContents.isDestroyed()) {
        const update = await iterator.next()
        if (update.done) return
        const current = this.subscriptions.get(webContents.id, slot)
        if (!current || current.controller !== controller || current.sessionId !== sessionId) return
        const view = toDesktopSessionView(update.value.state, sessionId, update.value.source)
        if (auxiliarySubscriptionId) {
          const payload: DesktopAuxSessionUpdate = {
            subscriptionId: auxiliarySubscriptionId,
            view,
          }
          webContents.send(IpcEvents.sessionAuxUpdated, payload)
        } else {
          webContents.send(IpcEvents.sessionUpdated, view)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted && !webContents.isDestroyed()) {
        console.error(`[session] sync failed for ${sessionId}`, error)
      }
    }
  }

  private getClient(): Promise<OpenHarnessClient> {
    this.clientPromise ??= this.connect()
    return this.clientPromise
  }

  private async connect(): Promise<OpenHarnessClient> {
    try {
      this.setDaemonStatus("discovering", "正在查找 daemon")
      const registry = readDaemonRegistry()
      if (registry) {
        this.setDaemonStatus("connecting", "正在连接已运行的 daemon", {
          url: registry.url,
        })
        const client = new OpenHarnessClient({ baseUrl: registry.url, token: registry.token })
        await verifyDaemonWithTimeout(client)
        this.setDaemonStatus("ready", "daemon 已连接", { url: registry.url })
        return client
      }
    } catch (error) {
      console.warn("[session] registered daemon is unavailable, starting embedded daemon", error)
      this.setDaemonStatus("starting", "已注册 daemon 不可用，正在启动内置 daemon", {
        detail: errorMessage(error),
      })
      clearDaemonRegistry()
    }

    try {
      this.setDaemonStatus("starting", "正在启动内置 daemon")
      const token = createBearerToken()
      const { server, listen } = await startOpenHarnessDaemon({
        host: "127.0.0.1",
        port: 0,
        token,
        version: app.getVersion(),
        executionSurface: "desktop_managed",
        outsideProjectWorkspaceRoot: buildOutsideProjectRoot(app.getPath("documents")),
      })
      this.embeddedServer = server
      this.embeddedUrl = listen.url
      writeDaemonRegistry({
        url: listen.url,
        pid: process.pid,
        token,
        storePath: server.store.path,
        startedAt: Date.now(),
        version: app.getVersion(),
      })
      this.setDaemonStatus("ready", "内置 daemon 已启动", { url: listen.url })
      return new OpenHarnessClient({ baseUrl: listen.url, token })
    } catch (error) {
      this.setDaemonStatus("error", "daemon 启动失败", { detail: errorMessage(error) })
      throw error
    }
  }

  private setDaemonStatus(
    phase: DesktopDaemonStatusPhase,
    message: string,
    options: { detail?: string; url?: string } = {}
  ): void {
    this.daemonStatus = createDaemonStatus(phase, message, options)
    for (const window of BrowserWindow.getAllWindows()) {
      const webContents = window.webContents
      if (!webContents.isDestroyed()) {
        webContents.send(IpcEvents.sessionDaemonStatusChanged, this.daemonStatus)
      }
    }
  }
}

function createDaemonStatus(
  phase: DesktopDaemonStatusPhase,
  message: string,
  options: { detail?: string; url?: string } = {}
): DesktopDaemonStatus {
  return {
    phase,
    message,
    ...options,
    updatedAt: Date.now(),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function auxiliarySubscriptionSlot(subscriptionId: string): string {
  return `aux:${subscriptionId}`
}

async function toDesktopProject(project: ProjectRecord): Promise<DesktopProject> {
  let available = false
  try {
    available = (await stat(project.path)).isDirectory()
  } catch {
    available = false
  }
  return { ...project, available }
}

async function verifyDaemonWithTimeout(client: OpenHarnessClient): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1_500)
  try {
    await client.health({ signal: controller.signal })
    await client.listProjects({ signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

function toDesktopSessionView(
  state: OpenHarnessClientState,
  sessionId: string,
  source: "snapshot" | "replay" | "live" | "reconnecting"
): DesktopSessionView {
  const bucket = state.buckets[sessionId]
  if (!bucket?.session) throw new Error(`会话 ${sessionId} 不存在。`)
  return {
    cursor: state.lastSeq,
    syncStatus: source === "reconnecting" ? "reconnecting" : "connected",
    session: toDesktopSessionRecord(bucket.session),
    inputs: [...bucket.inputs],
    messages: [...bucket.messages].sort((a, b) => a.seq - b.seq),
    parts: Object.values(bucket.partsByMessageId)
      .flat()
      .sort((a, b) => a.seq - b.seq)
      .map(toDesktopSessionPart),
    runs: Object.values(bucket.runs),
    tasks: Object.values(bucket.tasks),
    permissions: Object.values(bucket.permissions),
  }
}

function toDesktopSessionPart(part: SessionMessagePartRecord): DesktopSessionPart {
  if (part.type === "attachment") {
    return part as SessionAttachmentMessagePartRecord
  }
  if (part.type === "transformation") {
    return part as SessionTransformationMessagePartRecord
  }
  return part as DesktopStandardSessionPart
}

function sortSessions(sessions: DesktopSessionRecord[]): DesktopSessionRecord[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
}

function toDesktopSessionRecord(session: SessionRecord): DesktopSessionRecord {
  const desktop = readDesktopMetadata(session.metadata)
  const workspaceMode =
    desktop["workspaceMode"] === "outside_project" ||
    isOutsideProjectWorkspacePath(session.cwd, app.getPath("documents"))
      ? "outside_project"
      : "project"
  return { ...session, workspaceMode }
}

function parseCurrentBranch(output: string): string | null {
  const trimmed = output.trim()
  if (!trimmed) return null
  const labeled = trimmed.match(/^Current branch:\s*(.+)$/i)?.[1]?.trim()
  if (labeled) return labeled
  const starred = trimmed
    .split(/\r?\n/)
    .find((line) => line.trimStart().startsWith("*"))
    ?.replace(/^\s*\*\s*/, "")
    .trim()
  return starred || trimmed.split(/\r?\n/)[0]?.trim() || null
}

async function listLocalBranches(cwd: string): Promise<string[]> {
  const { stdout } = await execGit(cwd, ["branch", "--format=%(refname:short)"])
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

async function execGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, windowsHide: true })
    return { stdout, stderr }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Git operation failed: ${message}`)
  }
}

function requireGitBranchName(value: unknown): string {
  const branch = requireString(value, "分支名称")
  if (branch.startsWith("-")) throw new Error("分支名称不能以 - 开头。")
  if (
    [...branch].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  ) {
    throw new Error("分支名称不能包含控制字符。")
  }
  return branch
}

function readDesktopMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const desktop = metadata["desktop"]
  return desktop && typeof desktop === "object" && !Array.isArray(desktop)
    ? { ...(desktop as Record<string, unknown>) }
    : {}
}

function readSettingsPermissionMode(settings: Record<string, unknown>): DesktopPermissionMode {
  const permission = settings["permission"]
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) return "default"
  return normalizePermissionMode((permission as Record<string, unknown>)["mode"]) ?? "default"
}

function normalizePermissionMode(value: unknown): DesktopPermissionMode | undefined {
  return value === "default" || value === "plan" || value === "full_auto" ? value : undefined
}

function requirePermissionMode(value: unknown): DesktopPermissionMode {
  const mode = normalizePermissionMode(value)
  if (!mode) throw new Error("权限模式必须是 default、plan 或 full_auto。")
  return mode
}

function optionalProvider(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const provider = value.trim()
  if (!provider || provider.toLowerCase() === "configured") return undefined
  return provider
}

async function resolveProviderForModel(
  client: OpenHarnessClient,
  model: string,
  requestedProvider: unknown
): Promise<string | undefined> {
  const provider = optionalProvider(requestedProvider)
  const models = (await client.listModels()).flatMap((item) => item.models)
  if (provider) {
    if (!models.some((item) => item.id === model && item.providerName === provider)) {
      throw new Error(`模型 ${model} 不属于 provider ${provider}。`)
    }
    return provider
  }

  const providers = uniqueModelProviders(models, model)
  if (providers.length <= 1) return providers[0]

  const settings = await client.getSettings()
  const configuredProvider = optionalProvider(settings["provider"])
  if (configuredProvider && providers.includes(configuredProvider)) return configuredProvider
  throw new Error(`模型 ${model} 在多个 provider 中同名，请明确指定 provider。`)
}

function uniqueModelProviders(models: DesktopModel[], model: string): string[] {
  return [
    ...new Set(
      models
        .filter((item) => item.id === model)
        .map((item) => optionalProvider(item.providerName))
        .filter((item): item is string => Boolean(item))
    ),
  ]
}

function resolveRequiredPath(value: unknown): string {
  return resolve(requireString(value, "项目路径"))
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空。`)
  return value.trim()
}

function normalizePromptAttachments(
  value: unknown,
  autoOnly: boolean
): SendDesktopPromptInput["attachments"] {
  if (!Array.isArray(value)) throw new Error("附件必须是数组。")
  return value.map((attachment, index) => {
    if (!attachment || typeof attachment !== "object") {
      throw new Error(`第 ${index + 1} 个附件无效。`)
    }
    const record = attachment as Record<string, unknown>
    const intent = requireAttachmentIntent(record.intent, index)
    if (autoOnly && intent !== "auto") {
      throw new Error(`第 ${index + 1} 个附件 intent 必须是 auto。`)
    }
    return {
      assetId: requireString(record.assetId, `第 ${index + 1} 个附件 assetId`),
      intent,
      displayName: requireString(record.displayName, `第 ${index + 1} 个附件名称`),
    }
  })
}

function requirePromptItems(value: unknown): SessionUserInputItem[] {
  if (!Array.isArray(value)) throw new Error("消息 items 必须是数组。")
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`第 ${index + 1} 个消息 item 无效。`)
    }
    const record = item as Record<string, unknown>
    if (record.type === "text" && typeof record.text === "string") {
      return { type: "text", text: record.text }
    }
    if (
      record.type === "context" &&
      record.kind === "conversation" &&
      typeof record.id === "string" &&
      typeof record.displayName === "string"
    ) {
      return {
        type: "context",
        kind: "conversation",
        id: record.id,
        displayName: record.displayName,
      }
    }
    if (
      record.type === "mention" &&
      typeof record.name === "string" &&
      typeof record.path === "string"
    ) {
      return {
        type: "mention",
        name: record.name,
        path: record.path,
        ...(typeof record.displayName === "string" ? { displayName: record.displayName } : {}),
      }
    }
    if (
      record.type === "capability" &&
      (record.kind === "plugin" || record.kind === "plugin_agent") &&
      typeof record.pluginId === "string" &&
      typeof record.displayName === "string"
    ) {
      if (record.kind === "plugin_agent") {
        if (typeof record.agentId !== "string") {
          throw new Error(`第 ${index + 1} 个消息 item 的 agentId 无效。`)
        }
        return {
          type: "capability",
          kind: "plugin_agent",
          pluginId: record.pluginId,
          agentId: record.agentId,
          displayName: record.displayName,
        }
      }
      return {
        type: "capability",
        kind: "plugin",
        pluginId: record.pluginId,
        displayName: record.displayName,
      }
    }
    if (
      record.type === "skill" &&
      typeof record.name === "string" &&
      typeof record.path === "string"
    ) {
      const source = record.source
      if (
        source !== undefined &&
        source !== "bundled" &&
        source !== "user" &&
        source !== "project" &&
        source !== "plugin"
      ) {
        throw new Error(`第 ${index + 1} 个消息 item 的 source 无效。`)
      }
      return {
        type: "skill",
        name: record.name,
        path: record.path,
        ...(typeof record.displayName === "string" ? { displayName: record.displayName } : {}),
        ...(source ? { source } : {}),
      }
    }
    throw new Error(`第 ${index + 1} 个消息 item 无效。`)
  })
}

function hasPromptItems(items: readonly SessionUserInputItem[]): boolean {
  return items.some((item) => item.type !== "text" || item.text.trim().length > 0)
}

function requireAttachmentIntent(
  value: unknown,
  index: number
): SendDesktopPromptInput["attachments"][number]["intent"] {
  if (
    value === "auto" ||
    value === "vision" ||
    value === "ocr" ||
    value === "document" ||
    value === "tool_resource" ||
    value === "workspace_reference"
  ) {
    return value
  }
  throw new Error(`第 ${index + 1} 个附件 intent 无效。`)
}

export const desktopSessionService = new DesktopSessionService()
