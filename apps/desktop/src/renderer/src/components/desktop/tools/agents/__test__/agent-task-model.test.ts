import { describe, expect, it } from "vitest"

import type {
  DesktopAuxSessionUpdate,
  DesktopSessionTask,
  DesktopSessionView,
} from "@shared/session-types"
import { agentTaskPresentation, groupAgentTasks, matchesAgentSessionUpdate } from "../agent-task-model"

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

describe("agentTaskPresentation", () => {
  const report = { version: 1, childSessionId: "session-A", runId: "run-A", source: "limit_finalization", text: "build passed; runtime pending", truncated: false }
  const failed = (failureKind: string, partialResult: unknown = report) => task("A", "failed", { runId: "run-A", metadata: { childFailure: { failureKind, partialResult } } })
  it.each([
    ["max_turns", "未完成 · 已达轮次上限", "warning"],
    ["timeout", "未完成 · 已达时间上限", "warning"],
    ["tool_error", "执行出错", "error"],
    ["unknown", "执行出错", "error"],
  ])("presents %s without treating report content as the outcome", (kind, label, tone) => {
    expect(agentTaskPresentation(failed(kind))).toMatchObject({ label, tone, hasPartialReport: true })
  })
  it.each([null, [], "PARTIAL", { ...report, version: 2 }, { ...report, runId: "old" }, { ...report, childSessionId: "other" }, { ...report, source: "unknown" }, { ...report, text: " " }, { ...report, truncated: "false" }])("rejects malformed or mismatched partial reports: %j", value => {
    const presentation = agentTaskPresentation(failed("max_turns", value))
    expect(presentation.label).toBe("未完成 · 已达轮次上限")
    expect(presentation.hasPartialReport).toBe(false)
    expect(presentation.reason).not.toContain("已保留")
  })
  it.each(["pending", "running", "completed", "stopped", "interrupted"] as const)("does not let old budget data override %s", status => {
    const presentation = agentTaskPresentation({ ...failed("max_turns"), status })
    expect(presentation.label).not.toContain("上限")
    if (status !== "interrupted") expect(presentation.hasPartialReport).toBe(false)
  })
  it.each([null, [], "max_turns", { failureKind: "unrecognized", partialResult: report }])("falls back safely for unknown failure metadata: %j", childFailure => {
    const presentation = agentTaskPresentation(task("A", "failed", { runId: "run-A", error: "PASS".repeat(1000), metadata: { childFailure } }))
    expect(presentation.label).toBe("执行出错")
    expect(presentation.reason!.length).toBeLessThan(100)
  })
})
