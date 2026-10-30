import { describe, expect, it, vi } from "vitest"

import type { SessionEventRecord, SessionStateSnapshot } from "../../types/index"
import { syncEvents } from "../sync"
import { SessionSyncController } from "../session-sync-controller"
import type { SyncEventsClient } from "../sync"
import type { EventSyncOptions, SyncEventUpdate } from "../../types/index"
import { VykorApiError } from "../../transport/http-transport"

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

// The same consumer-visible scenarios protect both public synchronization APIs.
describe.each(["iterator", "controller"] as const)("shared sync behavior: %s", api => {
  async function consume(client: SyncEventsClient, options: EventSyncOptions,
    onUpdate: (update: SyncEventUpdate) => void, generation = 42): Promise<void> {
    if (api === "iterator") {
      for await (const update of syncEvents(client, options)) onUpdate(update)
    } else {
      const controller = new SessionSyncController({ client, ...options, generation,
        onUpdate: (update, actualGeneration) => { expect(actualGeneration).toBe(generation); onUpdate(update) } })
      await controller.start()
    }
  }

  const record = (seq: number): SessionEventRecord => ({
    id: `e${seq}`, seq, type: "session.updated", schemaVersion: 1, sessionId: "s1",
    payload: { session: { ...snapshot(seq).session, title: `title-${seq}` } }, createdAt: seq,
  })

  it.each(["clean end", "stream error"])("refreshes before reopening after %s and skips duplicates", async failure => {
    const abort = new AbortController()
    const calls: string[] = []
    let streams = 0
    let snapshots = 0
    const updates: SyncEventUpdate[] = []
    await consume({ sessions: { getState: async () => {
      calls.push("snapshot"); return snapshot(++snapshots === 1 ? 1 : 5)
    } }, events: { list: async () => [], stream: async function* (options) {
      calls.push(`stream:${options?.cursor}`)
      if (++streams === 1) {
        yield record(2); yield record(2)
        if (failure === "stream error") throw new Error("lost connection")
      } else { yield record(4); yield record(6); abort.abort() }
    } } }, { sessionId: "s1", signal: abort.signal, reconnectDelayMs: () => 0 }, update => updates.push(update))
    expect(calls).toEqual(["snapshot", "stream:1", "snapshot", "stream:5"])
    expect(updates.filter(update => update.source === "live").map(update => update.event?.seq)).toEqual([2, 6])
    expect(updates.at(-1)?.state.buckets.s1?.session?.title).toBe("title-6")
  })

  it("retries failed snapshots before reopening and retains the displayed state", async () => {
    const abort = new AbortController()
    const calls: string[] = []
    const updates: SyncEventUpdate[] = []
    let snapshots = 0
    let streams = 0
    await consume({ sessions: { getState: async () => {
      calls.push("snapshot")
      if (++snapshots === 2 || snapshots === 3) throw new Error("snapshot unavailable")
      return snapshot(snapshots === 1 ? 1 : 5)
    } }, events: { list: async () => [], stream: async function* (options) {
      calls.push(`stream:${options?.cursor}`)
      if (++streams === 1) yield record(2)
      else abort.abort()
    } } }, { sessionId: "s1", signal: abort.signal, reconnectDelayMs: () => 0 }, update => updates.push(update))
    expect(calls).toEqual(["snapshot", "stream:1", "snapshot", "snapshot", "snapshot", "stream:5"])
    expect(updates.filter(update => update.source === "reconnecting").map(update => update.state.buckets.s1?.session?.title))
      .toEqual(["title-2", "title-2", "title-2"])
  })

  it("fills global gaps once before applying the live event", async () => {
    const abort = new AbortController()
    const updates: SyncEventUpdate[] = []
    await consume({ sessions: { getState: async () => snapshot(1) }, events: {
      list: async options => options?.cursor === 1 ? [record(2), record(3)] : [record(1)],
      stream: async function* () { yield record(3); yield record(3); yield record(4); abort.abort() },
    } }, { signal: abort.signal }, update => updates.push(update))
    expect(updates.filter(update => update.event).map(update => [update.source, update.event?.seq]))
      .toEqual([["replay", 1], ["replay", 2], ["replay", 3], ["live", 4]])
  })

  it.each(["initial snapshot", "refresh snapshot", "gap replay", "live event"])("discards a late %s after cancellation", async stage => {
    const abort = new AbortController()
    let ready!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    let snapshots = 0
    const updates: SyncEventUpdate[] = []
    const syncing = consume({ sessions: { getState: async () => {
      snapshots++
      if (stage === "initial snapshot" || snapshots > 1) { ready(); await pending }
      return snapshot(snapshots === 1 ? 1 : 5)
    } }, events: {
      list: async options => {
        if (options?.cursor === 1) { ready(); await pending; return [record(2), record(3)] }
        return [record(1)]
      },
      stream: async function* () {
        if (stage === "refresh snapshot") return
        if (stage === "gap replay") { yield record(3); return }
        ready(); await pending; yield record(2)
      },
    } }, { sessionId: stage === "gap replay" ? undefined : "s1", signal: abort.signal, reconnectDelayMs: () => 0 },
    update => updates.push(update))
    await started
    const before = [...updates]
    abort.abort(); release()
    await syncing
    expect(updates).toEqual(before)
  })

  it("keeps a replacement subscription when the old generation resolves late", async () => {
    let ready!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    let release!: (value: SessionStateSnapshot) => void
    const pending = new Promise<SessionStateSnapshot>(resolve => { release = resolve })
    const oldAbort = new AbortController()
    const newAbort = new AbortController()
    let visible: SyncEventUpdate | undefined
    const old = consume({ sessions: { getState: async () => { ready(); return pending } },
      events: { list: async () => [], stream: emptyStream } },
    { sessionId: "s1", signal: oldAbort.signal }, update => { visible = update })
    await started
    oldAbort.abort()
    await consume({ sessions: { getState: async () => ({ ...snapshot(8), session: { ...snapshot(8).session, title: "new generation" } }) },
      events: { list: async () => [], stream: emptyStream } },
    { sessionId: "s1", signal: newAbort.signal }, update => { visible = update; newAbort.abort() }, 43)
    release(snapshot(1))
    await old
    expect(visible?.state.buckets.s1?.session?.title).toBe("new generation")
    expect(visible?.state.lastSeq).toBe(8)
  })

  it("stops during reconnect backoff without refreshing or reopening", async () => {
    const abort = new AbortController()
    const calls: string[] = []
    await consume({ sessions: { getState: async () => { calls.push("snapshot"); return snapshot(1) } },
      events: { list: async () => [], stream: async function* () { calls.push("stream") } } },
    { sessionId: "s1", signal: abort.signal, reconnectDelayMs: () => 30_000 }, update => {
      if (update.source === "reconnecting") queueMicrotask(() => abort.abort())
    })
    expect(calls).toEqual(["snapshot", "stream"])
  })

  it("does not reopen when the refreshed snapshot consumer cancels", async () => {
    const abort = new AbortController()
    let snapshots = 0
    let streams = 0
    await consume({ sessions: { getState: async () => snapshot(++snapshots === 1 ? 1 : 5) },
      events: { list: async () => [], stream: async function* () { streams++ } } },
    { sessionId: "s1", signal: abort.signal, reconnectDelayMs: () => 0 }, update => {
      if (update.source === "snapshot" && update.state.lastSeq === 5) abort.abort()
    })
    expect(streams).toBe(1)
  })

  it("retains each API's transport idle timeout default", async () => {
    const abort = new AbortController()
    let timeout: number | undefined
    await consume({ sessions: { getState: async () => snapshot(1) }, events: {
      list: async () => [], stream: async function* (options) { timeout = options?.idleTimeoutMs; abort.abort() },
    } }, { sessionId: "s1", signal: abort.signal }, () => {})
    expect(timeout).toBe(api === "iterator" ? 60_000 : undefined)
  })
})

