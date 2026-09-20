import { createEmptySessionRuntime } from "./operation-state"
import {
  isChannelSession,
  isSessionPinned,
  projectFromSession,
  outsideProjectDraftWorkspace,
} from "./helpers"
import { channelConnectorLabel } from "@shared/channel-types"
import type { DesktopProject, DesktopSessionRecord } from "@shared/session-types"
import type {
  DesktopOperation,
  DesktopOperationKind,
  DesktopSessionRuntime,
  DesktopSessionState,
} from "./types"

const emptySessionRuntime = createEmptySessionRuntime()
const outsideWorkspaceProjects = new WeakMap<DesktopSessionRecord, DesktopProject>()
let cachedOutsideDraftRoot: string | null = null
let cachedOutsideDraftWorkspace: DesktopProject | null = null
const permissionReplyStatesByOperations = new WeakMap<
  Record<string, DesktopOperation>,
  Record<string, PermissionReplyState>
>()

const composerOperationKinds = new Set<DesktopOperationKind>([
  "send-prompt",
  "edit-prompt",
])

const sessionErrorOperationKinds = new Set<DesktopOperationKind>([
  "open-session",
  "edit-prompt",
  "interrupt-run",
])

export interface PermissionReplyState {
  pending: boolean
  error: string | null
}

export function selectDaemonStatus(
  state: DesktopSessionState
): DesktopSessionState["daemonStatus"] {
  return state.daemonStatus
}

export function selectLoadStatus(state: DesktopSessionState): DesktopSessionState["loadStatus"] {
  return state.loadStatus
}

export function selectProjects(state: DesktopSessionState): DesktopSessionState["projects"] {
  return state.projects
}

export function selectSessions(state: DesktopSessionState): DesktopSessionState["sessions"] {
  return state.sessions
}

export function selectArchivedSessions(
  state: DesktopSessionState
): DesktopSessionState["archivedSessions"] {
  return state.archivedSessions
}

export function selectActiveSessionId(
  state: DesktopSessionState
): DesktopSessionState["activeSessionId"] {
  return state.activeSessionId
}

export interface DesktopImSessionGroup {
  connector: string
  label: string
  sessions: DesktopSessionRecord[]
}

/**
 * 「IM 会话」分区的数据：仅未归档的渠道会话，按平台分组。
 * 组内置顶优先、再按更新时间倒序；组间按各组最新更新时间倒序。
 */
export function selectImSessionGroups(state: DesktopSessionState): DesktopImSessionGroup[] {
  const byConnector = new Map<string, DesktopSessionRecord[]>()
  for (const session of state.sessions) {
    if (!isChannelSession(session)) continue
    const connector = readChannelConnector(session)
    const list = byConnector.get(connector)
    if (list) list.push(session)
    else byConnector.set(connector, [session])
  }
  const groups = [...byConnector.entries()].map(([connector, sessions]) => ({
    connector,
    label: channelConnectorLabel(connector === "other" ? undefined : connector),
    sessions: [...sessions].sort(compareImSessions),
  }))
  groups.sort(
    (left, right) =>
      latestUpdatedAt(right.sessions) - latestUpdatedAt(left.sessions) ||
      left.connector.localeCompare(right.connector)
  )
  return groups
}

function readChannelConnector(session: DesktopSessionRecord): string {
  const external = session.metadata["externalConversation"]
  if (isRecord(external)) {
    const connector = external["connector"]
    if (typeof connector === "string" && connector.trim()) return connector.trim().toLowerCase()
  }
  return "other"
}

function compareImSessions(left: DesktopSessionRecord, right: DesktopSessionRecord): number {
  return (
    Number(isSessionPinned(right)) - Number(isSessionPinned(left)) ||
    right.updatedAt - left.updatedAt ||
    left.id.localeCompare(right.id)
  )
}

