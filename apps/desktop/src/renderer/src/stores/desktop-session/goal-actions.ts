import type { SessionGoal } from "@shared/session-types"
import { areDesktopAttachmentsSendable } from "@shared/attachment-types"
import {
  NEW_CONVERSATION_SCOPE,
  selectDraftAttachments,
  selectDraftDocument,
  sessionComposerScope,
} from "./composer-draft-state"
import {
  composerDocument,
  emptyComposerDocument,
  sameComposerDocument,
  type ComposerDocument,
} from "./composer-document"
import { upsertSession } from "./helpers"
import type { DesktopStoreContext, GoalActions, GoalComposerState } from "./types"

export const emptyGoalComposer: GoalComposerState = {
  mode: false,
  busy: false,
  error: null,
  maxAutoTurns: 0,
}
export const isOpenGoal = (goal: SessionGoal | null | undefined): goal is SessionGoal =>
  Boolean(goal && goal.status !== "completed" && goal.status !== "cancelled")
export const selectGoalObjective = (document: ComposerDocument): string =>
  document.items
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("")
    .trim()

function goalErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("请先等待用户任务结束"))
    return "补充消息仍在排队或处理中，请等待处理结束后再继续目标。"
  const marker = "Daemon operation is blocked by maintenance:"
  const index = message.indexOf(marker)
  if (index < 0) return message
  const operation = message.slice(index + marker.length).trim()
  return operation ? `正在${operation}，请稍后重试。` : "系统正在维护，请稍后重试。"
}

type GoalSessionState = {
  goalsBySession: Record<string, SessionGoal | null>
  goalComposersByScope: Record<string, GoalComposerState>
}

/**
 * 删除会话时回收与该会话绑定的目标状态。
 *
 * `goalsBySession` 直接以 sessionId 为键；`goalComposersByScope` 则以
 * `session:<id>` 为键，目标模式下还有 `goal-ordinary:session:<id>` 变体。
 * 两者都按「访问过的会话数」增长，删除会话时不清就会一直留着。
 */
export function forgetSessionGoals(
  state: GoalSessionState,
  deleted: ReadonlySet<string>
): GoalSessionState {
  const deletedScopes = new Set<string>()
  for (const sessionId of deleted) {
    deletedScopes.add(sessionComposerScope(sessionId))
    deletedScopes.add(`goal-ordinary:${sessionComposerScope(sessionId)}`)
  }
  return {
    goalsBySession: Object.fromEntries(
      Object.entries(state.goalsBySession).filter(([sessionId]) => !deleted.has(sessionId))
    ),
    goalComposersByScope: Object.fromEntries(
      Object.entries(state.goalComposersByScope).filter(([scope]) => !deletedScopes.has(scope))
    ),
  }
}

