import { applyBootstrapData } from "./bootstrap-actions"
import { forgetSessionActivity } from "./activity-state"
import { saveActivityPersistence } from "./activity-persistence"
import { errorMessage } from "./error-state"
import {
  isSessionPinned,
  resolveSessionWorkspace,
  sessionEffort,
  sessionPermissionMode,
  sessionProvider,
  upsertProject,
  upsertSession,
} from "./helpers"
import {
  beginOperation,
  createEmptySessionRuntime,
  failOperation,
  removeOperation,
} from "./operation-state"
import { clearPersistedActiveSessionId, writePersistedActiveSessionId } from "./persistence"
import { createStartSessionAction } from "./start-session-action"
import {
  acceptActiveSessionView,
  reconcileRuntimeWithView,
  releaseAcknowledgedRuntime,
} from "./session-view-state"
import { parseDesktopContextUsageSnapshot } from "@shared/parse-context-usage-snapshot"
import type {
  DesktopSessionRuntime,
  DesktopSessionState,
  DesktopStoreContext,
  SessionActions,
} from "./types"

interface SessionActionsContext extends DesktopStoreContext {
  scheduleSelectedProjectGitRefresh: (force: boolean) => void
}

type OpenSessionResult = "applied" | "cancelled" | "failed"

export function createSessionActions(context: SessionActionsContext): SessionActions {
  const { get, set, projectDetailsCoordinator } = context
  let primaryNavigationGeneration = 0
  let defaultSettingsGeneration = 0
  let contextUsageGeneration = 0
  const runtimeConfigGeneration = new Map<string, number>()
  const nextRuntimeConfigGeneration = (sessionId: string): number => {
    const generation = (runtimeConfigGeneration.get(sessionId) ?? 0) + 1
    runtimeConfigGeneration.set(sessionId, generation)
    return generation
  }
  let defaultSettingsWrite: Promise<void> = Promise.resolve()
  const advancePrimaryNavigation = (): number => {
    primaryNavigationGeneration += 1
    return primaryNavigationGeneration
  }
  const openPrimarySession = async (sessionId: string): Promise<OpenSessionResult> => {
    const projectSelectionGeneration = projectDetailsCoordinator.beginSelection()
    const operationId = globalThis.crypto.randomUUID()
    set((state) => {
      const previousActiveSessionId = state.activeSessionId
      const runtime = state.sessionRuntimes[sessionId] ?? createEmptySessionRuntime()
      const openingRuntime = beginOperation(abandonOpenSessionOperations(runtime), {
        id: operationId,
        kind: "open-session",
        sessionId,
        startedAt: Date.now(),
      })
      return {
        activeSessionId: sessionId,
        sessionView: null,
        contextUsageSnapshot: null,
        sessionRuntimes: {
          ...state.sessionRuntimes,
          ...(previousActiveSessionId && previousActiveSessionId !== sessionId
            ? {
                [previousActiveSessionId]: releaseAcknowledgedRuntime(
                  state.sessionRuntimes[previousActiveSessionId] ?? createEmptySessionRuntime()
                ),
              }
            : {}),
          [sessionId]: openingRuntime,
        },
      }
    })
    try {
      const view = await window.desktop.sessions.open(sessionId)
      let snapshotApplied = false
      set((state) => {
        const runtime = state.sessionRuntimes[sessionId]
        const operation = runtime?.operations[operationId]
        if (!operation || operation.phase !== "pending") {
          return state
        }
        if (state.activeSessionId !== sessionId) {
          return {
            sessionRuntimes: {
              ...state.sessionRuntimes,
              [sessionId]: removeOperation(runtime, operationId),
            },
          }
        }

        const acceptedView = acceptActiveSessionView(state.activeSessionId, state.sessionView, view)
        const settledRuntime = reconcileRuntimeWithView(removeOperation(runtime, operationId), view)
        if (acceptedView !== view) {
          return {
            sessionRuntimes: {
              ...state.sessionRuntimes,
              [sessionId]: settledRuntime,
            },
          }
        }

        snapshotApplied = true
        const workspace = resolveSessionWorkspace(state.projects, view.session)
        const ownsProjectSelection = projectDetailsCoordinator.ownsSelection(
          projectSelectionGeneration
        )
        return {
          ...(ownsProjectSelection ? workspace : {}),
          sessionView: view,
          selectedModel: view.session.model,
          selectedProvider: sessionProvider(view.session, state.defaultProvider),
          selectedPermissionMode: sessionPermissionMode(view.session, state.defaultPermissionMode),
          selectedEffort: sessionEffort(view.session),
          sessions:
            view.session.status === "archived"
              ? state.sessions.filter((session) => session.id !== view.session.id)
              : upsertSession(state.sessions, view.session),
          archivedSessions:
            view.session.status === "archived"
              ? upsertSession(state.archivedSessions, view.session)
              : state.archivedSessions,
          sessionRuntimes: {
            ...state.sessionRuntimes,
            [sessionId]: settledRuntime,
          },
        }
      })
      if (!snapshotApplied) return "cancelled"

      get().markActivitySessionRead(sessionId)
      if (view.session.storage !== "memory") writePersistedActiveSessionId(sessionId)
      const workspace = resolveSessionWorkspace(get().projects, view.session)
      if (
        workspace.selectedProject &&
        projectDetailsCoordinator.ownsSelection(projectSelectionGeneration)
      ) {
        const projectId = workspace.selectedProject.id
        const projectDetailsGeneration = projectDetailsCoordinator.beginDetails(projectId)
        try {
          const details = await window.desktop.sessions.inspectProject(
            workspace.selectedProject.path
          )
          if (
            get().activeSessionId !== sessionId ||
            get().selectedProject?.id !== projectId ||
            !projectDetailsCoordinator.ownsDetails(projectId, projectDetailsGeneration)
          )
            return "cancelled"
          set((state) => ({
            projects: upsertProject(state.projects, details.project),
            selectedProject: details.project,
            selectedProjectGit: details.git ?? Boolean(details.branch || details.branches?.length),
            selectedProjectGitCheckedAt: Date.now(),
            branch: details.branch,
            branches: details.branches ?? [],
          }))
        } catch {
          if (
            get().activeSessionId === sessionId &&
            get().selectedProject?.id === projectId &&
            projectDetailsCoordinator.ownsDetails(projectId, projectDetailsGeneration)
          ) {
            set({
              selectedProjectGit: false,
              selectedProjectGitCheckedAt: Date.now(),
              branch: null,
              branches: [],
            })
          }
        }
      }
      void get().refreshContextUsage()
      return "applied"
    } catch (error) {
      let failed = false
      set((state) => {
        const runtime = state.sessionRuntimes[sessionId]
        const operation = runtime?.operations[operationId]
        if (!operation || operation.phase !== "pending") {
          return state
        }
        if (state.activeSessionId !== sessionId) {
          return {
            sessionRuntimes: {
              ...state.sessionRuntimes,
              [sessionId]: removeOperation(runtime, operationId),
            },
          }
        }
        failed = true
        clearPersistedActiveSessionId()
        const failedRuntime = failOperation(runtime, operationId, errorMessage(error), Date.now())
        return {
          sessionRuntimes: {
            ...state.sessionRuntimes,
            [sessionId]: failedRuntime,
          },
        }
      })
      return failed ? "failed" : "cancelled"
    }
  }

  return {
    async startNewConversation() {
      advancePrimaryNavigation()
      await window.desktop.sessions.close()
      clearPersistedActiveSessionId()
      const newConversationRuntime = createEmptySessionRuntime()
      set((state) => {
        const previous = state.sessions.find((session) => session.id === state.activeSessionId)
        return {
          activeSessionId: null,
          sessionView: null,
          contextUsageSnapshot: null,
          selectedModel: previous?.model ?? state.selectedModel ?? state.defaultModel,
          selectedProvider: previous
            ? sessionProvider(previous, state.selectedProvider)
            : state.selectedProvider ?? state.defaultProvider,
          selectedPermissionMode: state.defaultPermissionMode,
          selectedEffort: previous ? sessionEffort(previous) : state.selectedEffort,
          newConversationRuntime,
          sessionRuntimes: releaseActiveSessionAcknowledgements(state),
        }
      })
    },

    async selectModel(model) {
      set({
        selectedModel: model.id,
        selectedProvider: model.providerName,
      })
    },

    async selectPermissionMode(permissionMode) {
      const generation = ++defaultSettingsGeneration
      set({
        selectedPermissionMode: permissionMode,
        defaultPermissionMode: permissionMode,
      })
      try {
        const request = defaultSettingsWrite.then(() =>
          window.desktop.sessions.setDefaultPermissionMode({ permissionMode })
        )
        defaultSettingsWrite = request.then(
          () => undefined,
          () => undefined
        )
        const data = await request
        if (generation !== defaultSettingsGeneration) return
        set((state) => ({
          ...applyBootstrapData(
            data,
            state.selectedProject,
            state.workspaceMode,
            state.selectedModel,
            state.selectedProvider
          ),
          selectedPermissionMode: permissionMode,
          defaultPermissionMode: permissionMode,
        }))
      } catch {
        if (generation !== defaultSettingsGeneration) return
      }
    },

    async updateSessionModel(sessionId, model, isCurrent) {
      const generation = nextRuntimeConfigGeneration(sessionId)
      const previousContextWindow =
        get().activeSessionId === sessionId ? get().contextUsageSnapshot?.contextWindow : undefined
      const session = await window.desktop.sessions.updateModel({
        sessionId,
        model: model.id,
        provider: model.providerName,
      })
      if (isCurrent && !isCurrent()) return
      if (runtimeConfigGeneration.get(sessionId) !== generation) return
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        selectedModel: state.activeSessionId === sessionId ? session.model : state.selectedModel,
        selectedProvider:
          state.activeSessionId === sessionId
            ? sessionProvider(session, model.providerName)
            : state.selectedProvider,
        sessionView:
          state.sessionView?.session.id === sessionId
            ? { ...state.sessionView, session }
            : state.sessionView,
      }))
      if (get().activeSessionId === sessionId) {
        void get().refreshContextUsage({
          refresh: true,
          ...(previousContextWindow != null ? { previousContextWindow } : {}),
        })
      }
    },

    async updateSessionPermissionMode(sessionId, permissionMode, isCurrent) {
      const session = await window.desktop.sessions.updatePermissionMode({
        sessionId,
        permissionMode,
      })
      if (isCurrent && !isCurrent()) return
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        selectedPermissionMode:
          state.activeSessionId === sessionId
            ? sessionPermissionMode(session)
            : state.selectedPermissionMode,
        sessionView:
          state.sessionView?.session.id === sessionId
            ? { ...state.sessionView, session }
            : state.sessionView,
      }))
    },

    async updateSessionEffort(sessionId, effort, isCurrent) {
      const generation = nextRuntimeConfigGeneration(sessionId)
      const session = await window.desktop.sessions.updateEffort({ sessionId, effort })
      if (isCurrent && !isCurrent()) return
      if (runtimeConfigGeneration.get(sessionId) !== generation) return
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        selectedEffort:
          state.activeSessionId === sessionId ? sessionEffort(session) : state.selectedEffort,
        sessionView:
          state.sessionView?.session.id === sessionId
            ? { ...state.sessionView, session }
            : state.sessionView,
      }))
    },

    selectEffort(effort) {
      set({ selectedEffort: effort.trim() ? effort.trim() : null })
    },

    async openSession(sessionId) {
      if (!sessionId) return
      advancePrimaryNavigation()
      await openPrimarySession(sessionId)
    },

    async resyncActiveSessionSnapshot() {
      const sessionId = get().activeSessionId
      if (!sessionId) return
      const runtime = get().sessionRuntimes[sessionId]
      if (
        Object.values(runtime?.operations ?? {}).some(
          (operation) => operation.kind === "open-session" && operation.phase === "pending"
        )
      )
        return
      try {
        const view = await window.desktop.sessions.open(sessionId)
        if (get().activeSessionId === sessionId) get().applySessionUpdate(view)
      } catch {
        // A resync is only a recovery read. It must not replace a user-owned open error.
      }
    },

    async startConversationFrom(session) {
      advancePrimaryNavigation()
      await window.desktop.sessions.close()
      clearPersistedActiveSessionId()
      const workspace = resolveSessionWorkspace(get().projects, session)
      const newConversationRuntime = createEmptySessionRuntime()
      set((state) => ({
        activeSessionId: null,
        sessionView: null,
        ...workspace,
        selectedModel: session.model,
        selectedProvider: sessionProvider(session, get().defaultProvider),
        selectedPermissionMode: sessionPermissionMode(session, get().defaultPermissionMode),
        selectedEffort: sessionEffort(session),
        selectedProjectGit: false,
        selectedProjectGitCheckedAt: null,
        branch: null,
        branches: [],
        newConversationRuntime,
        sessionRuntimes: releaseActiveSessionAcknowledgements(state),
      }))
      if (workspace.selectedProject) await get().selectProject(workspace.selectedProject)
    },

    async forkSession(sessionId, options) {
      if (!sessionId) throw new Error("会话 ID 不能为空")
      const navigationOwnerSessionId = get().activeSessionId
      const navigationOwnerGeneration = primaryNavigationGeneration
      const session = await window.desktop.sessions.fork({
        sessionId,
        ...(options?.beforeMessageId ? { beforeMessageId: options.beforeMessageId } : {}),
        ...(options?.afterMessageId ? { afterMessageId: options.afterMessageId } : {}),
      })
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        archivedSessions: state.archivedSessions.filter((item) => item.id !== session.id),
      }))
      if (
        primaryNavigationGeneration === navigationOwnerGeneration &&
        get().activeSessionId === navigationOwnerSessionId
      ) {
        await get().openSession(session.id)
      }
      return session
    },

    async renameSession(sessionId, title) {
      const normalizedTitle = title.replace(/\s+/g, " ").trim()
      if (!normalizedTitle) return
      const session = await window.desktop.sessions.rename({ sessionId, title: normalizedTitle })
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        sessionView:
          state.sessionView?.session.id === sessionId
            ? { ...state.sessionView, session }
            : state.sessionView,
      }))
    },

    async togglePinSession(sessionId) {
      const existing = get().sessions.find((session) => session.id === sessionId)
      if (!existing) return
      const session = await window.desktop.sessions.setPinned({
        sessionId,
        pinned: !isSessionPinned(existing),
      })
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        sessionView:
          state.sessionView?.session.id === sessionId
            ? { ...state.sessionView, session }
            : state.sessionView,
      }))
    },

    async archiveSession(sessionId) {
      const existing = get().sessions.find((session) => session.id === sessionId)
      if (!existing) return
      const invalidatesPrimaryNavigation = get().activeSessionId === sessionId
      if (invalidatesPrimaryNavigation) advancePrimaryNavigation()
      const archived = await window.desktop.sessions.archive(sessionId)
      const isActive = get().activeSessionId === sessionId
      set((state) => ({
        ...(isActive ? resolveSessionWorkspace(state.projects, existing) : {}),
        sessions: state.sessions.filter((session) => session.id !== sessionId),
        archivedSessions: upsertSession(state.archivedSessions, archived),
        activeSessionId: isActive ? null : state.activeSessionId,
        sessionView: isActive ? null : state.sessionView,
        sessionRuntimes: removeSessionRuntimes(state.sessionRuntimes, new Set([sessionId])),
        selectedModel: isActive ? existing.model : state.selectedModel,
        selectedProvider: isActive
          ? sessionProvider(existing, state.defaultProvider)
          : state.selectedProvider,
        selectedPermissionMode: isActive
          ? sessionPermissionMode(existing, state.defaultPermissionMode)
          : state.selectedPermissionMode,
        selectedEffort: isActive ? sessionEffort(existing) : state.selectedEffort,
      }))
      if (isActive) {
        clearPersistedActiveSessionId()
        const project = get().selectedProject
        if (project) await get().selectProject(project)
      }
    },

    async deleteSession(sessionId) {
      const existing =
        get().sessions.find((session) => session.id === sessionId) ??
        get().archivedSessions.find((session) => session.id === sessionId)
      if (!existing) return
      const invalidatesPrimaryNavigation = get().activeSessionId === sessionId
      if (invalidatesPrimaryNavigation) advancePrimaryNavigation()
      const deletedSessionIds = await window.desktop.sessions.delete(sessionId)
      const deleted = new Set(deletedSessionIds)
      const activeSessionId = get().activeSessionId
      const isActive = activeSessionId !== null && deleted.has(activeSessionId)
      set((state) => ({
        ...(isActive ? resolveSessionWorkspace(state.projects, existing) : {}),
        sessions: state.sessions.filter((session) => !deleted.has(session.id)),
        activity: forgetSessionActivity(state.activity, deleted),
        archivedSessions: state.archivedSessions.filter((session) => !deleted.has(session.id)),
        activeSessionId: isActive ? null : state.activeSessionId,
        sessionView:
          state.sessionView && deleted.has(state.sessionView.session.id) ? null : state.sessionView,
        sessionRuntimes: removeSessionRuntimes(state.sessionRuntimes, deleted),
        selectedModel: isActive ? existing.model : state.selectedModel,
        selectedProvider: isActive
          ? sessionProvider(existing, state.defaultProvider)
          : state.selectedProvider,
        selectedPermissionMode: isActive
          ? sessionPermissionMode(existing, state.defaultPermissionMode)
          : state.selectedPermissionMode,
        selectedEffort: isActive ? sessionEffort(existing) : state.selectedEffort,
      }))
      saveActivityPersistence(get().activity)
      if (isActive) {
        clearPersistedActiveSessionId()
        const project = get().selectedProject
        if (project) await get().selectProject(project)
      }
    },

    startSession: createStartSessionAction(context, {
      navigationGeneration: () => primaryNavigationGeneration,
      advancePrimaryNavigation,
      openPrimarySession,
    }),

    async refreshContextUsage(options) {
      const generation = ++contextUsageGeneration
      const state = get()
      const cwd =
        state.sessionView?.session.cwd ??
        state.selectedProject?.path ??
        state.outsideProjectWorkspaceRoot
      if (!cwd) return
      const sessionId = state.activeSessionId ?? undefined
      try {
        if (typeof window.desktop.sessions.getContextUsage !== "function") return
        const snapshot = await window.desktop.sessions.getContextUsage({
          cwd,
          ...(sessionId ? { sessionId } : {}),
          ...(options?.refresh !== undefined ? { refresh: options.refresh } : {}),
          ...(options?.previousContextWindow !== undefined
            ? { previousContextWindow: options.previousContextWindow }
            : {}),
        })
        const parsed = parseDesktopContextUsageSnapshot(snapshot)
        // Ignore stale responses if the active session changed mid-flight.
        const latest = get()
        if (generation !== contextUsageGeneration) return
        if ((latest.activeSessionId ?? undefined) !== sessionId) return
        if (parsed) set({ contextUsageSnapshot: parsed })
      } catch {
        // 环保留上次成功快照；不阻断 composer。
      }
    },
  }

}

function removeSessionRuntimes(
  runtimes: Record<string, DesktopSessionRuntime>,
  sessionIds: Set<string>
): Record<string, DesktopSessionRuntime> {
  return Object.fromEntries(
    Object.entries(runtimes).filter(([sessionId]) => !sessionIds.has(sessionId))
  )
}

function abandonOpenSessionOperations(runtime: DesktopSessionRuntime): DesktopSessionRuntime {
  const operations = Object.fromEntries(
    Object.entries(runtime.operations).filter(([, operation]) => operation.kind !== "open-session")
  )
  return Object.keys(operations).length === Object.keys(runtime.operations).length
    ? runtime
    : { ...runtime, operations }
}

function releaseActiveSessionAcknowledgements(
  state: Pick<DesktopSessionState, "activeSessionId" | "sessionRuntimes">
): DesktopSessionState["sessionRuntimes"] {
  const sessionId = state.activeSessionId
  if (!sessionId) return state.sessionRuntimes
  return {
    ...state.sessionRuntimes,
    [sessionId]: releaseAcknowledgedRuntime(
      state.sessionRuntimes[sessionId] ?? createEmptySessionRuntime()
    ),
  }
}
