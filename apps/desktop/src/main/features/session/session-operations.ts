import { stat } from "node:fs/promises"

import {
  VykorClient,
  parseCreateSessionGoalInput,
  parseUpdateSessionGoalInput,
  parseGoalActionInput,
} from "@vykor/client"

import type {
  CheckoutDesktopProjectBranchInput,
  CompactDesktopSessionInput,
  CreateDesktopProjectBranchInput,
  CreateDesktopSessionInput,
  DesktopCommandCatalogEntry,
  DesktopCompactSessionResult,
  DesktopProject,
  DesktopProjectDetails,
  DesktopPermissionMode,
  DesktopSessionRecord,
  EditLatestDesktopPromptInput,
  ForkDesktopSessionInput,
  InterruptDesktopSessionInput,
  PromoteDesktopQueuedPromptInput,
  CancelDesktopQueuedPromptInput,
  PinDesktopSessionInput,
  PinDesktopProjectInput,
  RenameDesktopProjectInput,
  RenameDesktopSessionInput,
  ReplyDesktopPermissionInput,
  SetDefaultDesktopProjectShellInput,
  SendDesktopPromptInput,
  SessionUserInputItem,
  UpdateDesktopSessionModelInput,
  UpdateDesktopSessionPermissionModeInput,
  UpdateDesktopSessionEffortInput,
  GetDesktopContextUsageInput,
  GetDesktopSessionGoalInput,
  CreateDesktopSessionGoalInput,
  UpdateDesktopSessionGoalInput,
  DesktopSessionGoalActionInput,
  SessionGoal,
} from "@shared/session-types"
import type { DesktopContextUsageSnapshot } from "@shared/context-usage-types"
import { parseDesktopContextUsageSnapshot } from "@shared/parse-context-usage-snapshot"
import {
  allocateOutsideProjectWorkspace,
  removeEmptyOutsideProjectWorkspace,
} from "./outside-project-workspace"
import { readDesktopMetadata, toDesktopSessionRecord } from "./session-subscription-service"
import { execGit, listLocalBranches, parseCurrentBranch, requireGitBranchName, toDesktopProject } from "./project-operations-support"
import {
  hasPromptItems,
  normalizePermissionMode,
  normalizePromptAttachments,
  requirePermissionMode,
  requirePromptItems,
  requireString,
  resolveProviderForModel,
  resolveRequiredPath,
} from "./session-operation-input"
import { app } from "electron"
import { getGitPreferences } from "../settings/git-settings-storage"

export type SessionOperationsClient = Pick<
  VykorClient,
  "projects" | "development" | "system" | "sessions" | "permissions" | "providers"
>

export { toDesktopProject } from "./project-operations-support"
export {
  normalizePermissionMode,
  optionalProvider,
  requirePermissionMode,
  requireString,
  resolveProviderForModel,
  resolveRequiredPath,
} from "./session-operation-input"

const DESKTOP_SESSION_COMMAND_NAMES = new Set(["/compact", "/goal", "/status", "/skills"])