export function createGoalActions({ get, set }: DesktopStoreContext): GoalActions {
  const reads = new Map<string, Promise<void>>()
  const refreshAgain = new Set<string>()
  const generations = new Map<string, number>()
  const updateComposer = (scope: string, patch: Partial<GoalComposerState>): void => {
    set((state) => ({
      goalComposersByScope: {
        ...state.goalComposersByScope,
        [scope]: { ...(state.goalComposersByScope[scope] ?? emptyGoalComposer), ...patch },
      },
    }))
  }
  const saveGoal = (sessionId: string, goal: SessionGoal | null): void => {
    set((state) => {
      const current = state.goalsBySession[sessionId]
      if (!goal && current && (current.status === "cancelled" || current.status === "completed")) return state
      const merged = current && goal && current.id === goal.id
        ? { ...(current.revision > goal.revision ? current : goal),
            usage: current.usage.seq > goal.usage.seq ? current.usage : goal.usage }
        : goal
      return { goalsBySession: { ...state.goalsBySession, [sessionId]: merged } }
    })
  }
  const invalidateRead = (sessionId: string): void => {
    generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1)
  }
  return {
    setGoalMode(scope, active) {
      const state = get()
      const composer = state.goalComposersByScope[scope] ?? emptyGoalComposer
      if (composer.busy || composer.mode === active) return
      const goal = scope.startsWith("session:") ? state.goalsBySession[scope.slice(8)] : null
      if (active && isOpenGoal(goal)) {
        const ordinaryDraft = {
          document: selectDraftDocument(state, scope),
          attachments: selectDraftAttachments(state, scope),
        }
        set((current) => ({
          composerDraftsByScope: {
            ...current.composerDraftsByScope,
            [`goal-ordinary:${scope}`]: ordinaryDraft,
            [scope]: {
              document: composerDocument([{ type: "text", text: goal.objective }]),
              attachments: [],
            },
          },
        }))
        updateComposer(scope, {
          mode: true,
          ordinaryDraft,
          editingGoal: goal,
          request: undefined,
          error: null,
        })
      } else {
        if (!active && composer.ordinaryDraft) {
          set((current) => {
            const drafts = { ...current.composerDraftsByScope }
            drafts[scope] = drafts[`goal-ordinary:${scope}`] ?? composer.ordinaryDraft!
            delete drafts[`goal-ordinary:${scope}`]
            return { composerDraftsByScope: drafts }
          })
        }
        updateComposer(scope, {
          mode: active,
          ordinaryDraft: undefined,
          editingGoal: undefined,
          error: null,
        })
      }
    },
    setGoalAutoTurns(scope, maxAutoTurns) {
      if (!get().goalComposersByScope[scope]?.busy) updateComposer(scope, { maxAutoTurns })
    },
    setGoalTokenBudget(scope, tokenBudget) {
      if (!get().goalComposersByScope[scope]?.busy) updateComposer(scope, { tokenBudget })
    },
    dismissGoalError(scope) {
      updateComposer(scope, { error: null })
    },
    dismissGoalBanner(scope, goalId) {
      updateComposer(scope, { dismissedGoalId: goalId })
    },
    async refreshGoal(sessionId) {
      const getGoal = window.desktop?.sessions?.getGoal
      if (typeof getGoal !== "function") return
      const existing = reads.get(sessionId)
      if (existing) {
        refreshAgain.add(sessionId)
        return existing
      }
      const generation = generations.get(sessionId) ?? 0
      const request = (async () => {
        try {
          const goal = await getGoal({ sessionId })
          if ((generations.get(sessionId) ?? 0) === generation) saveGoal(sessionId, goal)
        } catch {
          // Preserve the last known state during reconnect; the next event/read retries.
        } finally {
          reads.delete(sessionId)
          if (refreshAgain.delete(sessionId)) await get().refreshGoal(sessionId)
        }
      })()
      reads.set(sessionId, request)
      return request
    },
    async submitGoal(scope) {
      const state = get()
      const modeKey = scope.startsWith("session:") ? scope.slice(8) : "new"
      if (state.pendingModeChanges[modeKey]) return
      const composer = state.goalComposersByScope[scope] ?? emptyGoalComposer
      if (!composer.mode || composer.busy) return
      const document = selectDraftDocument(state, scope)
      const attachmentDrafts = selectDraftAttachments(state, scope)
      const objective = selectGoalObjective(document)
      if (!objective || !areDesktopAttachmentsSendable(attachmentDrafts)) return
      const editingGoal = composer.editingGoal
      if (
        !editingGoal &&
        (!Number.isSafeInteger(composer.maxAutoTurns) ||
          composer.maxAutoTurns < 0 ||
          composer.maxAutoTurns > 1000)
      ) {
        updateComposer(scope, { error: "自动续跑次数需为 1 到 1000 的整数，留空表示不限。" })
        return
      }
      const attachments = attachmentDrafts.flatMap((item) =>
        item.assetId
          ? [{ assetId: item.assetId, intent: "auto" as const, displayName: item.displayName }]
          : []
      )
      const rawBudget = (composer.tokenBudget ?? "").trim()
      const tokenBudget = rawBudget ? Number(rawBudget) : undefined
      if (!editingGoal && rawBudget && (!/^\d+$/.test(rawBudget) || !Number.isSafeInteger(tokenBudget) || tokenBudget! <= 0)) {
        updateComposer(scope, { error: "Token 总预算需为正整数，留空表示不限制。" })
        return
      }
      const fingerprint = JSON.stringify({
        objective,
        items: document.items,
        attachments,
        goalId: editingGoal?.id,
        revision: editingGoal?.revision,
        ...(!editingGoal ? { tokenBudget, maxAutoTurns: composer.maxAutoTurns } : {}),
      })
      const requestId =
        composer.request?.fingerprint === fingerprint ? composer.request.id : crypto.randomUUID()
      updateComposer(scope, { busy: true, error: null, request: { fingerprint, id: requestId } })
      let sessionId = scope.startsWith("session:") ? scope.slice(8) : composer.createdSessionId
      try {
        if (!sessionId) {
          if (!state.selectedModel || (state.workspaceMode === "project" && !state.selectedProject))
            throw new Error("请先选择项目和模型。")
          const base = {
            model: state.selectedModel,
            ...(state.selectedProvider ? { provider: state.selectedProvider } : {}),
            permissionMode: state.selectedPermissionMode,
            workMode: state.selectedWorkMode,
            ...(state.selectedEffort ? { effort: state.selectedEffort } : {}),
          }
          const session = await window.desktop.sessions.create(
            state.workspaceMode === "project" && state.selectedProject
              ? { ...base, projectId: state.selectedProject.id, cwd: state.selectedProject.path }
              : base
          )
          sessionId = session.id
          updateComposer(scope, { createdSessionId: sessionId })
          set((current) => ({ sessions: upsertSession(current.sessions, session) }))
        }
        invalidateRead(sessionId)
        const payload = { sessionId, requestId, objective, items: document.items, attachments }
        const goal = editingGoal
          ? await window.desktop.sessions.updateGoal({
              ...payload,
              goalId: editingGoal.id,
              expectedRevision: editingGoal.revision,
            })
          : await window.desktop.sessions.createGoal({
              ...payload,
              maxAutoTurns: composer.maxAutoTurns,
              tokenBudget,
            })
        invalidateRead(sessionId)
        saveGoal(sessionId, goal)
        // Only consume the exact submitted draft, even if another view changed it meanwhile.
        set((current) => {
          const currentDraft = current.composerDraftsByScope[scope]
          if (!currentDraft) return current
          const submittedIds = new Set(attachmentDrafts.map((item) => item.draftId))
          const drafts = {
            ...current.composerDraftsByScope,
            [scope]: (composer.ordinaryDraft
              ? (current.composerDraftsByScope[`goal-ordinary:${scope}`] ?? composer.ordinaryDraft)
              : undefined) ?? {
              document: sameComposerDocument(currentDraft.document, document)
                ? emptyComposerDocument
                : currentDraft.document,
              attachments: currentDraft.attachments.filter(
                (item) => !submittedIds.has(item.draftId)
              ),
            },
          }
          delete drafts[`goal-ordinary:${scope}`]
          return { composerDraftsByScope: drafts }
        })
        updateComposer(scope, {
          mode: false,
          request: undefined,
          ordinaryDraft: undefined,
          editingGoal: undefined,
          createdSessionId: undefined,
          dismissedGoalId: undefined,
        })
        if (
          scope === NEW_CONVERSATION_SCOPE &&
          get().activeSessionId === null &&
          get().newConversationRuntime === state.newConversationRuntime
        )
          await get().openSession(sessionId)
      } catch (error) {
        updateComposer(scope, { error: goalErrorMessage(error) })
        if (sessionId) void get().refreshGoal(sessionId)
      } finally {
        updateComposer(scope, { busy: false })
      }
    },
    async applyGoalAction(sessionId, input) {
      const scope = sessionComposerScope(sessionId)
      const composer = get().goalComposersByScope[scope] ?? emptyGoalComposer
      const goal = get().goalsBySession[sessionId]
      if (!goal || composer.busy) return
      const fingerprint = JSON.stringify({ goalId: goal.id, ...input })
      const pending = composer.request?.fingerprint === fingerprint ? composer.request : undefined
      const requestId = pending?.id ?? crypto.randomUUID()
      const actionInput = pending?.actionInput ?? {
        sessionId,
        goalId: goal.id,
        expectedRevision: goal.revision,
        requestId,
        ...input,
      }
      updateComposer(scope, {
        busy: true,
        error: null,
        request: { fingerprint, id: requestId, actionInput },
      })
      invalidateRead(sessionId)
      let cancelled = false
      try {
        const saved = await window.desktop.sessions.goalAction(actionInput)
        invalidateRead(sessionId)
        saveGoal(sessionId, saved)
        cancelled = saved.status === "cancelled"
        updateComposer(scope, { request: undefined, ...(saved.status === "cancelled" ? { dismissedGoalId: saved.id } : {}) })
      } catch (error) {
        updateComposer(scope, { error: goalErrorMessage(error) })
      } finally {
        updateComposer(scope, { busy: false })
        if (cancelled) get().setGoalMode(scope, false)
        void get().refreshGoal(sessionId)
      }
    },
  }
}
