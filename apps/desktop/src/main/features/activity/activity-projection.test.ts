import { describe, expect, it } from "vitest"
import type { OpenHarnessClientState, SessionEventRecord } from "@openharness/client"
import { createInitialClientState } from "@openharness/client"
import { projectSessionActivity, projectScheduledActivity } from "./activity-projection"

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
  it("gives pending permission priority over a running session and sends no transcript", () => {
    const state: OpenHarnessClientState = createInitialClientState()
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
