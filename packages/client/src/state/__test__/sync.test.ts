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
