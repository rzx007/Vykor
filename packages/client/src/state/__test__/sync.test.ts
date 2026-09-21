import { describe, expect, it, vi } from "vitest"

import type { SessionEventRecord, SessionStateSnapshot } from "../../types/index"
import { syncEvents } from "../sync"

function snapshot(cursor: number): SessionStateSnapshot {
  return {
    cursor,
    session: {
      id: "s1",
      cwd: "/repo",
      title: "s1",
      model: "gpt-test",
      status: "running",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
    inputs: [],
    messages: [],
    parts: [],
    runs: [],
    permissions: [],
  } as SessionStateSnapshot
}

function emptyStream(): AsyncIterable<SessionEventRecord> {
  return (async function* () {})()
}

describe("syncEvents reconnect", () => {
  it("lets a global consumer use a lightweight reducer without changing replay boundaries", async () => {
    const record = { id: "e1", seq: 1, type: "session.message.created", schemaVersion: 1,
      sessionId: "s1", payload: { message: { id: "m1", sessionId: "s1", role: "assistant", content: "large transcript" } }, createdAt: 1 } satisfies SessionEventRecord
    const client = {
      sessions: { getState: vi.fn(async () => snapshot(1)) },
      events: { list: vi.fn(async () => [record]), stream: vi.fn(() => emptyStream()) },
    }
    const sources: string[] = []
    for await (const update of syncEvents(client, {
      globalReducer: (state, event) => ({ ...state, lastSeq: event.seq }),
    })) {
      sources.push(update.source)
      expect(update.state.eventsBySeq).toEqual({})
      if (sources.length === 2) break
    }
    expect(sources).toEqual(["replay", "snapshot"])
  })
  it("keeps global gap catch-up ordered with a lightweight reducer", async () => {
    const record = (seq: number): SessionEventRecord => ({
      id: `e${seq}`, seq, type: "daemon.test", schemaVersion: 1, payload: {}, createdAt: seq,
    })
    const client = {
      sessions: { getState: vi.fn(async () => snapshot(1)) },
      events: {
        list: vi.fn(async (input?: { cursor?: number }) => input?.cursor === 1
          ? [record(2), record(3)] : [record(1)]),
        stream: vi.fn(async function* () { yield record(3) }),
      },
    }
    const received: Array<[string, number | undefined]> = []
    for await (const update of syncEvents(client, {
      globalReducer: (state, event) => ({ ...state, lastSeq: event.seq }),
    })) {
      received.push([update.source, update.event?.seq])
      expect(update.state.eventsBySeq).toEqual({})
      if (received.length === 4) break
    }
    expect(received).toEqual([
      ["replay", 1], ["snapshot", undefined], ["replay", 2], ["replay", 3],
    ])
  })
  it("marks the end of global replay before delivering live events", async () => {
    const replay = {
      id: "e1", seq: 1, type: "session.created", schemaVersion: 1,
      sessionId: "s1", payload: { session: snapshot(1).session }, createdAt: 1,
    } satisfies SessionEventRecord
    const live = { ...replay, id: "e2", seq: 2, createdAt: 2 }
    const client = {
      sessions: { getState: vi.fn(async () => snapshot(1)) },
      events: {
        list: vi.fn(async () => [replay]),
        stream: async function* () { yield live },
      },
    }

    const updates = []
    for await (const update of syncEvents(client)) {
      updates.push(update)
      if (updates.length === 3) break
    }

    expect(updates.map(({ source, event }) => [source, event?.seq])).toEqual([
      ["replay", 1], ["snapshot", undefined], ["live", 2],
    ])
    expect(updates[1]?.state.lastSeq).toBe(1)
  })

  it("re-snapshots after a clean stream end and reports snapshot source", async () => {
    const getState = vi
      .fn<() => Promise<SessionStateSnapshot>>()
      .mockResolvedValueOnce(snapshot(1))
      .mockResolvedValueOnce(snapshot(5))
    const client = {
      sessions: { getState },
      events: { list: vi.fn(async () => []), stream: vi.fn(() => emptyStream()) },
    }

    const sources: string[] = []
    for await (const update of syncEvents(client as never, {
      sessionId: "s1",
      reconnectDelayMs: () => 0,
    })) {
      sources.push(update.source)
      if (sources.length >= 3) break
    }

    expect(sources).toEqual(["snapshot", "reconnecting", "snapshot"])
    expect(getState).toHaveBeenCalledTimes(2)
  })

  it("re-snapshots after a stream error", async () => {
    const getState = vi.fn(async () => snapshot(1))
    const failing = (async function* (): AsyncIterable<SessionEventRecord> {
      throw new Error("stream boom")
    })()
    const client = {
      sessions: { getState },
      events: { list: vi.fn(async () => []), stream: vi.fn(() => failing) },
    }

    const sources: string[] = []
    for await (const update of syncEvents(client as never, {
      sessionId: "s1",
      reconnectDelayMs: () => 0,
    })) {
      sources.push(update.source)
      if (sources.length >= 3) break
    }

    expect(sources).toEqual(["snapshot", "reconnecting", "snapshot"])
    expect(getState).toHaveBeenCalledTimes(2)
  })

  it("keeps reconnecting when the resync snapshot fails", async () => {
    const getState = vi
      .fn<() => Promise<SessionStateSnapshot>>()
      .mockResolvedValueOnce(snapshot(1))
      .mockRejectedValueOnce(new Error("snapshot boom"))
      .mockResolvedValue(snapshot(1))
    const client = {
      sessions: { getState },
      events: { list: vi.fn(async () => []), stream: vi.fn(() => emptyStream()) },
    }

    const sources: string[] = []
    for await (const update of syncEvents(client as never, {
      sessionId: "s1",
      reconnectDelayMs: () => 0,
    })) {
      sources.push(update.source)
      if (sources.length >= 4) break
    }

    expect(sources).toEqual(["snapshot", "reconnecting", "reconnecting", "snapshot"])
    expect(getState).toHaveBeenCalledTimes(3)
  })

  it("keeps reconnecting when consecutive resync snapshots fail", async () => {
    const getState = vi
      .fn<() => Promise<SessionStateSnapshot>>()
      .mockResolvedValueOnce(snapshot(1))
      .mockRejectedValueOnce(new Error("snapshot boom"))
      .mockRejectedValueOnce(new Error("snapshot boom"))
      .mockResolvedValue(snapshot(1))
    const client = {
      sessions: { getState },
      events: { list: vi.fn(async () => []), stream: vi.fn(() => emptyStream()) },
    }

    const sources: string[] = []
    for await (const update of syncEvents(client as never, {
      sessionId: "s1",
      reconnectDelayMs: () => 0,
    })) {
      sources.push(update.source)
      if (sources.length >= 5) break
    }

    expect(sources).toEqual([
      "snapshot",
      "reconnecting",
      "reconnecting",
      "reconnecting",
      "snapshot",
    ])
    expect(getState).toHaveBeenCalledTimes(4)
  })
})
