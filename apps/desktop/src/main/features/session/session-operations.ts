import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"

import {
  OpenHarnessClient,
  parseCreateSessionGoalInput,
  parseUpdateSessionGoalInput,
  parseGoalActionInput,
  type ProjectRecord,
} from "@openharness/client"

import type {
  CheckoutDesktopProjectBranchInput,
  CompactDesktopSessionInput,
  CreateDesktopProjectBranchInput,
  CreateDesktopSessionInput,
  DesktopCommandCatalogEntry,
  DesktopCompactSessionResult,
  DesktopModel,
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
  GetDesktopContextUsageInput,
  GetDesktopSessionGoalInput,
  CreateDesktopSessionGoalInput,
  UpdateDesktopSessionGoalInput,
  DesktopSessionGoalActionInput,
  SessionGoal,
} from "../../../shared/session-types"
import type { DesktopContextUsageSnapshot } from "../../../shared/context-usage-types"
import { parseDesktopContextUsageSnapshot } from "../../../shared/parse-context-usage-snapshot"
import {
  allocateOutsideProjectWorkspace,
  removeEmptyOutsideProjectWorkspace,
} from "./outside-project-workspace"
import {
  readDesktopMetadata,
  toDesktopSessionRecord,
} from "./session-subscription-service"
import { app } from "electron"

type SessionOperationsClient = Pick<
  OpenHarnessClient,
  "projects" | "development" | "system" | "sessions" | "permissions" | "providers"
>

const execFileAsync = promisify(execFile)
const DESKTOP_SESSION_COMMAND_NAMES = new Set(["/compact", "/goal", "/status", "/skills"])

