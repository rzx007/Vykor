import { describe, expect, it } from "vitest"

import type {
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
} from "@shared/session-types"

import { buildConversationEntries } from "../conversation-turn-model"

describe("conversation turn model", () => {
  it("combines all assistant messages from the same input into one turn", () => {
    const messages = [
      message("user", 1, { inputId: "input-1" }),
      message("assistant", 2, { inputId: "input-1", runId: "run-1" }),
      message("assistant", 3, { runId: "run-1" }),
      message("assistant", 4, { inputId: "input-1", runId: "run-1" }),
    ]
    const parts = messages.map((item) => part(item.id, item.seq, `${item.role}-${item.seq}`))
    const entries = buildConversationEntries(messages, parts, [run("run-1", "input-1")])

    expect(entries).toHaveLength(1)
    if (entries[0]?.type !== "turn") throw new Error("Expected a conversation turn")
    expect(entries[0].turn.assistantMessages).toHaveLength(3)
    expect(entries[0].turn.assistantParts.map((item) => item.text)).toEqual([
      "assistant-2",
      "assistant-3",
      "assistant-4",
    ])
  })

  it("uses user messages as boundaries when relationship ids are absent", () => {
    const messages = [
      message("user", 1),
      message("assistant", 2),
      message("assistant", 3),
      message("user", 4),
      message("assistant", 5),
    ]
    const turns = buildConversationEntries(messages, [], []).flatMap((entry) =>
      entry.type === "turn" ? [entry.turn] : []
    )

    expect(turns).toHaveLength(2)
    expect(turns[0]?.assistantMessages).toHaveLength(2)
    expect(turns[1]?.assistantMessages).toHaveLength(1)
  })

  it("keeps assistant output after a steer under the steered user message", () => {
    const messages = [
      message("user", 1, { inputId: "input-1", runId: "run-1" }),
      message("assistant", 2, { runId: "run-1" }),
      message("user", 3, { inputId: "input-steer", runId: "run-1" }),
      message("assistant", 4, { runId: "run-1" }),
    ]
    const parts = messages.map((item) => part(item.id, item.seq, `${item.role}-${item.seq}`))

    const turns = buildConversationEntries(messages, parts, [run("run-1", "input-1")]).flatMap(
      (entry) => (entry.type === "turn" ? [entry.turn] : [])
    )

    expect(turns).toHaveLength(2)
    expect(turns[0]?.userMessage?.inputId).toBe("input-1")
    expect(turns[0]?.assistantParts.map((item) => item.text)).toEqual(["assistant-2"])
    expect(turns[1]?.userMessage?.inputId).toBe("input-steer")
    expect(turns[1]?.assistantParts.map((item) => item.text)).toEqual(["assistant-4"])
  })

  it("keeps system messages independent", () => {
    const entries = buildConversationEntries(
      [message("system", 1), message("user", 2), message("assistant", 3)],
      [],
      []
    )
    expect(entries.map((entry) => entry.type)).toEqual(["system", "turn"])
  })

  it("creates one assistant-only turn for a partial snapshot", () => {
    const entries = buildConversationEntries(
      [message("assistant", 1, { inputId: "input-1", runId: "run-1" })],
      [],
      [run("run-1", "input-1")]
    )

    if (entries[0]?.type !== "turn") throw new Error("Expected a conversation turn")
    expect(entries[0].turn.assistantMessages).toHaveLength(1)
  })

  it("merges an out-of-order optimistic user message into its own input turn", () => {
    const optimisticSeq = Number.MAX_SAFE_INTEGER
    const messages = [
      message("user", 1, { inputId: "input-1" }),
      message("assistant", 2, { inputId: "input-1", runId: "run-1" }),
      message("assistant", 3, { inputId: "input-2", runId: "run-2" }),
      message("user", optimisticSeq, { inputId: "input-2" }),
    ]
    const entries = buildConversationEntries(
      messages,
      messages.map((item) => part(item.id, item.seq, `${item.role}-${item.seq}`)),
      [run("run-1", "input-1"), run("run-2", "input-2")]
    )
    const turns = entries.flatMap((entry) => (entry.type === "turn" ? [entry.turn] : []))

    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({
      inputId: "input-1",
      assistantMessages: [{ inputId: "input-1" }],
    })
    expect(turns[1]).toMatchObject({
      inputId: "input-2",
      userMessage: { inputId: "input-2" },
      assistantMessages: [{ inputId: "input-2" }],
    })
  })

  it("keeps a failed run with its original user turn when no assistant message exists", () => {
    const failedRun = { ...run("run-1", "input-1"), status: "failed" as const, updatedAt: 2 }
    const entries = buildConversationEntries(
      [message("user", 1, { runId: "run-1" }), message("user", 3, { runId: "run-2" })],
      [],
      [failedRun, run("run-2", "input-2")]
    )
    const turns = entries.flatMap((entry) => (entry.type === "turn" ? [entry.turn] : []))

    expect(turns[0]?.runIds).toContain("run-1")
    expect(turns[1]?.runIds).not.toContain("run-1")
  })

  it("does not surface failed runs whose transcript was removed by an edit", () => {
    const failedRun = {
      ...run("orphan-run", "orphan-input"),
      status: "failed" as const,
      createdAt: 2,
      updatedAt: 2,
    }
    const entries = buildConversationEntries(
      [message("user", 1), message("user", 3)],
      [],
      [failedRun]
    )
    const turns = entries.flatMap((entry) => (entry.type === "turn" ? [entry.turn] : []))

    expect(turns.map((turn) => turn.id)).toEqual(["message-1", "message-3"])
    expect(turns.flatMap((turn) => turn.runIds)).not.toContain("orphan-run")
  })

  it("shows a failed run when no transcript messages exist yet", () => {
    const failedRun = {
      ...run("orphan-run", "orphan-input"),
      status: "failed" as const,
      createdAt: 2,
      updatedAt: 2,
    }
    const entries = buildConversationEntries([], [], [failedRun])
    const turns = entries.flatMap((entry) => (entry.type === "turn" ? [entry.turn] : []))

    expect(turns.map((turn) => turn.id)).toEqual(["orphan-input"])
    expect(turns[0]?.runIds).toEqual(["orphan-run"])
  })

  it("merges an auto-compaction divider pair inside the turn that triggered it", () => {
    const messages = [
      message("user", 1, { inputId: "input-1", runId: "run-1" }),
      compactionMessage("started", 2),
      compactionMessage("completed", 3),
      message("assistant", 4, { inputId: "input-1", runId: "run-1" }),
      message("assistant", 5, { inputId: "input-1", runId: "run-1" }),
    ]
    const parts = messages.map((item) => part(item.id, item.seq, `${item.role}-${item.seq}`))
    const entries = buildConversationEntries(messages, parts, [run("run-1", "input-1")])

    expect(entries).toHaveLength(1)
    if (entries[0]?.type !== "turn") throw new Error("Expected a conversation turn")
    const blocks = entries[0].turn.blocks
    expect(blocks.map((block) => block.kind)).toEqual(["divider", "assistant"])
    if (blocks[0]?.kind !== "divider") throw new Error("Expected a divider block")
    expect(blocks[0].phase).toBe("completed")
    expect(blocks[0].message.seq).toBe(2)
    if (blocks[1]?.kind !== "assistant") throw new Error("Expected an assistant block")
    expect(blocks[1].messages.map((item) => item.seq)).toEqual([4, 5])
  })

  it("places a mid-turn compaction divider between assistant segments", () => {
    const messages = [
      message("user", 1, { inputId: "input-1", runId: "run-1" }),
      message("assistant", 2, { inputId: "input-1", runId: "run-1" }),
      compactionMessage("started", 3),
      compactionMessage("completed", 4),
      message("assistant", 5, { inputId: "input-1", runId: "run-1" }),
    ]
    const parts = messages.map((item) => part(item.id, item.seq, `${item.role}-${item.seq}`))
    const entries = buildConversationEntries(messages, parts, [run("run-1", "input-1")])

    if (entries[0]?.type !== "turn") throw new Error("Expected a conversation turn")
    const blocks = entries[0].turn.blocks
    expect(blocks.map((block) => block.kind)).toEqual(["assistant", "divider", "assistant"])
    if (blocks[0]?.kind !== "assistant" || blocks[2]?.kind !== "assistant") {
      throw new Error("Expected assistant blocks around the divider")
    }
    expect(blocks[0].messages.map((item) => item.seq)).toEqual([2])
    expect(blocks[2].messages.map((item) => item.seq)).toEqual([5])
  })

  it("marks an unmatched started divider as interrupted when no run is active", () => {
    const messages = [
      message("user", 1, { inputId: "input-1", runId: "run-1" }),
      compactionMessage("started", 2),
    ]
    const entries = buildConversationEntries(messages, [], [])
    if (entries[0]?.type !== "turn") throw new Error("Expected a conversation turn")
    const divider = entries[0].turn.blocks[0]
    if (divider?.kind !== "divider") throw new Error("Expected a divider block")
    expect(divider.phase).toBe("interrupted")
  })

  it("keeps an unmatched started divider as started while a run is active", () => {
    const messages = [
      message("user", 1, { inputId: "input-1", runId: "run-1" }),
      compactionMessage("started", 2),
    ]
    const active = { ...run("run-1", "input-1"), status: "running" as const }
    const entries = buildConversationEntries(messages, [], [active])
    if (entries[0]?.type !== "turn") throw new Error("Expected a conversation turn")
    const divider = entries[0].turn.blocks[0]
    if (divider?.kind !== "divider") throw new Error("Expected a divider block")
    expect(divider.phase).toBe("started")
  })

  it("keeps a compaction divider at the end of the finished turn when it arrives after the turn", () => {
    const messages = [
      message("user", 1, { inputId: "input-1", runId: "run-1" }),
      message("assistant", 2, { inputId: "input-1", runId: "run-1" }),
      compactionMessage("started", 3),
      compactionMessage("completed", 4),
    ]
    const entries = buildConversationEntries(messages, [], [run("run-1", "input-1")])
    if (entries[0]?.type !== "turn") throw new Error("Expected a conversation turn")
    expect(entries[0].turn.blocks.map((block) => block.kind)).toEqual(["assistant", "divider"])
  })

  it("keeps non-compaction system messages as top-level entries", () => {
    const modelSwitch = {
      ...message("system", 2),
      metadata: { presentation: { kind: "model_switch", fromModel: "a", toModel: "b" } },
    }
    const entries = buildConversationEntries(
      [
        message("user", 1, { inputId: "input-1", runId: "run-1" }),
        modelSwitch,
        message("assistant", 3, { inputId: "input-1", runId: "run-1" }),
      ],
      [],
      [run("run-1", "input-1")]
    )
    expect(entries.map((entry) => entry.type)).toEqual(["turn", "system"])
    const system = entries[1]
    if (system?.type !== "system") throw new Error("Expected a system entry")
    expect(system.system.compactionPhase).toBeUndefined()
  })
})

function message(
  role: DesktopSessionMessage["role"],
  seq: number,
  relationship: Pick<DesktopSessionMessage, "inputId" | "runId"> = {}
): DesktopSessionMessage {
  return {
    id: `message-${seq}`,
    sessionId: "session-1",
    seq,
    role,
    metadata: {},
    createdAt: seq,
    updatedAt: seq,
    ...relationship,
  }
}

function part(messageId: string, seq: number, text: string): DesktopSessionPart {
  return {
    id: `part-${seq}`,
    sessionId: "session-1",
    messageId,
    seq: 0,
    type: "text",
    status: "completed",
    text,
    metadata: {},
    createdAt: seq,
    updatedAt: seq,
  }
}

function run(id: string, inputId: string): DesktopSessionRun {
  return {
    id,
    sessionId: "session-1",
    inputId,
    status: "completed",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

function compactionMessage(
  phase: "started" | "completed" | "failed",
  seq: number
): DesktopSessionMessage {
  return {
    ...message("system", seq),
    metadata: { presentation: { kind: "context_compaction", phase } },
  }
}
