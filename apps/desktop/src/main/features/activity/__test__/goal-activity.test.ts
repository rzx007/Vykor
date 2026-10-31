import { describe, expect, it, vi } from "vitest"
import {
  createInitialClientState,
  type SessionEventRecord,
  type SessionGoal,
  type SyncEventUpdate,
} from "@vykor/application-client"
import type { DesktopActivityUpdate } from "../../../../shared/activity-types"
import {
  applyActivityUpdate,
  createActivityState,
} from "../../../../renderer/src/stores/desktop-session/activity-state"
import { reduceActivityEvent } from "../activity-reducer"
import { projectScheduledActivity, projectSessionActivity } from "../activity-projection"
import { GlobalActivitySubscriptionService } from "../global-activity-subscription-service"

const session = {
  id: "session",
  cwd: "D:/work",
  title: "Goal task",
  model: "test",
  status: "running" as const,
  metadata: { desktop: { workspaceMode: "outside_project" } },
  createdAt: 1,
  updatedAt: 1,
}
const run = {
  id: "round",
  sessionId: session.id,
  status: "completed" as const,
  metadata: { goalId: "goal", goalObjectiveVersion: 1 },
  createdAt: 3,
  updatedAt: 4,
}
const goal: SessionGoal = {
  id: "goal",
  sessionId: session.id,
  objective: "Finish the work",
  objectiveVersion: 1,
  revision: 0,
  status: "active",
  maxAutoTurns: 0,
  autoTurnsUsed: 0,
  usage: {
    knownTokens: 0,
    incomplete: false,
    unknownAttempts: 0,
    partialAttempts: 0,
    inFlightAttempts: 0,
    runTimeMs: 0,
    seq: 0,
    updatedAt: 2,
  },
  currentRunId: run.id,
  createdAt: 2,
  updatedAt: 4,
}

function projectionState() {
  const state = createInitialClientState()
  state.buckets[session.id] = {
    session,
    inputs: [],
    messages: [],
    partsByMessageId: {},
    tasks: {},
    attempts: {},
    runs: { [run.id]: run },
    permissions: {},
  }
  return state
}