describe("iterator transport options", () => {
  it("starts a session stream at its snapshot cursor rather than an unrelated requested cursor", async () => {
    const abort = new AbortController()
    let cursor: number | "latest" | undefined
    const client: SyncEventsClient = { sessions: { getState: async () => snapshot(5) }, events: {
      list: async () => [], stream: async function* (options) { cursor = options?.cursor; abort.abort() },
    } }
    for await (const _ of syncEvents(client, { sessionId: "s1", cursor: 100, signal: abort.signal })) { /* consume */ }
    expect(cursor).toBe(5)
  })
  it("forwards summary and a custom idle timeout through attach and reconnect", async () => {
    const abort = new AbortController()
    const snapshots: unknown[] = []
    const streams: unknown[] = []
    const client: SyncEventsClient = { sessions: { getState: async (_, options) => {
      snapshots.push(options?.partView); return snapshot(1)
    } }, events: { list: async () => [], stream: async function* (options) {
      streams.push([options?.partView, options?.idleTimeoutMs, options?.transportReconnect])
      if (streams.length === 2) abort.abort()
    } } }
    for await (const _ of syncEvents(client, { sessionId: "s1", partView: "summary", idleTimeoutMs: 123,
      signal: abort.signal, reconnectDelayMs: () => 0 })) { /* consume */ }
    expect(snapshots).toEqual(["summary", "summary"])
    expect(streams).toEqual([["summary", 123, false], ["summary", 123, false]])
  })
})

