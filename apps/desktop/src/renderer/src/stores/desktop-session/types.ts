import type {
  DesktopDaemonStatus,
  DesktopModel,
  DesktopPermissionMode,
  DesktopProject,
  DesktopSessionRecord,
  DesktopSessionView,
  DesktopWorkspaceMode,
  SessionUserInputItem,
  SessionGoal,
  DesktopSessionGoalActionInput,
} from "@shared/session-types"
import type { DesktopAttachmentSupport } from "@shared/attachment-types"
import type {
  DesktopAttachmentDraft,
  DesktopAttachmentUploadEvent,
  DesktopPromptAttachmentInput,
  UploadDesktopAttachmentMemoryInput,
} from "@shared/attachment-types"
import type { DesktopContextUsageSnapshot } from "@shared/context-usage-types"
import type { StoreApi } from "zustand"
import type { ComposerDraftState, DesktopComposerDraft } from "./composer-draft-state"
import type { ComposerDocument } from "./composer-document"
import type { ProjectDetailsCoordinator } from "./project-details-coordinator"

export type LoadStatus = "idle" | "loading" | "ready" | "error"

export interface SubmitPromptOptions {
  document?: ComposerDocument
  attachments?: readonly DesktopAttachmentDraft[]
}

export interface PendingPromptAttachmentSnapshot extends DesktopPromptAttachmentInput {
  mediaType: string
  sizeBytes: number
}

export interface PendingPromptSubmission {
  id: string
  sessionId: string
  content: string
  items: SessionUserInputItem[]
  attachments: PendingPromptAttachmentSnapshot[]
  createdAt: number
  phase: "submitting" | "accepted" | "failed"
  placement: "transcript" | "queue"
  error?: string
}

export interface PendingPromptEdit {
  id: string
  sessionId: string
  sourceMessageId: string
  content: string
  items: SessionUserInputItem[]
  attachments: DesktopPromptAttachmentInput[]
}

export interface QueuedPromptAction {
  sessionId: string
  inputId: string
  runId: string
  kind: "promote" | "cancel"
  phase: "pending" | "acknowledged" | "failed"
  error?: string
}

export type DesktopOperationPhase = "pending" | "acknowledged" | "failed"

export type DesktopOperationKind =
  | "create-session"
  | "open-session"
  | "send-prompt"
  | "edit-prompt"
  | "promote-prompt"
  | "cancel-prompt"
  | "interrupt-run"
  | "reply-permission"
  | "project-action"

export interface DesktopOperation {
  id: string
  kind: DesktopOperationKind
  phase: DesktopOperationPhase
  sessionId: string | null
  projectId?: string
  target?: string
  startedAt: number
  finishedAt?: number
  error?: string
}

export interface DesktopSessionRuntime {
  operations: Record<string, DesktopOperation>
  pendingPromptSubmissions: Record<string, PendingPromptSubmission>
  pendingPromptEdit: PendingPromptEdit | null
  queuedPromptActions: Record<string, QueuedPromptAction>
}

export interface DesktopRuntimeState {
  appOperations: Record<string, DesktopOperation>
  projectOperations: Record<string, Record<string, DesktopOperation>>
  newConversationRuntime: DesktopSessionRuntime
  sessionRuntimes: Record<string, DesktopSessionRuntime>
}

export interface BootstrapActions {
  initialize: () => Promise<void>
  refreshBootstrap: () => Promise<void>
}

export interface ProjectActions {
  chooseProject: () => Promise<void>
  selectProject: (project: DesktopProject) => Promise<void>
  selectOutsideProject: () => void
  refreshSelectedProjectGit: (options?: { force?: boolean }) => Promise<boolean>
  checkoutBranch: (branch: string) => Promise<void>
  createAndCheckoutBranch: (branch: string) => Promise<void>
  renameProject: (path: string, name: string) => Promise<void>
  togglePinProject: (path: string) => Promise<void>
  setProjectDefaultShell: (path: string, shell: string | null) => Promise<void>
  removeProject: (path: string) => Promise<void>
  rebindProject: (projectId: string) => Promise<void>
}

export interface SessionActions {
  startNewConversation: () => Promise<void>
  selectModel: (model: DesktopModel) => Promise<void>
  selectPermissionMode: (mode: DesktopPermissionMode) => Promise<void>
  updateSessionModel: (sessionId: string, model: DesktopModel) => Promise<void>
  updateSessionPermissionMode: (
    sessionId: string,
    permissionMode: DesktopPermissionMode
  ) => Promise<void>
  updateSessionEffort: (sessionId: string, effort: string) => Promise<void>
  selectEffort: (effort: string) => void
  openSession: (sessionId: string) => Promise<void>
  resyncActiveSessionSnapshot: () => Promise<void>
  startConversationFrom: (session: DesktopSessionRecord) => Promise<void>
  forkSession: (
    sessionId: string,
    options?: { beforeMessageId?: string; afterMessageId?: string }
  ) => Promise<DesktopSessionRecord>
  renameSession: (sessionId: string, title: string) => Promise<void>
  togglePinSession: (sessionId: string) => Promise<void>
  archiveSession: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  startSession: (content: string, options?: SubmitPromptOptions) => Promise<string | null>
  refreshContextUsage: (options?: {
    refresh?: boolean
    previousContextWindow?: number
  }) => Promise<void>
}