function latestUpdatedAt(sessions: DesktopSessionRecord[]): number {
  return sessions.reduce((max, session) => Math.max(max, session.updatedAt), 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function selectActiveSessionRecord(
  state: DesktopSessionState
): DesktopSessionRecord | null {
  if (!state.activeSessionId) return null
  return state.sessionView?.session.id === state.activeSessionId
    ? state.sessionView.session
    : (state.sessions.find((session) => session.id === state.activeSessionId) ?? null)
}

/** 右侧工具使用的实际工作目录；项目外会话使用它自己的托管 xN 目录。 */
export function selectActiveWorkspaceProject(state: DesktopSessionState): DesktopProject | null {
  const activeSession = state.activeSessionId
    ? state.sessionView?.session.id === state.activeSessionId
      ? state.sessionView.session
      : state.sessions.find((session) => session.id === state.activeSessionId)
    : null
  if (activeSession?.workspaceMode === "outside_project") {
    const cached = outsideWorkspaceProjects.get(activeSession)
    if (cached) return cached
    const workspace = projectFromSession(activeSession)
    outsideWorkspaceProjects.set(activeSession, workspace)
    return workspace
  }
  if (state.selectedProject) return state.selectedProject
  if (state.workspaceMode === "outside_project" && state.outsideProjectWorkspaceRoot.trim()) {
    return getOutsideProjectDraftWorkspace(state.outsideProjectWorkspaceRoot)
  }
  return null
}

function getOutsideProjectDraftWorkspace(root: string): DesktopProject {
  if (cachedOutsideDraftRoot === root && cachedOutsideDraftWorkspace) {
    return cachedOutsideDraftWorkspace
  }
  cachedOutsideDraftRoot = root
  cachedOutsideDraftWorkspace = outsideProjectDraftWorkspace(root)
  return cachedOutsideDraftWorkspace
}

/** slash 命令目录使用的 cwd：有会话时用会话 cwd，否则回退到项目路径或项目外托管根目录。 */
export function selectCommandCatalogCwd(state: DesktopSessionState): string | null {
  if (state.activeSessionId) {
    const session =
      state.sessionView?.session.id === state.activeSessionId
        ? state.sessionView.session
        : state.sessions.find((item) => item.id === state.activeSessionId)
    if (session?.cwd) return session.cwd
  }
  if (state.selectedProject) return state.selectedProject.path
  if (state.workspaceMode === "outside_project" && state.outsideProjectWorkspaceRoot.trim()) {
    return state.outsideProjectWorkspaceRoot
  }
  return null
}

export function selectActiveSessionRuntime(state: DesktopSessionState): DesktopSessionRuntime {
  return selectSessionRuntime(state, state.activeSessionId)
}

export function selectSessionRuntime(
  state: DesktopSessionState,
  sessionId: string | null
): DesktopSessionRuntime {
  return sessionId ? (state.sessionRuntimes[sessionId] ?? emptySessionRuntime) : emptySessionRuntime
}

export function selectNewConversationSending(state: DesktopSessionState): boolean {
  return hasPendingOperation(state.newConversationRuntime, "create-session")
}

export function selectSessionSending(state: DesktopSessionState, sessionId: string): boolean {
  const runtime = selectSessionRuntime(state, sessionId)
  return hasPendingComposerOperation(runtime) || hasSubmittingPrompt(runtime)
}

export function selectActiveSessionSending(state: DesktopSessionState): boolean {
  return state.activeSessionId ? selectSessionSending(state, state.activeSessionId) : false
}

export function selectActiveSessionOpening(state: DesktopSessionState): boolean {
  return Boolean(
    state.activeSessionId &&
    hasPendingOperation(selectSessionRuntime(state, state.activeSessionId), "open-session")
  )
}

export function selectActiveSessionPromptSubmissions(
  state: DesktopSessionState
): DesktopSessionRuntime["pendingPromptSubmissions"] {
  return selectActiveSessionRuntime(state).pendingPromptSubmissions
}

export function selectActiveSessionQueuedPromptActions(
  state: DesktopSessionState
): DesktopSessionRuntime["queuedPromptActions"] {
  return selectActiveSessionRuntime(state).queuedPromptActions
}

export function selectPermissionReplyPending(
  state: DesktopSessionState,
  sessionId: string,
  permissionId: string
): boolean {
  return selectPermissionReplyOperation(state, sessionId, permissionId)?.phase === "pending"
}

export function selectPermissionReplyError(
  state: DesktopSessionState,
  sessionId: string,
  permissionId: string
): string | null {
  const operation = selectPermissionReplyOperation(state, sessionId, permissionId)
  return operation?.phase === "failed" ? (operation.error ?? null) : null
}

export function selectActiveSessionPermissionReplies(
  state: DesktopSessionState
): Record<string, PermissionReplyState> {
  const operations = selectActiveSessionRuntime(state).operations
  const cached = permissionReplyStatesByOperations.get(operations)
  if (cached) return cached
  const replies: Record<string, PermissionReplyState> = {}
  for (const operation of Object.values(operations)) {
    if (operation.kind !== "reply-permission" || !operation.target) continue
    replies[operation.target] = {
      pending: operation.phase === "pending",
      error: operation.phase === "failed" ? (operation.error ?? null) : null,
    }
  }
  permissionReplyStatesByOperations.set(operations, replies)
  return replies
}

export function selectSessionComposerError(
  state: DesktopSessionState,
  sessionId: string
): string | null {
  const runtime = selectSessionRuntime(state, sessionId)
  return selectLatestOperationError(runtime.operations, (operation) =>
    sessionErrorOperationKinds.has(operation.kind)
  )
}

export function selectActiveSessionComposerError(state: DesktopSessionState): string | null {
  return state.activeSessionId ? selectSessionComposerError(state, state.activeSessionId) : null
}

export function selectNewConversationError(state: DesktopSessionState): string | null {
  return selectLatestOperationError(
    state.newConversationRuntime.operations,
    (operation) => operation.kind === "create-session"
  )
}

export function selectAppOperationError(state: DesktopSessionState): string | null {
  return selectLatestOperationError(
    state.appOperations,
    (operation) => operation.target === "initialize" || operation.target === "choose-project"
  )
}

export function selectProjectOperationError(
  state: DesktopSessionState,
  projectId: string | null
): string | null {
  return projectId
    ? selectLatestOperationError(state.projectOperations[projectId] ?? {}, () => true)
    : null
}

function hasPendingComposerOperation(runtime: DesktopSessionRuntime): boolean {
  return hasPendingOperation(runtime, (kind) => composerOperationKinds.has(kind))
}

function selectPermissionReplyOperation(
  state: DesktopSessionState,
  sessionId: string,
  permissionId: string
): DesktopOperation | undefined {
  const operation = selectSessionRuntime(state, sessionId).operations[
    `${sessionId}:${permissionId}`
  ]
  return operation?.kind === "reply-permission" ? operation : undefined
}

function hasSubmittingPrompt(runtime: DesktopSessionRuntime): boolean {
  return Object.values(runtime.pendingPromptSubmissions).some(
    (submission) => submission.phase === "submitting"
  )
}

function hasPendingOperation(
  runtime: DesktopSessionRuntime,
  kind: DesktopOperationKind | ((kind: DesktopOperationKind) => boolean)
): boolean {
  return Object.values(runtime.operations).some(
    (operation) =>
      operation.phase === "pending" &&
      (typeof kind === "function" ? kind(operation.kind) : operation.kind === kind)
  )
}

function selectLatestOperationError(
  operations: Record<string, DesktopOperation>,
  matches: (operation: DesktopOperation) => boolean
): string | null {
  let latest: DesktopOperation | null = null
  for (const operation of Object.values(operations)) {
    if (
      operation.phase === "failed" &&
      operation.error &&
      matches(operation) &&
      (!latest ||
        (operation.finishedAt ?? operation.startedAt) >= (latest.finishedAt ?? latest.startedAt))
    ) {
      latest = operation
    }
  }
  return latest?.error ?? null
}