export class SessionOperations {
  async inspectProject(client: SessionOperationsClient, inputPath: string): Promise<DesktopProjectDetails> {
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

  async listCommands(client: SessionOperationsClient, cwdInput: string): Promise<DesktopCommandCatalogEntry[]> {
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

  async compactSession(client: SessionOperationsClient, input: CompactDesktopSessionInput): Promise<DesktopCompactSessionResult> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const result = await client.sessions.compact(sessionId)
    return { messageCount: result.messageCount }
  }

  async getGoal(client: SessionOperationsClient, input: GetDesktopSessionGoalInput): Promise<SessionGoal | null> {
    return await client.sessions.getGoal(requireString(input.sessionId, "会话 ID"))
  }

  async createGoal(client: SessionOperationsClient, input: CreateDesktopSessionGoalInput): Promise<SessionGoal> {
    const { sessionId, ...body } = input
    return await client.sessions.createGoal(requireString(sessionId, "会话 ID"), parseCreateSessionGoalInput(body))
  }

  async updateGoal(client: SessionOperationsClient, input: UpdateDesktopSessionGoalInput): Promise<SessionGoal> {
    const { sessionId, goalId, ...body } = input
    return await client.sessions.updateGoal(
      requireString(sessionId, "会话 ID"),
      requireString(goalId, "目标 ID"),
      parseUpdateSessionGoalInput(body)
    )
  }

  async goalAction(client: SessionOperationsClient, input: DesktopSessionGoalActionInput): Promise<SessionGoal> {
    const { sessionId, goalId, ...body } = input
    return await client.sessions.applyGoalAction(
      requireString(sessionId, "会话 ID"),
      requireString(goalId, "目标 ID"),
      parseGoalActionInput(body)
    )
  }

  async checkoutProjectBranch(input: CheckoutDesktopProjectBranchInput): Promise<DesktopProjectDetails> {
    const path = resolveRequiredPath(input.path)
    const branch = requireGitBranchName(input.branch)
    await execGit(path, ["switch", branch])
    return await this.inspectProject(await this.getEphemeralClient(path), path)
  }

  async createProjectBranch(input: CreateDesktopProjectBranchInput): Promise<DesktopProjectDetails> {
    const path = resolveRequiredPath(input.path)
    const branch = requireGitBranchName(input.branch)
    await execGit(path, ["check-ref-format", "--branch", branch])
    await execGit(path, ["switch", "-c", branch])
    return await this.inspectProject(await this.getEphemeralClient(path), path)
  }

  async createSession(client: SessionOperationsClient, input: CreateDesktopSessionInput): Promise<DesktopSessionRecord> {
    const model = requireString(input.model, "模型")
    const permissionMode = normalizePermissionMode(input.permissionMode)
    const provider = await resolveProviderForModel(client, model, input.provider)
    const projectId = input.projectId ? requireString(input.projectId, "Project ID") : undefined
    const cwd = projectId
      ? resolveRequiredPath(input.cwd)
      : await allocateOutsideProjectWorkspace(app.getPath("documents"))

    try {
      const session = await client.sessions.create({
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

  async renameProject(client: SessionOperationsClient, input: RenameDesktopProjectInput): Promise<DesktopProject> {
    const name = requireString(input.name, "项目名称")
    return await toDesktopProject(await client.projects.rename(input.projectId, name))
  }

  async setProjectPinned(client: SessionOperationsClient, input: PinDesktopProjectInput): Promise<DesktopProject> {
    return await toDesktopProject(await client.projects.setPinned(input.projectId, input.pinned))
  }

  async setProjectDefaultShell(client: SessionOperationsClient, input: SetDefaultDesktopProjectShellInput): Promise<DesktopProject> {
    return await toDesktopProject(await client.projects.setDefaultShell(input.projectId, input.shell))
  }

  async removeProject(client: SessionOperationsClient, projectId: string): Promise<void> {
    await client.projects.archive(requireString(projectId, "Project ID"))
  }

  async resolveProjectDirectory(client: SessionOperationsClient, projectIdInput: string): Promise<string> {
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

  async editLatestPrompt(client: SessionOperationsClient, input: EditLatestDesktopPromptInput): Promise<void> {
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

  async promoteQueuedPrompt(client: SessionOperationsClient, input: PromoteDesktopQueuedPromptInput): Promise<void> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const inputId = requireString(input.inputId, "输入 ID")
    const queuedRunId = requireString(input.queuedRunId, "排队运行 ID")
    const expectedActiveRunId = requireString(input.expectedActiveRunId, "当前运行 ID")
    await client.sessions.promoteQueuedPrompt(sessionId, inputId, {
      queuedRunId,
      expectedActiveRunId,
    })
  }

  async cancelQueuedPrompt(client: SessionOperationsClient, input: CancelDesktopQueuedPromptInput): Promise<void> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const inputId = requireString(input.inputId, "输入 ID")
    const queuedRunId = requireString(input.queuedRunId, "排队运行 ID")
    await client.sessions.cancelQueuedPrompt(sessionId, inputId, { queuedRunId })
  }

  async forkSession(client: SessionOperationsClient, input: ForkDesktopSessionInput): Promise<DesktopSessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    return toDesktopSessionRecord(
      await client.sessions.fork(sessionId, {
        ...(input.beforeMessageId ? { beforeMessageId: input.beforeMessageId } : {}),
        ...(input.afterMessageId ? { afterMessageId: input.afterMessageId } : {}),
      })
    )
  }

  async interruptSession(client: SessionOperationsClient, input: InterruptDesktopSessionInput): Promise<void> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const expectedRunId =
      input.expectedRunId === undefined
        ? undefined
        : requireString(input.expectedRunId, "预期运行 ID")
    await client.sessions.interrupt(sessionId, {
      ...(expectedRunId ? { expectedRunId } : {}),
    })
  }

  async replyPermission(client: SessionOperationsClient, input: ReplyDesktopPermissionInput): Promise<void> {
    const permissionId = requireString(input.permissionId, "权限请求 ID")
    await client.permissions.reply(permissionId, {
      status: input.status,
      decision: input.decision ?? "once",
      clientId: "desktop",
    })
  }

  async updateSessionModel(client: SessionOperationsClient, input: UpdateDesktopSessionModelInput): Promise<DesktopSessionRecord> {
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

  async updateSessionPermissionMode(client: SessionOperationsClient, input: UpdateDesktopSessionPermissionModeInput): Promise<DesktopSessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const permissionMode = requirePermissionMode(input.permissionMode)
    return toDesktopSessionRecord(
      await client.sessions.update(sessionId, {
        metadata: { runtime: { permissionMode } },
      })
    )
  }

  async getContextUsage(client: SessionOperationsClient, input: GetDesktopContextUsageInput): Promise<DesktopContextUsageSnapshot> {
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

  async renameSession(client: SessionOperationsClient, input: RenameDesktopSessionInput): Promise<DesktopSessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const title = requireString(input.title, "会话名称")
    return toDesktopSessionRecord(await client.sessions.update(sessionId, { title }))
  }

  async setSessionPinned(client: SessionOperationsClient, input: PinDesktopSessionInput): Promise<DesktopSessionRecord> {
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

  private ephemeralClient: OpenHarnessClient | null = null
  private async getEphemeralClient(cwd: string): Promise<OpenHarnessClient> {
    return this.ephemeralClient!
  }
  setEphemeralClient(client: OpenHarnessClient) {
    this.ephemeralClient = client
  }
}

export async function toDesktopProject(project: ProjectRecord): Promise<DesktopProject> {
  let available = false
  try {
    available = (await stat(project.path)).isDirectory()
  } catch {
    available = false
  }
  return { ...project, available }
}

export function resolveRequiredPath(value: unknown): string {
  return resolve(requireString(value, "项目路径"))
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空。`)
  return value.trim()
}

export function normalizePermissionMode(value: unknown): DesktopPermissionMode | undefined {
  return value === "default" || value === "plan" || value === "full_auto" ? value : undefined
}

export function requirePermissionMode(value: unknown): DesktopPermissionMode {
  const mode = normalizePermissionMode(value)
  if (!mode) throw new Error("权限模式必须是 default、plan 或 full_auto。")
  return mode
}

export function optionalProvider(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const provider = value.trim()
  if (!provider || provider.toLowerCase() === "configured") return undefined
  return provider
}

export async function resolveProviderForModel(
  client: SessionOperationsClient,
  model: string,
  requestedProvider: unknown
): Promise<string | undefined> {
  const provider = optionalProvider(requestedProvider)
  const models = (await client.providers.listModels()).flatMap((item) => item.models)
  if (provider) {
    if (!models.some((item) => item.id === model && item.providerName === provider)) {
      throw new Error(`模型 ${model} 不属于 provider ${provider}。`)
    }
    return provider
  }

  const providers = uniqueModelProviders(models, model)
  if (providers.length <= 1) return providers[0]

  const settings = await client.system.getSettings()
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