export class SessionOperations {
  async inspectProject(
    client: SessionOperationsClient,
    inputPath: string
  ): Promise<DesktopProjectDetails> {
    const path = resolveRequiredPath(inputPath)
    const info = await stat(path)
    if (!info.isDirectory()) throw new Error("选择的项目路径不是目录。")

    const project = await toDesktopProject(await client.projects.inspect(path))
    let git = false
    let branch: string | null = null
    let branches: string[] = []
    try {
      await execGit(path, ["rev-parse", "--show-toplevel"])
      git = true
      try {
        branch = parseCurrentBranch(await client.development.getGitBranch({ cwd: path }))
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

  async listCommands(
    client: SessionOperationsClient,
    cwdInput: string
  ): Promise<DesktopCommandCatalogEntry[]> {
    const cwd = resolveRequiredPath(cwdInput)
    const commands = await client.system.listCommands({ cwd })
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

  async listContextPlugins(client: SessionOperationsClient, cwdInput: string) {
    return client.system.listContextPlugins({ cwd: resolveRequiredPath(cwdInput) })
  }

  async compactSession(
    client: SessionOperationsClient,
    input: CompactDesktopSessionInput
  ): Promise<DesktopCompactSessionResult> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const result = await client.sessions.compact(sessionId)
    return { messageCount: result.messageCount }
  }

  async getGoal(
    client: SessionOperationsClient,
    input: GetDesktopSessionGoalInput
  ): Promise<SessionGoal | null> {
    return await client.sessions.getGoal(requireString(input.sessionId, "会话 ID"))
  }

  async createGoal(
    client: SessionOperationsClient,
    input: CreateDesktopSessionGoalInput
  ): Promise<SessionGoal> {
    const { sessionId, ...body } = input
    return await client.sessions.createGoal(
      requireString(sessionId, "会话 ID"),
      parseCreateSessionGoalInput(body)
    )
  }

  async updateGoal(
    client: SessionOperationsClient,
    input: UpdateDesktopSessionGoalInput
  ): Promise<SessionGoal> {
    const { sessionId, goalId, ...body } = input
    return await client.sessions.updateGoal(
      requireString(sessionId, "会话 ID"),
      requireString(goalId, "目标 ID"),
      parseUpdateSessionGoalInput(body)
    )
  }

  async goalAction(
    client: SessionOperationsClient,
    input: DesktopSessionGoalActionInput
  ): Promise<SessionGoal> {
    const { sessionId, goalId, ...body } = input
    return await client.sessions.applyGoalAction(
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
    return await this.inspectProject(await this.getEphemeralClient(path), path)
  }

  async createProjectBranch(
    input: CreateDesktopProjectBranchInput
  ): Promise<DesktopProjectDetails> {
    const path = resolveRequiredPath(input.path)
    const { gitSettingsService } = await import("../settings/git-settings-service")
    const branch = requireGitBranchName(await gitSettingsService.uniqueBranch(path, input.branch))
    await execGit(path, ["check-ref-format", "--branch", branch])
    await execGit(path, ["switch", "-c", branch])
    return await this.inspectProject(await this.getEphemeralClient(path), path)
  }

  async createSession(
    client: SessionOperationsClient,
    input: CreateDesktopSessionInput
  ): Promise<DesktopSessionRecord> {
    const model = requireString(input.model, "模型")
    if ((await client.system.getSettings()).modelDisabled === true) throw new Error("默认模型已停用。请先在模型供应商设置中选择可用的默认模型。")
    const permissionMode = normalizePermissionMode(input.permissionMode)
    const provider = await resolveProviderForModel(client, model, input.provider)
    const projectId = input.projectId ? requireString(input.projectId, "Project ID") : undefined
    const location = input.taskLocation ?? (projectId ? getGitPreferences().defaultTaskLocation : "current")
    if (location !== "current" && location !== "worktree") throw new Error("未知任务工作位置。")
    if (!projectId && location === "worktree") throw new Error("独立工作目录需要一个 Git 项目。")
    let cwd = projectId
      ? resolveRequiredPath(input.cwd)
      : await allocateOutsideProjectWorkspace(app.getPath("documents"))
    const settingsRoot = cwd
    const gitSettingsService = projectId && location === "worktree"
      ? (await import("../settings/git-settings-service")).gitSettingsService : null
    const worktree = gitSettingsService ? await gitSettingsService.createTaskWorktree(projectId!, cwd) : null
    if (worktree) cwd = worktree.path
    let createdSessionId: string | undefined

    try {
      const session = await client.sessions.create({
        ...(projectId ? { projectId } : {}),
        cwd,
        model,
        title: "",
        metadata: {
          ...(!projectId ? { desktop: { workspaceMode: "outside_project" } } : {}),
          ...(worktree ? { desktop: { settingsRoot, worktree: { id: worktree.id, path: worktree.path, branch: worktree.branch } } } : {}),
          runtimeDefaultFields: input.effort?.trim()
            ? ["maxTurns", "systemPrompt"]
            : ["effort", "maxTurns", "systemPrompt"],
          runtime: {
            model,
            ...(provider ? { provider } : {}),
            ...(permissionMode ? { permissionMode } : {}),
            ...(input.effort?.trim() ? { effort: input.effort.trim() } : {}),
          },
        },
      })
      createdSessionId = session.id
      if (worktree) await gitSettingsService!.bindTaskWorktree(worktree.id, session.id)
      return toDesktopSessionRecord(session)
    } catch (error) {
      if (worktree) {
        if (createdSessionId) await client.sessions.archive(createdSessionId)
        await gitSettingsService!.discardUnboundWorktree(worktree.id)
      }
      if (!projectId) await removeEmptyOutsideProjectWorkspace(cwd)
      throw error
    }
  }

  async renameProject(
    client: SessionOperationsClient,
    input: RenameDesktopProjectInput
  ): Promise<DesktopProject> {
    const name = requireString(input.name, "项目名称")
    return await toDesktopProject(await client.projects.rename(input.projectId, name))
  }

  async setProjectPinned(
    client: SessionOperationsClient,
    input: PinDesktopProjectInput
  ): Promise<DesktopProject> {
    return await toDesktopProject(await client.projects.setPinned(input.projectId, input.pinned))
  }

  async setProjectDefaultShell(
    client: SessionOperationsClient,
    input: SetDefaultDesktopProjectShellInput
  ): Promise<DesktopProject> {
    return await toDesktopProject(
      await client.projects.setDefaultShell(input.projectId, input.shell)
    )
  }

  async removeProject(client: SessionOperationsClient, projectId: string): Promise<void> {
    await client.projects.archive(requireString(projectId, "Project ID"))
  }

  async resolveProjectDirectory(
    client: SessionOperationsClient,
    projectIdInput: string
  ): Promise<string> {
    const projectId = requireString(projectIdInput, "Project ID")
    const project = (await client.projects.list()).find((item) => item.id === projectId)
    if (!project) throw new Error(`Project ${projectId} does not exist.`)

    const info = await stat(project.path)
    if (!info.isDirectory()) throw new Error(`Project ${project.name} directory is unavailable.`)
    return project.path
  }

  async sendPrompt(client: SessionOperationsClient, input: SendDesktopPromptInput): Promise<void> {
    const id = requireString(input.id, "输入 ID")
    const sessionId = requireString(input.sessionId, "会话 ID")
    const items = requirePromptItems(input.items)
    const attachments = normalizePromptAttachments(input.attachments, true)
    if (!hasPromptItems(items) && attachments.length === 0) {
      throw new Error("消息内容和附件不能同时为空。")
    }
    await client.sessions.admitPrompt(sessionId, {
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

  async editLatestPrompt(
    client: SessionOperationsClient,
    input: EditLatestDesktopPromptInput
  ): Promise<void> {
    const id = requireString(input.id, "编辑请求 ID")
    const sessionId = requireString(input.sessionId, "会话 ID")
    const items = requirePromptItems(input.items)
    const sourceMessageId = requireString(input.sourceMessageId, "原消息 ID")
    const attachments = normalizePromptAttachments(input.attachments, false)
    if (!hasPromptItems(items) && attachments.length === 0) {
      throw new Error("消息内容、附件和技能不能同时为空。")
    }
    await client.sessions.editLatestPrompt(sessionId, {
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

  async promoteQueuedPrompt(
    client: SessionOperationsClient,
    input: PromoteDesktopQueuedPromptInput
  ): Promise<void> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const inputId = requireString(input.inputId, "输入 ID")
    const queuedRunId = requireString(input.queuedRunId, "排队运行 ID")
    const expectedActiveRunId = requireString(input.expectedActiveRunId, "当前运行 ID")
    await client.sessions.promoteQueuedPrompt(sessionId, inputId, {
      queuedRunId,
      expectedActiveRunId,
    })
  }

  async cancelQueuedPrompt(
    client: SessionOperationsClient,
    input: CancelDesktopQueuedPromptInput
  ): Promise<void> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const inputId = requireString(input.inputId, "输入 ID")
    const queuedRunId = requireString(input.queuedRunId, "排队运行 ID")
    await client.sessions.cancelQueuedPrompt(sessionId, inputId, { queuedRunId })
  }

  async forkSession(
    client: SessionOperationsClient,
    input: ForkDesktopSessionInput
  ): Promise<DesktopSessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    return toDesktopSessionRecord(
      await client.sessions.fork(sessionId, {
        ...(input.copyHistory !== undefined ? { copyHistory: input.copyHistory } : {}),
        ...(input.storage !== undefined ? { storage: input.storage } : {}),
        ...(input.beforeMessageId ? { beforeMessageId: input.beforeMessageId } : {}),
        ...(input.afterMessageId ? { afterMessageId: input.afterMessageId } : {}),
      })
    )
  }

  async interruptSession(
    client: SessionOperationsClient,
    input: InterruptDesktopSessionInput
  ): Promise<void> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const expectedRunId =
      input.expectedRunId === undefined
        ? undefined
        : requireString(input.expectedRunId, "预期运行 ID")
    await client.sessions.interrupt(sessionId, {
      ...(expectedRunId ? { expectedRunId } : {}),
    })
  }

  async replyPermission(
    client: SessionOperationsClient,
    input: ReplyDesktopPermissionInput
  ): Promise<void> {
    const permissionId = requireString(input.permissionId, "权限请求 ID")
    await client.permissions.reply(permissionId, {
      status: input.status,
      decision: input.decision ?? "once",
      clientId: "desktop",
      ...(input.answer !== undefined ? { answer: input.answer } : {}),
    })
  }

  async updateSessionModel(
    client: SessionOperationsClient,
    input: UpdateDesktopSessionModelInput
  ): Promise<DesktopSessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const model = requireString(input.model, "模型")
    const provider = await resolveProviderForModel(client, model, input.provider)
    return toDesktopSessionRecord(
      await client.sessions.update(sessionId, {
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
    client: SessionOperationsClient,
    input: UpdateDesktopSessionPermissionModeInput
  ): Promise<DesktopSessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const permissionMode = requirePermissionMode(input.permissionMode)
    return toDesktopSessionRecord(
      await client.sessions.update(sessionId, {
        metadata: { runtime: { permissionMode } },
      })
    )
  }

  async updateSessionEffort(
    client: SessionOperationsClient,
    input: UpdateDesktopSessionEffortInput
  ): Promise<DesktopSessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const effort = typeof input.effort === "string" ? input.effort.trim() : ""
    return toDesktopSessionRecord(
      await client.sessions.update(sessionId, {
        metadata: { runtime: { effort } },
      })
    )
  }

  async getContextUsage(
    client: SessionOperationsClient,
    input: GetDesktopContextUsageInput
  ): Promise<DesktopContextUsageSnapshot> {
    const cwd = requireString(input.cwd, "工作目录")
    const result = await client.system.getContextUsage({
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

  async renameSession(
    client: SessionOperationsClient,
    input: RenameDesktopSessionInput
  ): Promise<DesktopSessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const title = requireString(input.title, "会话名称")
    return toDesktopSessionRecord(await client.sessions.update(sessionId, { title }))
  }

  async setSessionPinned(
    client: SessionOperationsClient,
    input: PinDesktopSessionInput
  ): Promise<DesktopSessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const session = (await client.sessions.list({ includeArchived: true, limit: 1_000 })).find(
      (item) => item.id === sessionId
    )
    if (!session) throw new Error(`会话 ${sessionId} 不存在。`)
    const desktop = readDesktopMetadata(session.metadata)
    if (input.pinned) desktop.pinnedAt = Date.now()
    else delete desktop.pinnedAt
    return toDesktopSessionRecord(
      await client.sessions.update(sessionId, {
        metadata: { desktop, runtime: { model: session.model } },
      })
    )
  }

  private ephemeralClient: VykorClient | null = null
  private async getEphemeralClient(cwd: string): Promise<VykorClient> {
    return this.ephemeralClient!
  }
  setEphemeralClient(client: VykorClient) {
    this.ephemeralClient = client
  }
}
