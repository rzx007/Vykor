import { describe, expect, it } from "vitest"

import type { ConversationTurn } from "../../message/conversation-turn-model"
import { planTurnBlocks } from "../turn-block-plan"

describe("turn block plan", () => {
  it("streams and shows actions only on the last assistant block", () => {
    const turn = turnWithBlocks([
      { kind: "divider", message: message("d-1", 2), parts: [], phase: "completed" },
      { kind: "assistant", messages: [message("a-1", 4)], parts: [] },
      { kind: "divider", message: message("d-2", 5), parts: [], phase: "completed" },
      { kind: "assistant", messages: [message("a-2", 6)], parts: [] },
    ])
    const plan = planTurnBlocks(turn, { streaming: true })

    expect(plan.map((item) => item.kind)).toEqual([
      "divider",
      "assistant",
      "divider",
      "assistant",
    ])
    expect(plan[0]).toMatchObject({ kind: "divider", streaming: false, showActions: false })
    expect(plan[1]).toMatchObject({ kind: "assistant", streaming: false, showActions: false })
    expect(plan[3]).toMatchObject({ kind: "assistant", streaming: true, showActions: false })
  })

  it("shows actions only on the last assistant block when the turn is finished", () => {
    const turn = turnWithBlocks([
      { kind: "assistant", messages: [message("a-1", 2)], parts: [] },
      { kind: "divider", message: message("d-1", 3), parts: [], phase: "completed" },
      { kind: "assistant", messages: [message("a-2", 4)], parts: [] },
    ])
    const plan = planTurnBlocks(turn, { streaming: false })

    expect(plan[0]).toMatchObject({ kind: "assistant", showActions: false })
    expect(plan[2]).toMatchObject({ kind: "assistant", showActions: true })
  })

  it("keeps the assistant block key stable while its messages grow", () => {
    const first = turnWithBlocks([
      { kind: "assistant", messages: [message("a-1", 2)], parts: [] },
    ])
    const grown = turnWithBlocks([
      { kind: "assistant", messages: [message("a-1", 2), message("a-2", 4)], parts: [] },
    ])

    expect(planTurnBlocks(first, { streaming: true })[0]?.key).toBe(
      planTurnBlocks(grown, { streaming: true })[0]?.key
    )
    expect(planTurnBlocks(grown, { streaming: true })[0]?.messageId).toBe("a-2")
  })

  it("never streams when the turn is not the running turn", () => {
    const turn = turnWithBlocks([
      { kind: "assistant", messages: [message("a-1", 2)], parts: [] },
    ])
    const plan = planTurnBlocks(turn, { streaming: false })

    expect(plan[0]).toMatchObject({ streaming: false, showActions: true })
  })

  it("uses stable keys for dividers and assistant blocks", () => {
    const turn = turnWithBlocks([
      { kind: "divider", message: message("d-1", 2), parts: [], phase: "interrupted" },
      { kind: "assistant", messages: [message("a-1", 4)], parts: [] },
    ])
    const plan = planTurnBlocks(turn, { streaming: false })

    expect(plan[0]?.key).toContain("d-1")
    expect(plan[0]?.phase).toBe("interrupted")
    expect(plan[1]?.messageId).toBe("a-1")
  })
})

function turnWithBlocks(blocks: ConversationTurn["blocks"]): ConversationTurn {
  return {
    id: "input-1",
    createdAt: 1,
    inputId: "input-1",
    runIds: ["run-1"],
    userMessage: message("u-1", 1),
    userParts: [],
    assistantMessages: blocks.flatMap((block) =>
      block.kind === "assistant" ? block.messages : []
    ),
    assistantParts: [],
    blocks,
  }
}

function message(id: string, seq: number): ConversationTurn["assistantMessages"][number] {
  return {
    id,
    sessionId: "session-1",
    seq,
    role: "assistant",
    metadata: {},
    createdAt: seq,
    updatedAt: seq,
  }
}
