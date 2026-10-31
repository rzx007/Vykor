import { describe, expect, it } from "vitest"
import type {
  DesktopActivityUpdate,
  DesktopScheduledActivity,
  DesktopSessionActivity,
} from "@shared/activity-types"
import { applyActivityUpdate, createActivityState } from "../activity-state"

function session(
  status: DesktopSessionActivity["executionState"],
  seq: number,
  options: {
    parentId?: string
    standalone?: boolean
    scheduledRunId?: string
    permissionId?: string
    attentionId?: string
  } = {}
): DesktopSessionActivity {
  return {
    session: {
      id: "conversation",
      cwd: "/workspace",
      title: "Task",
      model: "offline",
      status: "running",
      ...(options.parentId ? { parentId: options.parentId } : {}),
      metadata: options.standalone
        ? { scheduledTask: { taskId: "task", scheduledRunId: "scheduled-run" } }
        : {},
      createdAt: 1,
      updatedAt: seq,
    },
    executionState: status,
    activitySeq: seq,
    attentionState: "read",
    updatedAt: seq,
    runId: "model-run",
    ...(options.scheduledRunId ? { scheduledRunId: options.scheduledRunId } : {}),
    ...(options.permissionId ? { permissionId: options.permissionId } : {}),
    ...(options.attentionId ? { attentionId: options.attentionId } : {}),
  }
}

function scheduled(
  status: DesktopScheduledActivity["executionState"],
  seq: number
): DesktopScheduledActivity {
  return {
    taskId: "task",
    executionState: status,
    attentionState: "unread",
    activitySeq: seq,
    updatedAt: seq,
    run: {
      id: "scheduled-run",
      taskId: "task",
      sessionId: "conversation",
      runId: "model-run",
      cause: "scheduled",
      status:
        status === "completed"
          ? "succeeded"
          : status === "needs_input"
            ? "needs_attention"
            : status === "failed"
              ? "failed"
              : "running",
      scheduledFor: 1,
      unread: status !== "running",
      createdAt: 1,
      updatedAt: seq,
    },
  }
}

function update(
  cursor: number,
  sessions: DesktopSessionActivity[] = [],
  scheduled: DesktopScheduledActivity[] = []
): DesktopActivityUpdate {
  return { cursor, delivery: "live", sessions, scheduled }
}

describe("actionable task notifications and original conversation routing", () => {
  it.each(["completed", "failed", "needs_input"] as const)(
    "keeps the associated conversation on a scheduled %s notice",
    (status) => {
      const baseline = applyActivityUpdate(
        createActivityState(),
        {
          ...update(1, [], [scheduled("running", 1)]),
          delivery: "baseline",
        },
        null
      ).state
      const result = applyActivityUpdate(baseline, update(2, [], [scheduled(status, 2)]), null)
      expect(result.notifications).toMatchObject([
        { sessionId: "conversation", taskId: "task", status },
      ])
    }
  )

  it.each([{ parentId: "parent" }, { standalone: true }])(
    "does not hide a concrete request for user input: %j",
    (options) => {
      const baseline = applyActivityUpdate(
        createActivityState(),
        {
          ...update(1, [session("running", 1, options)]),
          delivery: "baseline",
        },
        null
      ).state
      const result = applyActivityUpdate(
        baseline,
        update(2, [session("needs_input", 2, { ...options, permissionId: "question" })]),
        null
      )
      expect(result.notifications).toMatchObject([
        { sessionId: "conversation", status: "needs_input" },
      ])
    }
  )

  it.each(["completed", "failed"] as const)(
    "announces a later ordinary %s run inside an old standalone scheduled conversation",
    (status) => {
      const baseline = applyActivityUpdate(
        createActivityState(),
        { ...update(1, [session("running", 1, { standalone: true })]), delivery: "baseline" },
        null
      ).state
      const result = applyActivityUpdate(
        baseline,
        update(2, [session(status, 2, { standalone: true })]),
        null
      )
      expect(result.notifications).toMatchObject([{ sessionId: "conversation", status }])
    }
  )

  it.each(["completed", "failed"] as const)(
    "only announces a scheduled chat %s once, from its scheduler",
    (status) => {
      const baseline = applyActivityUpdate(
        createActivityState(),
        {
          ...update(
            1,
            [session("running", 1, { scheduledRunId: "scheduled-run" })],
            [scheduled("running", 1)]
          ),
          delivery: "baseline",
        },
        null
      ).state
      const model = applyActivityUpdate(
        baseline,
        update(2, [session(status, 2, { scheduledRunId: "scheduled-run" })]),
        null
      )
      expect(model.notifications).toEqual([])
      const scheduler = applyActivityUpdate(
        model.state,
        update(3, [], [scheduled(status, 3)]),
        null
      )
      expect(scheduler.notifications).toMatchObject([{ sessionId: "conversation", status }])
      expect(scheduler.notifications).toHaveLength(1)
    }
  )

  it("announces each distinct goal question without repeating the same unresolved question", () => {
    const baseline = applyActivityUpdate(
      createActivityState(),
      {
        ...update(1, [session("running", 1)]),
        delivery: "baseline",
      },
      "conversation"
    ).state
    const first = applyActivityUpdate(
      baseline,
      update(2, [session("needs_input", 2, { attentionId: "goal:g:question:q1" })]),
      "conversation"
    )
    expect(first.notifications).toHaveLength(1)
    const repeated = applyActivityUpdate(
      first.state,
      update(3, [session("needs_input", 3, { attentionId: "goal:g:question:q1" })]),
      "conversation"
    )
    expect(repeated.notifications).toEqual([])
    const second = applyActivityUpdate(
      repeated.state,
      update(4, [session("needs_input", 4, { attentionId: "goal:g:question:q2" })]),
      "conversation"
    )
    expect(second.notifications).toHaveLength(1)
    expect(second.notifications[0].eventId).not.toBe(first.notifications[0].eventId)
  })
})