describe("goal activity projection", () => {
  it("keeps a completed round running until its whole goal finishes", () => {
    const state = projectionState()
    expect(projectSessionActivity(state, session.id, 4, goal)).toMatchObject({
      executionState: "running",
    })
    expect(
      projectSessionActivity(state, session.id, 5, { ...goal, status: "completed" })
    ).toMatchObject({ executionState: "completed" })
  })

  it("identifies a goal question without a permission request", () => {
    expect(
      projectSessionActivity(projectionState(), session.id, 5, {
        ...goal,
        status: "waiting_user",
        wait: {
          kind: "user",
          questionId: "choice",
          question: "Which option?",
          objectiveVersion: 1,
        },
      })
    ).toMatchObject({ executionState: "needs_input", attentionId: "goal:goal:question:choice" })
  })

  it.each(["run_error", "external_failed", "wait_invalid", "wait_timeout"] as const)(
    "reports a goal paused by %s as failed",
    (code) => {
      expect(
        projectSessionActivity(projectionState(), session.id, 5, {
          ...goal,
          status: "paused",
          stopReason: { code, at: 5 },
        })
      ).toMatchObject({ executionState: "failed" })
    }
  )

  it.each([
    "auto_turn_limit",
    "no_progress",
    "startup_recovery",
    "token_budget",
    "usage_unknown",
    "provider_limit",
  ] as const)("requests user attention for a goal paused by %s", (code) => {
    expect(
      projectSessionActivity(projectionState(), session.id, 5, {
        ...goal,
        status: "paused",
        stopReason: { code, at: 5 },
      })
    ).toMatchObject({ executionState: "needs_input", attentionId: expect.any(String) })
  })

  it.each(["user_paused", "user_cancelled", "updating_objective"] as const)(
    "does not report a user stop (%s) as completed or failed",
    (code) => {
      expect(
        projectSessionActivity(projectionState(), session.id, 5, {
          ...goal,
          status: "paused",
          stopReason: { code, at: 5 },
        })
      ).toMatchObject({ executionState: "interrupted" })
    }
  )

  it("requests attention for a blocked goal and suppresses a cancelled goal", () => {
    const state = projectionState()
    expect(
      projectSessionActivity(state, session.id, 5, { ...goal, status: "blocked" })
    ).toMatchObject({ executionState: "needs_input", attentionId: expect.any(String) })
    expect(
      projectSessionActivity(state, session.id, 6, { ...goal, status: "cancelled" })
    ).toMatchObject({ executionState: "interrupted" })
  })

  it("does not revive a resolved approval from the goal's stale wait", () => {
    const state = projectionState()
    expect(
      projectSessionActivity(state, session.id, 5, {
        ...goal,
        status: "waiting_user",
        wait: { kind: "approval", permissionRequestId: "answered" },
      })
    ).toMatchObject({ executionState: "running" })
  })

  it("keeps a real permission ahead of goal state", () => {
    const state = projectionState()
    state.buckets[session.id]!.permissions.pending = {
      id: "pending",
      sessionId: session.id,
      toolName: "AskUser",
      payload: {},
      status: "pending",
      createdAt: 5,
      updatedAt: 5,
    }
    expect(
      projectSessionActivity(state, session.id, 5, { ...goal, status: "completed" })
    ).toMatchObject({ executionState: "needs_input", permissionId: "pending" })
  })

  it.each(["failed", "interrupted"] as const)(
    "preserves a real %s round before goal settlement",
    (status) => {
      const state = projectionState()
      state.buckets[session.id]!.runs[run.id] = { ...run, status }
      expect(projectSessionActivity(state, session.id, 5, goal)).toMatchObject({
        executionState: status,
      })
    }
  )

  it("does not let an old goal override a later ordinary run", () => {
    const state = projectionState()
    state.buckets[session.id]!.runs.later = {
      id: "later",
      sessionId: session.id,
      status: "failed",
      metadata: {},
      createdAt: 6,
      updatedAt: 7,
    }
    expect(
      projectSessionActivity(state, session.id, 7, { ...goal, status: "completed" })
    ).toMatchObject({ executionState: "failed", runId: "later" })
  })

  it("takes the scheduled run identity from the current model run", () => {
    const state = projectionState()
    state.buckets[session.id]!.runs[run.id] = { ...run, metadata: { scheduledRunId: "scheduled" } }
    expect(projectSessionActivity(state, session.id, 5)).toMatchObject({
      scheduledRunId: "scheduled",
    })
  })

  it("does not call a skipped scheduled run completed", () => {
    expect(
      projectScheduledActivity(
        {
          id: "scheduled",
          taskId: "task",
          status: "skipped",
          cause: "scheduled",
          scheduledFor: 1,
          unread: true,
          createdAt: 1,
          updatedAt: 2,
        },
        3
      )
    ).toMatchObject({ executionState: "idle" })
  })
})

function goalStream() {
  let state = createInitialClientState()
  let seq = 0
  const values: SyncEventUpdate[] = []
  let waiting: ((value: IteratorResult<SyncEventUpdate>) => void) | undefined
  const enqueue = (value: SyncEventUpdate) => {
    if (waiting) {
      const resolve = waiting
      waiting = undefined
      resolve({ value, done: false })
    } else values.push(value)
  }
  return {
    iterator: {
      next: () =>
        values.length
          ? Promise.resolve({ value: values.shift()!, done: false })
          : new Promise<IteratorResult<SyncEventUpdate>>((resolve) => {
              waiting = resolve
            }),
    },
    event(type: string, payload: Record<string, unknown>, source: "live" | "replay" = "live") {
      const event: SessionEventRecord = {
        id: `event-${++seq}`,
        seq,
        type,
        sessionId: session.id,
        payload,
        schemaVersion: 1,
        createdAt: seq,
      }
      state = reduceActivityEvent(state, event)
      if (type === "session.created") expect(state.buckets[session.id]?.session).toBeDefined()
      enqueue({ event, state, source })
      return seq
    },
    snapshot() {
      enqueue({ state, source: "snapshot" })
    },
  }
}

