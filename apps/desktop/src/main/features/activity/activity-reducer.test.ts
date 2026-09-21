import { describe, expect, it } from "vitest"
import {
  createInitialClientState,
  syncEvents,
  type SessionEventRecord,
  type SyncEventUpdate,
} from "@openharness/client"
import { reduceActivityEvent } from "./activity-reducer"

const session = {
  id: "s1",
  cwd: "D:/repo",
  title: "Work",
  model: "m",
  status: "idle" as const,
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
}
const event = (
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  sessionId = "s1"
): SessionEventRecord => ({
  id: `e${seq}`,
  seq,
  type,
  schemaVersion: 1,
  sessionId,
  payload,
  createdAt: seq,
})

describe("Activity-only event reduction", () => {
  it("keeps session, run and permission summaries without transcript or event history", () => {
    const events = [
      event(1, "session.created", { session }),
      event(2, "session.message.created", {
        message: {
          id: "m",
          sessionId: "s1",
          role: "assistant",
          metadata: {},
          createdAt: 2,
          updatedAt: 2,
        },
      }),
      event(3, "session.message.part.updated", {
        part: {
          id: "p",
          sessionId: "s1",
          messageId: "m",
          seq: 1,
          type: "text",
          text: "large result",
          metadata: {},
          createdAt: 3,
          updatedAt: 3,
        },
      }),
      event(4, "session.run.created", {
        run: {
          id: "r",
          sessionId: "s1",
          status: "running",
          metadata: {},
          createdAt: 4,
          updatedAt: 4,
        },
      }),
      event(5, "permission.asked", {
        request: {
          id: "p1",
          sessionId: "s1",
          toolName: "Write",
          payload: {},
          status: "pending",
          createdAt: 5,
          updatedAt: 5,
        },
      }),
    ]
    const state = events.reduce(reduceActivityEvent, createInitialClientState())
    expect(state.lastSeq).toBe(5)
    expect(state.eventsBySeq).toEqual({})
    expect(state.buckets.s1?.messages).toEqual([])
    expect(state.buckets.s1?.partsByMessageId).toEqual({})
    expect(state.buckets.s1?.runs.r?.status).toBe("running")
    expect(state.buckets.s1?.permissions.p1?.status).toBe("pending")
    expect(state.sessions.s1?.updatedAt).toBe(4)
  })

  it("uses the same global replay boundary while retaining only Activity summaries", async () => {
    const events = [
      event(1, "session.created", { session }),
      event(2, "session.message.created", {
        message: { id: "m", sessionId: "s1", role: "assistant", text: "large" },
      }),
    ]
    const client = {
      sessions: {
        getState: async () => {
          throw new Error("not used")
        },
      },
      events: {
        list: async () => events,
        stream: async function* () {
          yield events[0]!
        },
      },
    }
    const updates: SyncEventUpdate[] = []
    for await (const update of syncEvents(client, { globalReducer: reduceActivityEvent })) {
      updates.push(update)
      if (update.source === "snapshot") break
    }
    expect(updates.map((update) => update.source)).toEqual(["replay", "replay", "snapshot"])
    expect(updates.at(-1)?.state.buckets.s1?.messages).toEqual([])
    expect(updates.at(-1)?.state.eventsBySeq).toEqual({})
  })
})
