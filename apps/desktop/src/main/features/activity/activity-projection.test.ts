import { describe, expect, it } from "vitest"
import type { VykorClientState, SessionEventRecord } from "@vykor/client"
import { createInitialClientState } from "@vykor/client"
import { projectSessionActivity, projectScheduledActivity } from "./activity-projection"
import { applyActivityUpdate, createActivityState } from "../../../renderer/src/stores/desktop-session/activity-state"

const session = {
  id: "s1",
  cwd: "D:/work",
  title: "Task",
  model: "test",
  status: "running" as const,
  metadata: {},
  createdAt: 1,
  updatedAt: 2,
}
const event: SessionEventRecord = {
  id: "e1",
  seq: 8,
  type: "permission.asked",
  schemaVersion: 1,
  sessionId: "s1",
  payload: {},
  createdAt: 8,
}

describe("activity projection", () => {
  it.each(["ask_user", "timed_out"])("notifies once only after review hands off to %s", (status) => {
    const state = permissionState({ approvalReview: { status: "reviewing", startedAt: 4 } })
    let activityState = createActivityState()
    const deliver = (seq: number, delivery: "baseline" | "live") => {
      const result = applyActivityUpdate(activityState, {
        cursor: seq, delivery, scheduled: [], sessions: [projectSessionActivity(state, "s1", seq)!],
      }, null)
      activityState = result.state
      return result
    }
    deliver(1, "baseline")
    for (const reviewStatus of ["reviewing", "approved", "denied"]) {
      state.buckets.s1!.permissions.p1!.payload = { approvalReview: { status: reviewStatus } }
      const result = deliver(activityState.cursor + 1, "live")
      expect(result.notifications).toEqual([])
      expect(result.sounds).toEqual([])
    }
    state.buckets.s1!.permissions.p1!.payload = { approvalReview: { status } }
    const handoff = deliver(10, "live")
    expect(handoff.notifications).toMatchObject([{ status: "needs_input", sessionId: "s1" }])
    expect(handoff.notifications).toHaveLength(1)
    expect(handoff.sounds).toHaveLength(1)
    expect(deliver(11, "live").notifications).toEqual([])
  })

  it.each([
    { approvalReview: { status: "reviewing", startedAt: 4 } },
    { approvalReview: { status: "approved", startedAt: 4, completedAt: 5 } },
    { approvalReview: { status: "denied", startedAt: 4, completedAt: 5 } },
    { reusedApprovalRequestId: "previous-approval" },
  ])("does not request human attention for automatic handling: %j", (payload) => {
    const state = permissionState(payload)
    expect(projectSessionActivity(state, "s1", 8)).toMatchObject({ executionState: "running" })
    expect(projectSessionActivity(state, "s1", 8)).not.toHaveProperty("permissionId")
  })

  it.each(["ask_user", "timed_out"])("requests attention when automatic review becomes %s", (status) => {
    const state = permissionState({ approvalReview: { status: "reviewing", startedAt: 4 } })
    expect(projectSessionActivity(state, "s1", 8)?.executionState).toBe("running")
    state.buckets.s1!.permissions.p1!.payload = {
      approvalReview: { status, startedAt: 4, completedAt: 5 },
    }
    expect(projectSessionActivity(state, "s1", 9)).toMatchObject({
      executionState: "needs_input", permissionId: "p1",
    })
  })

  it("does not let a newer automatic request hide a manual request", () => {
    const state = permissionState({})
    state.buckets.s1!.permissions.p2 = {
      ...state.buckets.s1!.permissions.p1!, id: "p2", updatedAt: 10,
      payload: { approvalReview: { status: "reviewing", startedAt: 10 } },
    }
    expect(projectSessionActivity(state, "s1", 10)).toMatchObject({
      executionState: "needs_input", permissionId: "p1",
    })
  })

  it("gives pending permission priority over a running session and sends no transcript", () => {
    const state: VykorClientState = createInitialClientState()
    state.buckets.s1 = {
      session,
      inputs: [],
      messages: [],
      partsByMessageId: {},
      tasks: {},
      attempts: {},
      runs: {
        r1: {
          id: "r1",
          sessionId: "s1",
          status: "running",
          metadata: {},
          createdAt: 2,
          updatedAt: 3,
        },
      },
      permissions: {
        p1: {
          id: "p1",
          sessionId: "s1",
          toolName: "shell",
          payload: {},
          status: "pending",
          createdAt: 4,
          updatedAt: 4,
        },
      },
    }

    expect(projectSessionActivity(state, "s1", 8)).toMatchObject({
      session: { id: "s1" },
      executionState: "needs_input",
      permissionId: "p1",
      activitySeq: 8,
    })
    expect(JSON.stringify(projectSessionActivity(state, "s1", 8))).not.toContain("partsByMessageId")
  })

  it("projects scheduled unread independently from execution state", () => {
    const run = {
      id: "sr1",
      taskId: "task1",
      cause: "manual" as const,
      status: "failed" as const,
      scheduledFor: 1,
      unread: true,
      createdAt: 1,
      updatedAt: 2,
    }
    expect(projectScheduledActivity(run, event.seq)).toMatchObject({
      taskId: "task1",
      executionState: "failed",
      attentionState: "unread",
      activitySeq: 8,
    })
  })
})

function permissionState(payload: Record<string, unknown>): VykorClientState {
  const state = createInitialClientState()
  state.buckets.s1 = {
    session, inputs: [], messages: [], partsByMessageId: {}, tasks: {}, attempts: {},
    runs: { r1: { id: "r1", sessionId: "s1", status: "running", metadata: {}, createdAt: 2, updatedAt: 3 } },
    permissions: { p1: { id: "p1", sessionId: "s1", toolName: "Shell", payload, status: "pending", createdAt: 4, updatedAt: 4 } },
  }
  return state
}