async function openGoalActivity() {
  const stream = goalStream()
  const updates: DesktopActivityUpdate[] = []
  const service = new GlobalActivitySubscriptionService(() => stream.iterator)
  const webContents = {
    id: 71,
    isDestroyed: () => false,
    once: vi.fn(),
    removeListener: vi.fn(),
    send: (_channel: string, update: DesktopActivityUpdate) => {
      updates.push(update)
    },
  }
  const opened = service.open({} as never, webContents as never)
  stream.event("session.created", { session }, "replay")
  stream.event("session.goal.created", { goal }, "replay")
  stream.event("session.run.created", { run: { ...run, status: "running" } }, "replay")
  stream.snapshot()
  const baseline = await opened
  expect(baseline.sessions).toHaveLength(1)
  return {
    stream,
    service,
    baseline,
    updates,
    async next(type: string, payload: Record<string, unknown>) {
      const cursor = stream.event(type, payload)
      await vi.waitFor(() => expect(updates.some((item) => item.cursor === cursor)).toBe(true))
      return updates.find((item) => item.cursor === cursor)!
    },
  }
}

describe("goal events reach renderer activity", () => {
  it("replays a goal, suppresses round completion, then notifies its question once", async () => {
    const flow = await openGoalActivity()
    try {
      let state = applyActivityUpdate(createActivityState(), flow.baseline, null).state
      const round = await flow.next("session.run.updated", { run })
      expect(round.sessions[0]).toMatchObject({ executionState: "running" })
      const result = applyActivityUpdate(state, round, null)
      expect(result.notifications).toEqual([])
      state = result.state
      const question = {
        ...goal,
        revision: 1,
        currentRunId: undefined,
        status: "waiting_user" as const,
        wait: {
          kind: "user" as const,
          questionId: "choice",
          question: "Which option?",
          objectiveVersion: 1,
        },
      }
      const asked = await flow.next("session.goal.updated", { goal: question })
      expect(asked.sessions[0]).toMatchObject({
        executionState: "needs_input",
        activitySeq: asked.cursor,
        attentionId: "goal:goal:question:choice",
      })
      const waiting = applyActivityUpdate(state, asked, null)
      expect(waiting.notifications).toMatchObject([
        { sessionId: session.id, status: "needs_input" },
      ])
      const repeated = await flow.next("session.goal.updated", {
        goal: { ...question, updatedAt: 9 },
      })
      expect(repeated.sessions[0]!.activitySeq).toBe(asked.cursor)
      expect(applyActivityUpdate(waiting.state, repeated, null).notifications).toEqual([])
    } finally {
      flow.service.clearAll()
    }
  })

  it("notifies only the actual goal completion after its last round", async () => {
    const flow = await openGoalActivity()
    try {
      let state = applyActivityUpdate(createActivityState(), flow.baseline, null).state
      state = applyActivityUpdate(
        state,
        await flow.next("session.run.updated", { run }),
        null
      ).state
      const done = await flow.next("session.goal.updated", {
        goal: { ...goal, status: "completed", currentRunId: undefined, revision: 1 },
      })
      expect(done.sessions[0]!.activitySeq).toBe(done.cursor)
      expect(applyActivityUpdate(state, done, null).notifications).toMatchObject([
        { status: "completed", sessionId: session.id },
      ])
    } finally {
      flow.service.clearAll()
    }
  })

  it("keeps usage progress from changing the question's attention identity", async () => {
    const flow = await openGoalActivity()
    try {
      const question = {
        ...goal,
        status: "waiting_user",
        revision: 1,
        wait: {
          kind: "user",
          questionId: "choice",
          question: "Which option?",
          objectiveVersion: 1,
        },
      }
      const asked = await flow.next("session.goal.updated", { goal: question })
      flow.stream.event("session.goal.usage.updated", {
        goalId: goal.id,
        usage: { ...goal.usage, knownTokens: 100, seq: 1 },
      })
      const barrier = await flow.next("session.updated", { session: { ...session, updatedAt: 10 } })
      expect(barrier.sessions[0]).toMatchObject({
        activitySeq: asked.cursor,
        attentionId: "goal:goal:question:choice",
      })
    } finally {
      flow.service.clearAll()
    }
  })

  it("does not notify a failed round again when goal settlement pauses it", async () => {
    const flow = await openGoalActivity()
    try {
      const state = applyActivityUpdate(createActivityState(), flow.baseline, null).state
      const terminal = await flow.next("session.run.updated", {
        run: { ...run, status: "failed", error: "provider failed" },
      })
      const failure = applyActivityUpdate(state, terminal, null)
      expect(failure.notifications).toMatchObject([{ status: "failed" }])
      const settled = await flow.next("session.goal.updated", {
        goal: {
          ...goal,
          status: "paused",
          currentRunId: undefined,
          revision: 1,
          stopReason: { code: "run_error", at: 5, runId: run.id },
        },
      })
      expect(settled.sessions[0]).toMatchObject({
        executionState: "failed",
        activitySeq: terminal.cursor,
      })
      expect(applyActivityUpdate(failure.state, settled, null).notifications).toEqual([])
    } finally {
      flow.service.clearAll()
    }
  })

  it("notifies a failure when goal settlement explains an interrupted round as a run error", async () => {
    const flow = await openGoalActivity()
    try {
      const initial = applyActivityUpdate(createActivityState(), flow.baseline, null).state
      const terminal = await flow.next("session.run.updated", {
        run: { ...run, status: "interrupted" },
      })
      const interrupted = applyActivityUpdate(initial, terminal, null)
      expect(interrupted.notifications).toEqual([])
      const settled = await flow.next("session.goal.updated", {
        goal: {
          ...goal,
          status: "paused",
          currentRunId: undefined,
          revision: 1,
          stopReason: { code: "run_error", at: 5, runId: run.id },
        },
      })
      expect(settled.sessions[0]).toMatchObject({
        executionState: "failed",
        activitySeq: settled.cursor,
      })
      expect(applyActivityUpdate(interrupted.state, settled, null).notifications).toMatchObject([
        { status: "failed" },
      ])
    } finally {
      flow.service.clearAll()
    }
  })

  it("does not notify when a user pause precedes the round's interruption", async () => {
    const flow = await openGoalActivity()
    try {
      const initial = applyActivityUpdate(createActivityState(), flow.baseline, null).state
      const stopped = await flow.next("session.goal.updated", {
        goal: {
          ...goal,
          status: "paused",
          currentRunId: undefined,
          revision: 1,
          stopReason: { code: "user_paused", at: 4, runId: run.id },
        },
      })
      const paused = applyActivityUpdate(initial, stopped, null)
      expect(stopped.sessions[0]).toMatchObject({ executionState: "interrupted" })
      expect(paused.notifications).toEqual([])
      const terminal = await flow.next("session.run.updated", {
        run: { ...run, status: "interrupted" },
      })
      expect(terminal.sessions[0]).toMatchObject({ executionState: "interrupted" })
      expect(applyActivityUpdate(paused.state, terminal, null).notifications).toEqual([])
    } finally {
      flow.service.clearAll()
    }
  })

  it("notifies a new goal question even when its round and state stay the same", async () => {
    const flow = await openGoalActivity()
    try {
      const initial = applyActivityUpdate(createActivityState(), flow.baseline, null).state
      const question = {
        ...goal,
        status: "waiting_user",
        revision: 1,
        wait: { kind: "user", questionId: "first", question: "First?", objectiveVersion: 1 },
      }
      const first = applyActivityUpdate(
        initial,
        await flow.next("session.goal.updated", { goal: question }),
        null
      )
      expect(first.notifications).toHaveLength(1)
      const second = await flow.next("session.goal.updated", {
        goal: {
          ...question,
          revision: 2,
          wait: { ...question.wait, questionId: "second", question: "Second?" },
        },
      })
      expect(second.sessions[0]).toMatchObject({
        activitySeq: second.cursor,
        attentionId: "goal:goal:question:second",
      })
      const next = applyActivityUpdate(first.state, second, null)
      expect(next.notifications).toHaveLength(1)
      expect(next.notifications[0]!.eventId).not.toBe(first.notifications[0]!.eventId)
    } finally {
      flow.service.clearAll()
    }
  })

  it("does not resurrect approval attention after the reply while a goal still records its wait", async () => {
    const flow = await openGoalActivity()
    try {
      const initial = applyActivityUpdate(createActivityState(), flow.baseline, null).state
      const request = {
        id: "permission",
        sessionId: session.id,
        toolName: "Shell",
        status: "pending",
        payload: {},
        createdAt: 5,
        updatedAt: 5,
      }
      const asked = applyActivityUpdate(
        initial,
        await flow.next("permission.asked", { request }),
        null
      )
      expect(asked.notifications).toHaveLength(1)
      const waiting = applyActivityUpdate(
        asked.state,
        await flow.next("session.goal.updated", {
          goal: {
            ...goal,
            status: "waiting_user",
            revision: 1,
            wait: { kind: "approval", permissionRequestId: request.id },
          },
        }),
        null
      )
      expect(waiting.notifications).toEqual([])
      const replied = await flow.next("permission.replied", {
        request: { ...request, status: "approved", updatedAt: 7 },
      })
      expect(replied.sessions[0]).toMatchObject({ executionState: "running" })
      expect(applyActivityUpdate(waiting.state, replied, null).notifications).toEqual([])
    } finally {
      flow.service.clearAll()
    }
  })

  it.each([
    { code: "token_budget", executionState: "needs_input" },
    { code: "external_failed", executionState: "failed" },
  ] as const)(
    "advances $executionState attention after its permission expires",
    async ({ code, executionState }) => {
      const flow = await openGoalActivity()
      try {
        const initial = applyActivityUpdate(createActivityState(), flow.baseline, null).state
        const request = {
          id: "permission",
          sessionId: session.id,
          toolName: "Shell",
          status: "pending",
          payload: {},
          createdAt: 5,
          updatedAt: 5,
        }
        const asked = applyActivityUpdate(
          initial,
          await flow.next("permission.asked", { request }),
          null
        )
        const paused = applyActivityUpdate(
          asked.state,
          await flow.next("session.goal.updated", {
            goal: {
              ...goal,
              status: "paused",
              revision: 1,
              stopReason: { code, at: 6 },
            },
          }),
          null
        )
        expect(paused.notifications).toEqual([])
        const expired = await flow.next("permission.replied", {
          request: { ...request, status: "expired", updatedAt: 7 },
        })
        expect(expired.sessions[0]).toMatchObject({ executionState, activitySeq: expired.cursor })
        expect(applyActivityUpdate(paused.state, expired, null).notifications).toMatchObject([
          { status: executionState },
        ])
      } finally {
        flow.service.clearAll()
      }
    }
  )

  it("does not attribute a later ordinary run's result to the cached goal", async () => {
    const flow = await openGoalActivity()
    try {
      await flow.next("session.goal.updated", {
        goal: { ...goal, status: "completed", revision: 1 },
      })
      const ordinary = {
        ...run,
        id: "ordinary",
        status: "running",
        metadata: {},
        createdAt: 6,
        updatedAt: 6,
      }
      await flow.next("session.run.created", { run: ordinary })
      const request = {
        id: "ordinary-permission",
        sessionId: session.id,
        toolName: "Shell",
        status: "pending",
        payload: {},
        createdAt: 7,
        updatedAt: 7,
      }
      await flow.next("permission.asked", { request })
      await flow.next("session.run.updated", {
        run: { ...ordinary, status: "failed", updatedAt: 8 },
      })
      const replied = await flow.next("permission.replied", {
        request: { ...request, status: "expired", updatedAt: 9 },
      })
      expect(replied.sessions[0]).toMatchObject({
        executionState: "failed",
        runId: ordinary.id,
        activitySeq: replied.cursor,
      })
    } finally {
      flow.service.clearAll()
    }
  })

  it.each([
    { status: "completed", reply: "approved" },
    { status: "completed", reply: "expired" },
    { status: "failed", reply: "approved" },
    { status: "failed", reply: "expired" },
  ] as const)(
    "reveals an ordinary $status result after a routed child's permission is $reply",
    async ({ status, reply }) => {
      const flow = await openGoalActivity()
      try {
        let state = applyActivityUpdate(createActivityState(), flow.baseline, null).state
        state = applyActivityUpdate(
          state,
          await flow.next("session.goal.updated", {
            goal: { ...goal, status: "completed", revision: 1 },
          }),
          null
        ).state
        const ordinary = {
          ...run,
          id: "ordinary",
          status: "running",
          metadata: {},
          createdAt: 6,
          updatedAt: 6,
        }
        state = applyActivityUpdate(
          state,
          await flow.next("session.run.created", { run: ordinary }),
          null
        ).state
        // The broker routes a child's permission to its root session. The root
        // can finish normally while the child's independent request stays pending.
        const request = {
          id: "child-permission",
          sessionId: session.id,
          toolName: "AskUser",
          status: "pending",
          payload: { childSessionId: "child", childRunId: "child-run" },
          createdAt: 7,
          updatedAt: 7,
        }
        const asked = applyActivityUpdate(
          state,
          await flow.next("permission.asked", { request }),
          null
        )
        expect(asked.notifications).toMatchObject([{ status: "needs_input" }])
        const terminal = await flow.next("session.run.updated", {
          run: { ...ordinary, status, updatedAt: 8 },
        })
        const obscured = applyActivityUpdate(asked.state, terminal, null)
        expect(obscured.notifications).toEqual([])
        expect(obscured.state.sessions[session.id]?.executionState).toBe("needs_input")
        const other = applyActivityUpdate(
          obscured.state,
          await flow.next("scheduled.run.updated", {
            run: {
              id: "other-scheduled",
              taskId: "other-task",
              status: "failed",
              cause: "scheduled",
              scheduledFor: 1,
              unread: true,
              createdAt: 1,
              updatedAt: 9,
            },
          }),
          null
        )
        expect(other.notifications).toMatchObject([{ taskId: "other-task", status: "failed" }])
        expect(other.state.lastNotifiedCursor).toBeGreaterThan(terminal.cursor)

        const replied = await flow.next("permission.replied", {
          request: { ...request, status: reply, updatedAt: 10 },
        })
        const revealed = applyActivityUpdate(other.state, replied, null)
        expect(revealed.notifications).toMatchObject([{ sessionId: session.id, status }])
        expect(replied.sessions[0]?.activitySeq).toBe(replied.cursor)
        expect(replied.sessions[0]?.runId).toBe(ordinary.id)
        const repeated = await flow.next("session.updated", {
          session: { ...session, updatedAt: 11 },
        })
        expect(applyActivityUpdate(revealed.state, repeated, null).notifications).toEqual([])
      } finally {
        flow.service.clearAll()
      }
    }
  )

  it("forgets a deleted session's goal before the id is recreated", async () => {
    const flow = await openGoalActivity()
    try {
      await flow.next("session.deleted", { sessionIds: [session.id] })
      await flow.next("session.created", { session: { ...session, createdAt: 10, updatedAt: 10 } })
      const recreated = await flow.next("session.run.created", {
        run: { ...run, createdAt: 11, updatedAt: 12 },
      })
      expect(recreated.sessions[0]).toMatchObject({ executionState: "completed" })
    } finally {
      flow.service.clearAll()
    }
  })
})
