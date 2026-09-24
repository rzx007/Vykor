import type {
  SessionInputAttachmentRecord,
  SessionUserInputItem,
  CreateSessionGoalInput,
  UpdateSessionGoalInput,
  GoalActionInput,
} from "@vykor/client"

export type { SessionUserInputItem, SessionGoal } from "@vykor/client"
export type { PluginCatalogEntry as DesktopPluginCatalogEntry } from "@vykor/client"

export interface GetDesktopSessionGoalInput {
  sessionId: string
}
export interface CreateDesktopSessionGoalInput extends CreateSessionGoalInput {
  sessionId: string
}
export interface UpdateDesktopSessionGoalInput extends UpdateSessionGoalInput {
  sessionId: string
  goalId: string
}
export interface DesktopSessionGoalActionInput extends GoalActionInput {
  sessionId: string
  goalId: string
}

import type { DesktopAttachmentSupport, DesktopPromptAttachmentInput } from "./attachment-types"

export interface DesktopProject {
  id: string
  name: string
  path: string
  lastOpenedAt: number
  pinnedAt?: number
  defaultShell?: string
  available: boolean
}

export interface DesktopModel {
  id: string
  label: string
  provider: string
  providerName: string
  hint?: string
  contextWindow?: number
  outputLimit?: number
  reasoning?: boolean
  reasoningEfforts?: string[]
  vision?: boolean
  inputModalities?: string[]
  inputCapabilities?: { image: "native" | "unsupported" | "unknown" }
  toolCalling?: boolean
  status?: "active" | "beta"
}

export interface DesktopSessionRecord {
  id: string
  parentId?: string
  projectId?: string
  workspaceMode?: DesktopWorkspaceMode
  cwd: string
  cwdRelative?: string
  title: string
  model: string
  agent?: string
  status: "idle" | "running" | "closing" | "archived" | "error"
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  archivedAt?: number
}

export interface DesktopSessionInput {
  id: string
  sessionId: string
  seq: number
  delivery: "queue" | "steer"
  items: SessionUserInputItem[]
  content: string
  attachments: SessionInputAttachmentRecord[]
  promotedMessageId?: string
  metadata: Record<string, unknown>
  createdAt: number
}

