import { describe, expect, it } from "vitest"
import type {
  DesktopActivityUpdate,
  DesktopSessionActivity,
  DesktopScheduledActivity,
} from "@shared/activity-types"
import {
  applyActivityUpdate,
  createActivityState,
  forgetSessionActivity,
  markSessionRead,
  type ActivityState,
} from "./activity-state"

const session = (
  id: string,
  executionState: DesktopSessionActivity["executionState"],
  seq: number
): DesktopSessionActivity => ({
  session: {
    id,
    cwd: "/repo",
    title: id,
    model: "test",
    status: "idle",
    metadata: {},
    createdAt: 1,
    updatedAt: seq,
  },
  executionState,
  attentionState: "read",
  activitySeq: seq,
  updatedAt: seq,
})
const update = (
  cursor: number,
  delivery: DesktopActivityUpdate["delivery"],
  sessions: DesktopSessionActivity[] = [],
  scheduled: DesktopScheduledActivity[] = []
): DesktopActivityUpdate => ({ cursor, delivery, sessions, scheduled })

describe("Activity state", () => {
  it("marks a background completion unread while keeping execution state separate", () => {
    const baseline = applyActivityUpdate(
      createActivityState(),
      update(1, "baseline", [session("other", "running", 1)]),
      null
    ).state
    const result = applyActivityUpdate(
      baseline,
      update(2, "live", [session("other", "completed", 2)]),
      "current"
    )
    expect(result.state.sessions.other).toMatchObject({
      executionState: "completed",
      attentionState: "unread",
    })
    expect(result.notifications).toHaveLength(1)
  })

  it("keeps the current conversation read and does not notify, including always mode", () => {
    const initial = applyActivityUpdate(
      createActivityState(),
      update(1, "baseline", [session("current", "running", 1)]),
      "current"
    ).state
    const result = applyActivityUpdate(
      initial,
      update(2, "live", [session("current", "failed", 2)]),
      "current"
    )
    expect(result.state.sessions.current.attentionState).toBe("read")
    expect(result.notifications).toHaveLength(0)
  })

  it("shows a new pending permission above a running run", () => {
    const initial = applyActivityUpdate(
      createActivityState(),
      update(1, "baseline", [session("other", "running", 1)]),
      null
    ).state
    const result = applyActivityUpdate(
      initial,
      update(2, "live", [{ ...session("other", "needs_input", 2), permissionId: "p" }]),
      null
    )
    expect(result.state.sessions.other).toMatchObject({
      executionState: "needs_input",
      attentionState: "unread",
    })
    expect(result.notifications).toHaveLength(1)
  })

  it("opening one conversation advances only its read watermark", () => {
    const initial = applyActivityUpdate(
      createActivityState(),
      update(2, "baseline", [session("a", "completed", 1), session("b", "failed", 2)]),
      null
    ).state
    const withUnread: ActivityState = {
      ...initial,
      sessions: {
        a: { ...initial.sessions.a!, attentionState: "unread" },
        b: { ...initial.sessions.b!, attentionState: "unread" },
      },
    }
    const result = markSessionRead(withUnread, "a")
    expect(result.sessions.a.attentionState).toBe("read")
    expect(result.sessions.b.attentionState).toBe("unread")
    expect(result.readSeqBySessionId.a).toBe(1)
  })

  it("does not notify on initial baseline or gap replay and ignores a repeated seq", () => {
    const baseline = applyActivityUpdate(
      createActivityState(),
      update(2, "baseline", [session("a", "failed", 2)]),
      null
    )
    expect(baseline.notifications).toHaveLength(0)
    expect(baseline.state.sessions.a.attentionState).toBe("read")
    const catchup = applyActivityUpdate(
      baseline.state,
      update(3, "catchup", [session("a", "completed", 3)]),
      null
    )
    expect(catchup.state.sessions.a.attentionState).toBe("unread")
    expect(catchup.notifications).toHaveLength(0)
    expect(
      applyActivityUpdate(catchup.state, update(3, "live", [session("a", "completed", 3)]), null)
        .notifications
    ).toHaveLength(0)
  })

  it("keeps server unread authoritative for each scheduled run", () => {
    const run = (taskId: string, id: string, unread: boolean): DesktopScheduledActivity => ({
      taskId,
      activitySeq: 2,
      updatedAt: 2,
      executionState: "failed",
      attentionState: unread ? "unread" : "read",
      run: {
        id,
        taskId,
        status: "failed",
        cause: "scheduled",
        scheduledFor: 1,
        unread,
        createdAt: 1,
        updatedAt: 2,
      },
    })
    const initial = applyActivityUpdate(
      createActivityState(),
      update(2, "baseline", [], [run("a", "r1", true), run("b", "r2", true)]),
      null
    ).state
    const result = applyActivityUpdate(
      initial,
      update(3, "live", [], [{ ...run("a", "r1", false), activitySeq: 3 }]),
      null
    )
    expect(
      Object.values(result.state.scheduledRuns)
        .filter((item) => item.attentionState === "unread")
        .map((item) => item.taskId)
    ).toEqual(["b"])
  })

  it("removes a deleted task's unread and running projections", () => {
    const run: DesktopScheduledActivity = {
      taskId: "task",
      activitySeq: 1,
      updatedAt: 1,
      executionState: "running",
      attentionState: "unread",
      run: {
        id: "run",
        taskId: "task",
        cause: "scheduled",
        status: "running",
        scheduledFor: 1,
        unread: true,
        createdAt: 1,
        updatedAt: 1,
      },
    }
    const baseline = applyActivityUpdate(
      createActivityState(),
      update(1, "baseline", [], [run]),
      null
    ).state
    const deleted = applyActivityUpdate(
      baseline,
      { ...update(2, "live"), removedTaskId: "task" },
      null
    )
    expect(deleted.state.scheduledRuns).toEqual({})
    expect(deleted.notifications).toHaveLength(0)
  })

  it("does not restore a deleted run from a late initial baseline", () => {
    const run: DesktopScheduledActivity = {
      taskId: "task",
      activitySeq: 1,
      updatedAt: 1,
      executionState: "completed",
      attentionState: "unread",
      run: {
        id: "run",
        taskId: "task",
        cause: "scheduled",
        status: "succeeded",
        scheduledFor: 1,
        unread: true,
        createdAt: 1,
        updatedAt: 1,
      },
    }
    const deleted = applyActivityUpdate(
      createActivityState(),
      { ...update(2, "live"), removedTaskId: "task" },
      null
    ).state
    const lateBaseline = applyActivityUpdate(deleted, update(1, "baseline", [], [run]), null).state
    expect(lateBaseline.scheduledRuns).toEqual({})
  })

  it("preserves an existing unread result across a renderer baseline", () => {
    const baseline = applyActivityUpdate(
      createActivityState(),
      update(1, "baseline", [session("other", "running", 1)]),
      null
    ).state
    const unread = applyActivityUpdate(
      baseline,
      update(2, "live", [session("other", "completed", 2)]),
      null
    ).state
    const remounted = applyActivityUpdate(
      unread,
      update(2, "baseline", [session("other", "completed", 2)]),
      null
    ).state
    expect(remounted.sessions.other.attentionState).toBe("unread")
  })

  it("does not issue a second conversation notification for a scheduled run", () => {
    const scheduledSession = {
      ...session("scheduled", "completed", 2),
      session: {
        ...session("scheduled", "completed", 2).session,
        metadata: { scheduledTask: { taskId: "task", scheduledRunId: "run" } },
      },
    }
    const initial = applyActivityUpdate(
      createActivityState(),
      update(1, "baseline", [session("scheduled", "running", 1)]),
      null
    ).state
    expect(
      applyActivityUpdate(initial, update(2, "live", [scheduledSession]), null).notifications
    ).toHaveLength(0)
  })

  it("ignores a stale async baseline after a newer live delta", () => {
    const baseline = applyActivityUpdate(
      createActivityState(),
      update(1, "baseline", [session("other", "running", 1)]),
      null
    ).state
    const live = applyActivityUpdate(
      baseline,
      update(2, "live", [session("other", "completed", 2)]),
      null
    ).state
    const stale = applyActivityUpdate(
      live,
      update(1, "baseline", [session("other", "running", 1)]),
      null
    ).state
    expect(stale.sessions.other).toMatchObject({
      executionState: "completed",
      attentionState: "unread",
    })
  })

  it("does not lose a live result that arrives before the first baseline Promise", () => {
    const live = applyActivityUpdate(
      createActivityState(),
      update(2, "live", [session("other", "completed", 2)]),
      null
    ).state
    const stale = applyActivityUpdate(
      live,
      update(1, "baseline", [session("other", "running", 1)]),
      null
    ).state
    expect(stale.sessions.other.executionState).toBe("completed")
  })

  it("fills missing historical entries when the first baseline arrives after live", () => {
    const live = applyActivityUpdate(
      createActivityState(),
      update(11, "live", [session("a", "completed", 11)]),
      null
    ).state
    const baseline = applyActivityUpdate(
      live,
      update(10, "baseline", [session("a", "running", 1), session("b", "completed", 2)]),
      null
    ).state
    expect(baseline.cursor).toBe(11)
    expect(baseline.initialized).toBe(true)
    expect(baseline.sessions.a.executionState).toBe("completed")
    expect(baseline.sessions.b).toMatchObject({
      executionState: "completed",
      attentionState: "read",
    })
  })

  it("keeps an unviewed result unread while the next run starts", () => {
    const baseline = applyActivityUpdate(
      createActivityState(),
      update(1, "baseline", [session("a", "running", 1)]),
      null
    ).state
    const completed = applyActivityUpdate(
      baseline,
      update(2, "live", [session("a", "completed", 2)]),
      null
    ).state
    const running = applyActivityUpdate(
      completed,
      update(3, "live", [session("a", "running", 2)]),
      null
    ).state
    expect(running.sessions.a).toMatchObject({
      executionState: "running",
      attentionState: "unread",
    })
  })

  it("keeps a result unread after unrelated global events and restart", () => {
    const restored = createActivityState({
      lastObservedCursor: 10,
      readSeqBySessionId: { other: 1 },
    })
    const result = applyActivityUpdate(
      restored,
      update(10, "baseline", [session("other", "completed", 2)]),
      null
    )
    expect(result.state.sessions.other.attentionState).toBe("unread")
  })

  it("retains a completed result even when a newer run is already running at restart", () => {
    const restored = createActivityState({
      lastObservedCursor: 1,
      readSeqBySessionId: { other: 1 },
    })
    const result = applyActivityUpdate(
      restored,
      update(3, "baseline", [session("other", "running", 2)]),
      null
    )
    expect(result.state.sessions.other).toMatchObject({
      executionState: "running",
      attentionState: "unread",
    })
  })

  it("forgets a deleted conversation and its persistent read watermark", () => {
    const state = createActivityState({ readSeqBySessionId: { deleted: 8, kept: 2 } })
    state.sessions.deleted = session("deleted", "completed", 8)
    state.sessions.kept = session("kept", "running", 2)
    const result = forgetSessionActivity(state, new Set(["deleted"]))
    expect(result.sessions.deleted).toBeUndefined()
    expect(result.readSeqBySessionId).toEqual({ kept: 2 })
  })

  it("does not revive a deleted conversation from a late baseline", () => {
    const removed = applyActivityUpdate(
      createActivityState(),
      {
        ...update(2, "live"),
        removedSessionIds: ["gone"],
      },
      null
    ).state
    const stale = applyActivityUpdate(
      removed,
      update(1, "baseline", [session("gone", "completed", 1)]),
      null
    ).state
    expect(stale.sessions.gone).toBeUndefined()
  })
})