describe("syncEvents reconnect", () => {
  it.each([400, 401, 403, 404, 410, 422])("propagates HTTP %s when refreshing a disconnected session", async status => {
    const failure = new VykorApiError("Cannot observe session", status, { error: "Cannot observe session" })
    let reads = 0
    const client: SyncEventsClient = {
      sessions: { getState: async () => { if (++reads === 1) return snapshot(1); throw failure } },
      events: { list: async () => [], stream: emptyStream },
    }
    const observer = syncEvents(client, { sessionId: "s1", reconnectDelayMs: () => 0 })[Symbol.asyncIterator]()
    try {
      expect((await observer.next()).value?.source).toBe("snapshot")
      expect((await observer.next()).value?.source).toBe("reconnecting")
      await expect(observer.next()).rejects.toBe(failure)
    } finally {
      await observer.return?.()
    }
  })

  it.each([408, 425, 429, 500, 503])("recovers the session snapshot after a temporary HTTP %s", async status => {
    let reads = 0
    const client: SyncEventsClient = {
      sessions: { getState: async () => {
        if (++reads === 2) throw new VykorApiError("Temporarily unavailable", status, {})
        return snapshot(reads === 1 ? 1 : 5)
      } },
      events: { list: async () => [], stream: emptyStream },
    }
    const observer = syncEvents(client, { sessionId: "s1", reconnectDelayMs: () => 0 })[Symbol.asyncIterator]()
    try {
      expect((await observer.next()).value?.source).toBe("snapshot")
      expect((await observer.next()).value?.source).toBe("reconnecting")
      expect((await observer.next()).value?.source).toBe("reconnecting")
      const recovered = await observer.next()
      expect(recovered.value?.source).toBe("snapshot")
      expect(recovered.value?.state.lastSeq).toBe(5)
    } finally {
      await observer.return?.()
    }
  })

  it("forwards a usage-only event without adding a second Goal state", async () => {
    const usage = { knownTokens: 12, incomplete: false, unknownAttempts: 0, partialAttempts: 0, inFlightAttempts: 0, runTimeMs: 5, seq: 2, updatedAt: 2 };
    const value: SessionEventRecord = { id: "usage-2", seq: 2, type: "session.goal.usage.updated", schemaVersion: 1, sessionId: "s1", payload: { goalId: "g1", usage }, createdAt: 2 };
    const client = { sessions: { getState: async () => snapshot(1) }, events: { list: async () => [], stream: async function* () { yield value; } } };
    for await (const update of syncEvents(client, { sessionId: "s1" })) {
      if (!update.event) continue;
      expect(update.event).toEqual(value);
      expect(update.state.lastSeq).toBe(2);
      expect(update.state.eventsBySeq).toEqual({});
      return;
    }
    throw new Error("usage event was not forwarded");
  });
  it("keeps ordered session updates without accumulating event bodies or replaying duplicates", async () => {
    const updated = (seq: number): SessionEventRecord => ({
      id: `e${seq}`, seq, type: "session.updated", schemaVersion: 1,
      sessionId: "s1", payload: { session: { ...snapshot(1).session, title: `title-${seq}` } }, createdAt: seq,
    })
    const client = {
      sessions: { getState: async () => snapshot(1) },
      events: { list: async () => [], stream: async function* () {
        for (let seq = 2; seq <= 2001; seq++) yield updated(seq)
        yield updated(2001)
        yield updated(2)
        yield updated(2002)
      } },
    }
    let liveUpdates = 0
    let retainedEvents = 0
    for await (const update of syncEvents(client, { sessionId: "s1" })) {
      retainedEvents = Math.max(retainedEvents, Object.keys(update.state.eventsBySeq).length)
      if (update.source === "live") liveUpdates++
      if (update.state.lastSeq === 2002) {
        expect(update.state.buckets.s1?.session?.title).toBe("title-2002")
        break
      }
    }
    expect(liveUpdates).toBe(2001)
    expect(retainedEvents).toBe(0)
  })

  it("preserves live state when a reconnect snapshot is behind the ordered stream", async () => {
    let snapshots = 0
    let streams = 0
    const cursors: Array<number | "latest" | undefined> = []
    const client = {
      sessions: { getState: async () => snapshot(++snapshots === 1 ? 1 : 2) },
      events: { list: async () => [], stream: async function* (options?: { cursor?: number | "latest" }) {
        cursors.push(options?.cursor)
        if (++streams === 1) {
          yield { id: "e5", seq: 5, type: "session.updated", schemaVersion: 1,
            sessionId: "s1", payload: { session: { ...snapshot(1).session, title: "latest" } }, createdAt: 5 } satisfies SessionEventRecord
        } else {
          yield { id: "e6", seq: 6, type: "session.updated", schemaVersion: 1,
            sessionId: "s1", payload: { session: { ...snapshot(1).session, title: "resumed" } }, createdAt: 6 } satisfies SessionEventRecord
        }
      } },
    }
    for await (const update of syncEvents(client, { sessionId: "s1", reconnectDelayMs: () => 0 })) {
      if (update.source === "snapshot" && snapshots === 2) {
        expect(update.state.buckets.s1?.session?.title).toBe("latest")
        expect(update.state.eventsBySeq).toEqual({})
      }
      if (update.state.lastSeq === 6) break
    }
    expect(cursors).toEqual([1, 5])
  })

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