export interface DesktopSessionMessage {
  id: string
  sessionId: string
  seq: number
  role: "system" | "user" | "assistant"
  runId?: string
  inputId?: string
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

interface DesktopSessionPartBase {
  id: string
  sessionId: string
  messageId: string
  seq: number
  status: "pending" | "running" | "completed" | "failed" | "interrupted"
  text?: string
  toolUseId?: string
  toolName?: string
  input?: Record<string, unknown>
  output?: unknown
  isError?: boolean
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface DesktopStandardSessionPart extends DesktopSessionPartBase {
  type: "text" | "reasoning" | "tool" | "tool_result" | "error" | "log"
}

export interface DesktopAttachmentSessionPart extends DesktopSessionPartBase {
  type: "attachment"
  assetId: string
  intent: "auto" | "vision" | "ocr" | "document" | "tool_resource" | "workspace_reference"
  displayName: string
  mediaType: string
  sizeBytes: number
}

export interface DesktopTransformationSessionPart extends DesktopSessionPartBase {
  type: "transformation"
  assetId: string
  kind: "direct" | "document_extract" | "tool_mount"
  representationId?: string
  processor?: string
  transformationError?: string
}

export type DesktopSessionPart =
  DesktopStandardSessionPart | DesktopAttachmentSessionPart | DesktopTransformationSessionPart

export interface DesktopSessionRun {
  id: string
  sessionId: string
  inputId?: string
  status: "pending" | "running" | "completed" | "failed" | "interrupted"
  startedAt?: number
  finishedAt?: number
  error?: string
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface DesktopSessionTask {
  id: string
  sessionId: string
  childSessionId?: string
  runId?: string
  type: string
  status: "pending" | "running" | "completed" | "failed" | "stopped" | "interrupted"
  description: string
  cwd: string
  output?: string
  error?: string
  metadata: Record<string, unknown>
  createdAt: number
  startedAt?: number
  finishedAt?: number
  updatedAt: number
}

export interface DesktopPermissionRequest {
  id: string
  sessionId: string
  runId?: string
  toolName: string
  payload: Record<string, unknown>
  status: "pending" | "approved" | "denied" | "expired"
  decision?: string
  decidedByClientId?: string
  createdAt: number
  updatedAt: number
}

export type DesktopPermissionMode = "default" | "plan" | "full_auto"

export type DesktopWorkspaceMode = "project" | "outside_project"

export type DesktopDaemonStatusPhase =
  "idle" | "discovering" | "connecting" | "starting" | "ready" | "error"

export interface DesktopDaemonStatus {
  phase: DesktopDaemonStatusPhase
  message: string
  detail?: string
  url?: string
  updatedAt: number
}

export interface DesktopBootstrapData {
  connected: true
  projects: DesktopProject[]
  sessions: DesktopSessionRecord[]
  archivedSessions: DesktopSessionRecord[]
  models: DesktopModel[]
  defaultModel: string
  defaultProvider?: string
  defaultPermissionMode: DesktopPermissionMode
  attachments: DesktopAttachmentSupport
  /** 项目外工作模式的托管根目录，用于起始页加载 slash 命令和右侧面板。 */
  outsideProjectWorkspaceRoot: string
}

export interface DesktopSessionLists {
  sessions: DesktopSessionRecord[]
  archivedSessions: DesktopSessionRecord[]
}

export interface DesktopProjectDetails {
  project: DesktopProject
  git: boolean
  branch: string | null
  branches: string[]
}

export type DesktopCommandKind = "session" | "template"
export type DesktopCommandSelection = "execute" | "submenu" | "insert"
export type DesktopCommandSource = "builtin" | "bundled" | "user" | "plugin" | "project"

interface DesktopCommandCatalogEntryBase {
  name: string
  displayName?: string
  description?: string
  source?: DesktopCommandSource
  argumentHint?: string
  selection?: DesktopCommandSelection
  requiresEmptyComposer?: boolean
}

export interface DesktopSessionCommandCatalogEntry extends DesktopCommandCatalogEntryBase {
  kind: "session"
  path?: never
}

export interface DesktopTemplateCommandCatalogEntry extends DesktopCommandCatalogEntryBase {
  kind: "template"
  skillName: string
  /** 当前 Skill 定义的绝对路径；内嵌 bundled Skill 为 ""。 */
  path: string
}

export type DesktopCommandCatalogEntry =
  DesktopSessionCommandCatalogEntry | DesktopTemplateCommandCatalogEntry

export interface ListDesktopCommandsInput {
  cwd: string
}

export interface CompactDesktopSessionInput {
  sessionId: string
}

export interface DesktopCompactSessionResult {
  messageCount: number
}

export type DesktopSessionSyncStatus = "connected" | "reconnecting"

export interface DesktopSessionView {
  cursor: number
  syncStatus: DesktopSessionSyncStatus
  session: DesktopSessionRecord
  inputs: DesktopSessionInput[]
  messages: DesktopSessionMessage[]
  parts: DesktopSessionPart[]
  runs: DesktopSessionRun[]
  tasks: DesktopSessionTask[]
  permissions: DesktopPermissionRequest[]
}

export interface OpenDesktopAuxSessionInput {
  subscriptionId: string
  sessionId: string
}

export interface CloseDesktopAuxSessionInput {
  subscriptionId: string
}

export interface DesktopAuxSessionUpdate {
  subscriptionId: string
  view: DesktopSessionView
}

interface CreateDesktopSessionBaseInput {
  model: string
  provider?: string
  permissionMode?: DesktopPermissionMode
  effort?: string
}

export type CreateDesktopSessionInput = CreateDesktopSessionBaseInput &
  ({ projectId: string; cwd: string } | { projectId?: undefined; cwd?: undefined })

export interface SendDesktopPromptInput {
  id: string
  sessionId: string
  items: SessionUserInputItem[]
  attachments: DesktopPromptAttachmentInput[]
}

export interface EditLatestDesktopPromptInput {
  id: string
  sessionId: string
  items: SessionUserInputItem[]
  sourceMessageId: string
  attachments: DesktopPromptAttachmentInput[]
}

export interface InterruptDesktopSessionInput {
  sessionId: string
  expectedRunId?: string
}

export interface PromoteDesktopQueuedPromptInput {
  sessionId: string
  inputId: string
  queuedRunId: string
  expectedActiveRunId: string
}

export interface CancelDesktopQueuedPromptInput {
  sessionId: string
  inputId: string
  queuedRunId: string
}

export interface ForkDesktopSessionInput {
  sessionId: string
  beforeMessageId?: string
  afterMessageId?: string
}

export interface RenameDesktopSessionInput {
  sessionId: string
  title: string
}

export interface PinDesktopSessionInput {
  sessionId: string
  pinned: boolean
}

export interface RenameDesktopProjectInput {
  projectId: string
  name: string
}

export interface PinDesktopProjectInput {
  projectId: string
  pinned: boolean
}

export interface SetDefaultDesktopProjectShellInput {
  projectId: string
  shell: string | null
}

export interface CheckoutDesktopProjectBranchInput {
  path: string
  branch: string
}

export interface CreateDesktopProjectBranchInput {
  path: string
  branch: string
}

export interface ReplyDesktopPermissionInput {
  permissionId: string
  status: "approved" | "denied"
  decision?: "once" | "session"
  answer?: string
}

export interface SetDefaultDesktopModelInput {
  model: string
  provider?: string
}

export interface SetDefaultDesktopPermissionModeInput {
  permissionMode: DesktopPermissionMode
}

export interface UpdateDesktopSessionModelInput {
  sessionId: string
  model: string
  provider?: string
}

export interface UpdateDesktopSessionPermissionModeInput {
  sessionId: string
  permissionMode: DesktopPermissionMode
}

export interface UpdateDesktopSessionEffortInput {
  sessionId: string
  effort: string
}

export interface GetDesktopContextUsageInput {
  cwd: string
  sessionId?: string
  refresh?: boolean
  previousContextWindow?: number
}

export interface DesktopContextUsageResult {
  snapshot: unknown
  report: string
}
