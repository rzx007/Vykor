import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SessionStore } from "../store.js"

describe("SessionStore goals", () => {
  it("persists plugin selection across revisions and database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-goal-plugin-"))
    const path = join(directory, "store.db")
    let store = new SessionStore({ path })
    try {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" })
      const goal = store.createGoal({ sessionId: "s1", objective: "review", maxAutoTurns: 2, pluginId: "quality" })
      expect(goal).toMatchObject({ pluginId: "quality" })
      expect(store.updateGoal(goal.id, { expectedRevision: 0, objective: "review again" })).toMatchObject({ pluginId: "quality" })
      store.updateGoal(goal.id, { expectedRevision: 1, pluginId: "research", status: "paused" })
      store.close()
      store = new SessionStore({ path })
      expect(store.getGoal(goal.id)).toMatchObject({ revision: 2, pluginId: "research", status: "paused" })
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
  })
  it("counts a started automatic run once and preserves waiting/blocked goals during restart recovery", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-goal-recovery-"))
    const store = new SessionStore({ path: join(directory, "store.db") })
    try {
      for (const id of ["active", "waiting", "blocked"]) store.createSession({ id, cwd: process.cwd(), model: "m" })
      const active = store.createGoal({ sessionId: "active", objective: "run", maxAutoTurns: 2 })
      const waiting = store.createGoal({ sessionId: "waiting", objective: "wait", maxAutoTurns: 2 })
      const blocked = store.createGoal({ sessionId: "blocked", objective: "blocked", maxAutoTurns: 2 })
      const run = store.createRun({ sessionId: "active", metadata: { goalId: active.id, goalRevision: 0, goalRunKind: "continuation" } })
      expect(store.startGoalRun(active.id, 0, run.id, true)).toBe(true)
      expect(store.startGoalRun(active.id, 0, run.id, true)).toBe(true)
      expect(store.getGoal(active.id)?.autoTurnsUsed).toBe(1)
      store.updateGoal(waiting.id, { expectedRevision: 0, status: "waiting_user", wait: { kind: "user", questionId: "q1", question: "哪个选项？" } })
      store.updateGoal(blocked.id, { expectedRevision: 0, status: "blocked", reason: "缺少配置" })
      store.interruptActiveRuns("restart")
      expect(store.pauseActiveGoalsOnStartup()).toBe(1)
      expect(store.getGoal(active.id)).toMatchObject({ status: "paused", autoTurnsUsed: 1 })
      expect(store.getGoal(active.id)?.currentRunId).toBeUndefined()
      expect(store.getGoal(waiting.id)).toMatchObject({ status: "waiting_user", revision: 1, wait: { questionId: "q1" } })
      expect(store.getGoal(blocked.id)).toMatchObject({ status: "blocked", revision: 1, reason: "缺少配置" })
      expect(store.startGoalRun(active.id, 0, run.id, true)).toBe(false)
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it("commits a continuation with its input/run identities and rolls back a duplicated intent", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-goal-intent-"))
    const path = join(directory, "store.db")
    let store = new SessionStore({ path })
    try {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" })
      const goal = store.createGoal({ sessionId: "s1", objective: "continue", maxAutoTurns: 2 })
      const persist = (id: string) => store.transaction(() => {
        const admitted = store.admitPromptWithRun({ prompt: { id, sessionId: "s1", delivery: "queue", items: [{ type: "text", text: "continue" }] }, run: { metadata: { goalId: goal.id, goalRevision: 0 } } })
        const inserted = store.recordGoalContinuation({ goalId: goal.id, revision: 0, previousRunId: "previous", inputId: admitted.input.id, runId: admitted.run.id })
        if (!inserted) throw new Error("duplicate intent")
        return admitted.run.id
      })
      const runId = persist("first")
      expect(() => persist("duplicate")).toThrow("duplicate intent")
      expect(store.getInput("duplicate")).toBeUndefined()
      expect(store.listRuns("s1")).toHaveLength(1)
      store.close()
      store = new SessionStore({ path })
      expect(store.findRunByInput("first")?.id).toBe(runId)
      expect(store.recordGoalContinuation({ goalId: goal.id, revision: 0, previousRunId: "previous", inputId: "first", runId })).toBe(false)
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it("persists one open goal and protects revisions", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-goal-"))
    const path = join(directory, "store.db")
    const store = new SessionStore({ path })
    try {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" })
      const goal = store.createGoal({ sessionId: "s1", objective: "完成目标功能", maxAutoTurns: 20 })
      const request = store.beginGoalRequest({ requestId: "request-1", sessionId: "s1", fingerprint: "same" })
      expect(store.beginGoalRequest({ requestId: "request-1", sessionId: "s1", fingerprint: "same" })).toEqual(request)
      expect(() => store.beginGoalRequest({ requestId: "request-1", sessionId: "s1", fingerprint: "different" })).toThrowError("session_goal_request_conflict")
      store.settleGoalRequest("request-1", { status: "completed", goalId: goal.id, result: { goalId: goal.id } })
      expect(store.getCurrentGoal("s1")).toMatchObject({ id: goal.id, status: "active", revision: 0 })
      expect(() => store.createGoal({ sessionId: "s1", objective: "重复目标", maxAutoTurns: 20 })).toThrow()
      const paused = store.updateGoal(goal.id, { expectedRevision: 0, status: "paused" })
      expect(paused).toMatchObject({ status: "paused", revision: 1 })
      expect(() => store.updateGoal(goal.id, { expectedRevision: 0, status: "active" })).toThrowError("session_goal_revision_conflict")
      store.close()
      const reloaded = new SessionStore({ path })
      expect(reloaded.getGoal(goal.id)).toMatchObject({ status: "paused", revision: 1 })
      reloaded.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