export interface GoalComposerState {
  mode: boolean
  busy: boolean
  error: string | null
  maxAutoTurns: number
  ordinaryDraft?: DesktopComposerDraft
  editingGoal?: SessionGoal
  createdSessionId?: string
  request?: { fingerprint: string; id: string; actionInput?: DesktopSessionGoalActionInput }
  dismissedGoalId?: string
}

export interface GoalActions {
  setGoalMode: (scope: string, active: boolean) => void
  setGoalAutoTurns: (scope: string, count: number) => void
  dismissGoalError: (scope: string) => void
  dismissGoalBanner: (scope: string, goalId: string) => void
  refreshGoal: (sessionId: string) => Promise<void>
  submitGoal: (scope: string) => Promise<void>
  applyGoalAction: (
    sessionId: string,
    input: Pick<
      DesktopSessionGoalActionInput,
      "action" | "additionalAutoTurns" | "questionId" | "response"
    >
  ) => Promise<void>
}

export interface PromptActions {
  dismissPromptSubmission: (inputId: string) => void
  sendMessage: (content: string, options?: SubmitPromptOptions) => Promise<void>
  editLatestMessage: (
    sourceMessageId: string,
    content: string,
    document?: ComposerDocument
  ) => Promise<void>
  interrupt: () => Promise<void>
  replyPermission: (
    permissionId: string,
    status: "approved" | "denied",
    decision?: "once" | "session",
    answer?: string
  ) => Promise<void>
}

export interface QueuedPromptActions {
  promoteQueuedPrompt: (
    inputId: string,
    queuedRunId: string,
    expectedActiveRunId: string
  ) => Promise<void>
  cancelQueuedPrompt: (inputId: string, queuedRunId: string) => Promise<void>
}

export interface AttachmentActions {
  setComposerDraftText: (scope: string, text: string) => void
  setComposerDraftDocument: (scope: string, document: ComposerDocument) => void
  pickAttachmentFiles: (scope: string) => Promise<void>
  pickAttachmentImages: (scope: string) => Promise<void>
  addDroppedAttachments: (scope: string, files: readonly File[]) => Promise<void>
  addClipboardAttachment: (
    scope: string,
    input: Omit<UploadDesktopAttachmentMemoryInput, "draftId" | "taskId">
  ) => Promise<void>
  cancelAttachment: (scope: string, draftId: string) => Promise<void>
  retryAttachment: (scope: string, draftId: string) => Promise<void>
  removeAttachment: (scope: string, draftId: string) => Promise<void>
  migrateComposerDraft: (fromScope: string, toScope: string) => void
  resetComposerDraft: (scope: string) => void
  applyAttachmentUploadEvent: (event: DesktopAttachmentUploadEvent) => void
}

export interface DesktopSessionState
  extends
    DesktopRuntimeState,
    BootstrapActions,
    ProjectActions,
    SessionActions,
    GoalActions,
    PromptActions,
    AttachmentActions,
    QueuedPromptActions {
  composerDraftsByScope: ComposerDraftState["composerDraftsByScope"]
  goalsBySession: Record<string, SessionGoal | null>
  goalComposersByScope: Record<string, GoalComposerState>
  loadStatus: LoadStatus
  daemonStatus: DesktopDaemonStatus
  projects: DesktopProject[]
  sessions: DesktopSessionRecord[]
  archivedSessions: DesktopSessionRecord[]
  models: DesktopModel[]
  attachmentSupport: DesktopAttachmentSupport
  defaultModel: string | null
  defaultProvider: string | null
  defaultPermissionMode: DesktopPermissionMode
  selectedModel: string | null
  selectedProvider: string | null
  selectedPermissionMode: DesktopPermissionMode
  selectedEffort: string | null
  workspaceMode: DesktopWorkspaceMode
  outsideProjectWorkspaceRoot: string
  selectedProject: DesktopProject | null
  selectedProjectGit: boolean
  selectedProjectGitCheckedAt: number | null
  branch: string | null
  branches: string[]
  activeSessionId: string | null
  sessionView: DesktopSessionView | null
  activity: import("./activity-state").ActivityState
  selectedScheduledTaskId: string | null
  applyActivityUpdate: (update: import("@shared/activity-types").DesktopActivityUpdate) => void
  markActivitySessionRead: (sessionId: string) => void
  contextUsageSnapshot: DesktopContextUsageSnapshot | null
  applySessionUpdate: (view: DesktopSessionView) => void
}

export interface DesktopStoreContext {
  set: StoreApi<DesktopSessionState>["setState"]
  get: StoreApi<DesktopSessionState>["getState"]
  projectDetailsCoordinator: ProjectDetailsCoordinator
}
