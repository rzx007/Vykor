import type { DesktopDaemonStatus } from "@shared/session-types"
import { disabledDesktopAttachmentSupport } from "@shared/attachment-types"

import { createEmptySessionRuntime } from "./operation-state"
import { emptyComposerDraftState } from "./composer-draft-state"
import { createActivityState } from "./activity-state"
import { readActivityPersistence } from "./activity-persistence"
import type {
  BootstrapActions,
  AttachmentActions,
  DesktopRuntimeState,
  DesktopSessionState,
  ProjectActions,
  PromptActions,
  QueuedPromptActions,
  SessionActions,
  GoalActions,
} from "./types"

const initialDaemonStatus: DesktopDaemonStatus = {
  phase: "idle",
  message: "等待连接 daemon",
  updatedAt: Date.now(),
}

function createInitialDaemonStatus(): DesktopDaemonStatus {
  return initialDaemonStatus
}

export function createInitialRuntimeState(): DesktopRuntimeState {
  return {
    appOperations: {},
    projectOperations: {},
    newConversationRuntime: createEmptySessionRuntime(),
    sessionRuntimes: {},
  }
}

export function createInitialState(): Omit<
  DesktopSessionState,
  | keyof BootstrapActions
  | keyof AttachmentActions
  | keyof ProjectActions
  | keyof SessionActions
  | keyof GoalActions
  | keyof PromptActions
  | keyof QueuedPromptActions
  | "applySessionUpdate"
  | "applyActivityUpdate"
  | "markActivitySessionRead"
> {
  return {
    loadStatus: "idle" as const,
    goalsBySession: {},
    goalComposersByScope: {},
    daemonStatus: createInitialDaemonStatus(),
    projects: [],
    sessions: [],
    archivedSessions: [],
    models: [],
    attachmentSupport: disabledDesktopAttachmentSupport,
    defaultModel: null,
    defaultProvider: null,
    defaultPermissionMode: "default" as const,
    selectedModel: null,
    selectedProvider: null,
    selectedPermissionMode: "default" as const,
    selectedEffort: null,
    workspaceMode: "project" as const,
    outsideProjectWorkspaceRoot: "",
    selectedProject: null,
    selectedProjectGit: false,
    selectedProjectGitCheckedAt: null,
    branch: null,
    branches: [],
    activeSessionId: null,
    sessionView: null,
    activity: createActivityState(readActivityPersistence()),
    selectedScheduledTaskId: null,
    contextUsageSnapshot: null,
    ...emptyComposerDraftState(),
    ...createInitialRuntimeState(),
  }
}
