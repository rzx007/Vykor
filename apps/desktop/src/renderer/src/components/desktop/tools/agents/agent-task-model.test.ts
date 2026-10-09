import { describe, expect, it } from "vitest"

import type {
  DesktopAuxSessionUpdate,
  DesktopSessionTask,
  DesktopSessionView,
} from "@shared/session-types"
import { groupAgentTasks, matchesAgentSessionUpdate } from "./agent-task-model"

function task(
  id: string,
  status: DesktopSessionTask["status"],
  input: Partial<DesktopSessionTask> = {}
): DesktopSessionTask {
  return {
    id,
    sessionId: "parent",
    childSessionId: `session-${id}`,
    type: "agent",
    status,
    description: id,
    cwd: "D:/repo",
    metadata: {},
    createdAt: input.createdAt ?? 1,
    updatedAt: input.updatedAt ?? input.createdAt ?? 1,
    ...input,
  }
}

describe("groupAgentTasks", () => {
  it("keeps only child-agent tasks and separates active from terminal work", () => {
    const groups = groupAgentTasks([
      task("running", "running", { createdAt: 2 }),
      task("completed", "completed", { createdAt: 4 }),
      task("failed", "failed", { createdAt: 3 }),
      task("without-child", "running", { childSessionId: undefined, createdAt: 8 }),
      task("shell", "completed", { type: "shell", createdAt: 9 }),
    ])

    expect(groups.active.map((item) => item.id)).toEqual(["running"])
    expect(groups.completed.map((item) => item.id)).toEqual(["completed", "failed"])
  })

  it("shows the most recently created task first within each group", () => {
    const groups = groupAgentTasks([
      task("older-active", "pending", { createdAt: 1 }),
      task("newer-active", "running", { createdAt: 5 }),
      task("older-done", "interrupted", { createdAt: 2 }),
      task("newer-done", "stopped", { createdAt: 6 }),
    ])

    expect(groups.active.map((item) => item.id)).toEqual(["newer-active", "older-active"])
    expect(groups.completed.map((item) => item.id)).toEqual(["newer-done", "older-done"])
  })
})

describe("matchesAgentSessionUpdate", () => {
  function update(subscriptionId: string, sessionId: string): DesktopAuxSessionUpdate {
    return {
      subscriptionId,
      update: {
        kind: "snapshot",
        subscriptionId,
        generation: 1,
        deliveryId: "delivery-1",
        view: { session: { id: sessionId } } as DesktopSessionView,
      },
    }
  }

  it("rejects a late update from the previously selected child session", () => {
    expect(
      matchesAgentSessionUpdate(
        "agents:details",
        "child-new",
        update("agents:details", "child-old")
      )
    ).toBe(false)
  })

  it("accepts only the expected auxiliary subscription and child session", () => {
    expect(matchesAgentSessionUpdate("agents:details", "child", update("other", "child"))).toBe(
      false
    )
    expect(
      matchesAgentSessionUpdate("agents:details", "child", update("agents:details", "child"))
    ).toBe(true)
  })

  it("matches a delta using its session ID", () => {
    const snapshot = update("agents:details", "child")
    const delta: DesktopAuxSessionUpdate = {
      subscriptionId: "agents:details",
      update: {
        kind: "part-delta",
        subscriptionId: "agents:details",
        generation: 2,
        deliveryId: "delivery-2",
        sessionId: "child",
        deltas: [],
      },
    }
    expect(matchesAgentSessionUpdate("agents:details", "child", delta)).toBe(true)
    expect(matchesAgentSessionUpdate("agents:details", "other", delta)).toBe(false)
    expect(matchesAgentSessionUpdate("agents:details", "child", snapshot)).toBe(true)
  })
})
