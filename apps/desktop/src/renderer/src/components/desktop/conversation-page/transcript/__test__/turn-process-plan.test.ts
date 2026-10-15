import { describe, expect, it } from "vitest"
import type { DesktopSessionPart, DesktopSessionTask } from "@shared/session-types"
import type { TurnBlockPlanItem } from "../turn-block-plan"
import { splitTurnProcess } from "../turn-process-plan"

function part(id: string, type: DesktopSessionPart["type"], phase?: string): DesktopSessionPart {
  return {
    id,
    type,
    sessionId: "s",
    messageId: "m",
    seq: 1,
    status: "completed",
    text: id,
    metadata: phase ? { phase } : {},
    createdAt: 1,
    updatedAt: 1,
  } as DesktopSessionPart
}
const progress = part("progress", "text", "commentary")
const answer = part("answer", "text", "final_answer")
function item(parts: DesktopSessionPart[], key = "block"): TurnBlockPlanItem {
  return { key, messageId: key, kind: "assistant", parts, streaming: false, showActions: true }
}

describe("turn process plan", () => {
  const agent = {
    ...part("agent", "tool"),
    toolName: "Agent",
    output: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            kind: "job",
            jobKind: "agent",
            action: "created",
            jobId: "child-task",
          }),
        },
      ],
    },
  }
  const task: DesktopSessionTask = {
    id: "child-task",
    sessionId: "s",
    type: "agent",
    status: "completed",
    description: "Research",
    cwd: "/repo",
    metadata: {},
    createdAt: 1,
    updatedAt: 2,
  }
  it.each(["completed", "failed", "interrupted", "stopped"] as const)(
    "folds a settled agent task (%s) as ordinary process history",
    (status) => {
      const split = splitTurnProcess([item([progress, agent, answer])], [{ ...task, status }])!
      expect(split).not.toBeNull()
      expect(split.process[0].parts).toEqual([progress, agent])
      expect(split.answer[0].parts).toEqual([answer])
    }
  )
  it.each(["running", "pending"] as const)("keeps an active agent task visible (%s)", (status) => {
    expect(splitTurnProcess([item([progress, agent, answer])], [{ ...task, status }])).toBeNull()
  })
  it("does not infer child completion from the settled dispatch tool", () => {
    expect(splitTurnProcess([item([progress, agent, answer])])).toBeNull()
    expect(
      splitTurnProcess([item([progress, agent, answer])], [{ ...task, id: "unrelated" }])
    ).toBeNull()
  })
  it("splits an ordered prefix and keeps the original answer identity and summary source", () => {
    const tool = part("tool", "tool")
    const result = part("result", "tool_result")
    const parts = [progress, tool, result, answer]
    const split = splitTurnProcess([item(parts)])!
    expect(split.process[0].parts).toEqual([progress, tool, result])
    expect(split.process[0].showActions).toBe(false)
    expect(split.process[0].messageId).not.toBe(split.answer[0].messageId)
    expect(split.answer[0]).toMatchObject({ key: "block", parts: [answer], summaryParts: parts })
    expect(parts).toEqual([progress, tool, result, answer])
  })
  it("preserves compaction dividers between process blocks", () => {
    const divider: TurnBlockPlanItem = {
      ...item([], "divider"),
      kind: "divider",
      phase: "completed",
    }
    const split = splitTurnProcess([item([progress], "p"), divider, item([answer], "a")])!
    expect(split.process.map((block) => block.kind)).toEqual(["assistant", "divider"])
    expect(split.answer[0].key).toBe("a")
    expect(split.answer[0].summaryParts).toEqual([progress, answer])
  })
  it.each([
    [answer],
    [progress],
    [part("old", "text"), answer],
    [progress, answer, part("later", "text", "commentary")],
    [progress, { ...part("waiting", "tool"), status: "running" }, answer],
    [progress, { ...part("interactive", "tool"), metadata: { pluginUi: {} } }, answer],
    [progress, part("image", "attachment"), answer],
  ] as DesktopSessionPart[][])("keeps an ambiguous or unsafe sequence visible (%#)", (...parts) => {
    expect(splitTurnProcess([item(parts)])).toBeNull()
  })
  it.each([
    { ...part("bad", "tool"), status: "failed", isError: true },
    {
      ...part("unknown", "tool"),
      status: "failed",
      metadata: { executionState: "unknown", failureKind: "unknown_outcome" },
      output: { isError: true },
    },
    { ...part("interrupted", "tool"), status: "interrupted" },
    part("error", "error"),
  ] as DesktopSessionPart[])(
    "folds settled tool errors as ordinary process history (%#)",
    (tool) => {
      const split = splitTurnProcess([item([progress, tool, answer])])!
      expect(split).not.toBeNull()
      expect(split.process[0].parts).toEqual([progress, tool])
      expect(split.answer[0].parts).toEqual([answer])
    }
  )
})
