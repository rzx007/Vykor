import { describe, expect, it } from "vitest";

import { SessionSyncController } from "../session-sync-controller.js";
import { applySessionSnapshot, createInitialClientState } from "../reducer.js";
import type { SessionEventRecord, SessionRecord, SessionRunRecord, SessionStateSnapshot } from "../../types/index.js";

function session(title: string): SessionRecord {
  return {
    id: "s1",
    cwd: process.cwd(),
    title,
    model: "m",
    status: "idle",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

function snapshot(cursor: number, title: string): SessionStateSnapshot {
  return {
    cursor,
    session: session(title),
    inputs: [],
    messages: [],
    parts: [],
    runs: [],
    permissions: [],
  };
}

function event(seq: number, schemaVersion = 1): SessionEventRecord {
  return {
    id: `e${seq}`,
    seq,
    type: "session.updated",
    schemaVersion,
    sessionId: "s1",
    payload: {},
    createdAt: seq,
  };
}

describe("SessionSyncController", () => {
  it.each(["clean end", "stream error", "snapshot error"])("refreshes session state before resuming after %s", async failure => {
    let snapshots = 0;
    const streamCursors: Array<number | "latest" | undefined> = [];
    const sources: string[] = [];
    let controller!: SessionSyncController;
    const client = {
      sessions: { getState: async () => {
        snapshots++;
        if (failure === "snapshot error" && snapshots === 2) throw new Error("snapshot unavailable");
        return snapshots === 1 ? snapshot(1, "before disconnect") : snapshot(5, "current after reconnect");
      } },
      events: {
        list: async () => [],
        stream: async function* (options?: { cursor?: number | "latest" }) {
          streamCursors.push(options?.cursor);
          if (streamCursors.length === 1) {
            if (failure === "stream error") throw new Error("connection lost");
            return;
          }
          controller.abort();
        },
      },
    };
    controller = new SessionSyncController({ client, sessionId: "s1", reconnectDelayMs: () => 0,
      onUpdate: update => sources.push(update.source) });
    await controller.start();

    expect(controller.currentState.buckets.s1?.session?.title).toBe("current after reconnect");
    expect(streamCursors).toEqual([1, 5]);
    expect(snapshots).toBe(failure === "snapshot error" ? 3 : 2);
    expect(sources.filter(source => source === "snapshot")).toHaveLength(2);
    expect(controller.currentStatus).toBe("idle");
  });

  it("ignores a resync snapshot that arrives after cancellation", async () => {
    let announceRefresh!: () => void;
    const refreshStarted = new Promise<void>(resolve => { announceRefresh = resolve; });
    let finishRefresh!: (value: SessionStateSnapshot) => void;
    const refreshResult = new Promise<SessionStateSnapshot>(resolve => { finishRefresh = resolve; });
    let snapshots = 0;
    let streams = 0;
    const sources: string[] = [];
    const client = {
      sessions: { getState: async () => {
        if (++snapshots === 1) return snapshot(1, "retained state");
        announceRefresh();
        return refreshResult;
      } },
      events: { list: async () => [], stream: async function* () {
        // A missing resnapshot must fail the test, not spin forever on empty streams.
        if (++streams > 1) { controller.abort(); announceRefresh(); }
      } },
    };
    const controller = new SessionSyncController({ client, sessionId: "s1", reconnectDelayMs: () => 0,
      onUpdate: update => sources.push(update.source) });
    const syncing = controller.start();
    await refreshStarted;
    controller.abort();
    finishRefresh(snapshot(5, "cancelled result"));
    await syncing;

    expect(controller.currentState.buckets.s1?.session?.title).toBe("retained state");
    expect(controller.currentState.lastSeq).toBe(1);
    expect(sources).toEqual(["snapshot", "reconnecting"]);
    expect(snapshots).toBe(2);
    expect(streams).toBe(1);
    expect(controller.currentStatus).toBe("idle");
  });

  it("keeps newer session state and cursor when the reconnect snapshot is stale", async () => {
    let snapshots = 0;
    const cursors: Array<number | "latest" | undefined> = [];
    let controller!: SessionSyncController;
    const client = {
      sessions: { getState: async () => ++snapshots === 1 ? snapshot(7, "newer") : snapshot(3, "stale") },
      events: { list: async () => [], stream: async function* (options?: { cursor?: number | "latest" }) {
        cursors.push(options?.cursor);
        if (cursors.length === 2) controller.abort();
      } },
    };
    controller = new SessionSyncController({ client, sessionId: "s1", reconnectDelayMs: () => 0 });
    await controller.start();

    expect(snapshots).toBe(2);
    expect(cursors).toEqual([7, 7]);
    expect(controller.currentState.buckets.s1?.session?.title).toBe("newer");
    expect(controller.currentState.lastSeq).toBe(7);
  });

  it("settles generating work from the reconnect snapshot and ignores a late running update", async () => {
    const running: SessionRunRecord = {
      id: "r1", sessionId: "s1", status: "running", metadata: {}, createdAt: 1, updatedAt: 1,
    };
    let snapshots = 0;
    let streams = 0;
    const sources: string[] = [];
    let controller!: SessionSyncController;
    const client = {
      sessions: { getState: async () => {
        if (++snapshots === 1) return { ...snapshot(1, "working"), runs: [running] };
        return { ...snapshot(5, "settled"), runs: [{ ...running, status: "completed" as const,
          metadata: { toolGeneration: [] }, updatedAt: 5 }] };
      } },
      events: { list: async () => [], stream: async function* () {
        const firstStream = ++streams === 1;
        yield { ...event(firstStream ? 2 : 3), type: "session.run.updated", payload: {
          run: { ...running, metadata: { toolGeneration: [{ generationId: "g1", attempt: 1,
            toolKey: "0", toolName: "Write", receivedChars: firstStream ? 200 : 300 }] } },
        } };
        if (!firstStream) controller.abort();
      } },
    };
    controller = new SessionSyncController({ client, sessionId: "s1", reconnectDelayMs: () => 0,
      onUpdate: update => sources.push(update.source) });
    await controller.start();

    expect(snapshots).toBe(2);
    expect(streams).toBe(2);
    expect(sources).toEqual(["snapshot", "live", "reconnecting", "snapshot"]);
    expect(controller.currentState.buckets.s1?.runs.r1).toMatchObject({
      status: "completed", metadata: { toolGeneration: [] },
    });
    expect(controller.currentState.lastSeq).toBe(5);
  });

  it("keeps a supplied durable cursor when replay is empty", async () => {
    const listCursors: Array<number | undefined> = [];
    const streamCursors: Array<number | "latest" | undefined> = [];
    let controller!: SessionSyncController;
    const client = {
      sessions: {
        getState: async () => {
          throw new Error("session snapshot is not used for global sync");
        },
      },
      events: {
        list: async (options?: { cursor?: number }) => {
          listCursors.push(options?.cursor);
          return [];
        },
        stream: async function* (options?: { cursor?: number | "latest" }) {
          streamCursors.push(options?.cursor);
          controller.abort();
        },
      },
    };

    const initialState = { ...createInitialClientState(), lastSeq: 7 };
    controller = new SessionSyncController({ client, cursor: 7, initialState });
    await controller.start();

    expect(listCursors).toEqual([7]);
    expect(streamCursors).toEqual([7]);
    expect(controller.currentState).toBe(initialState);
  });

  it("rejects a non-zero cursor without its durable state", () => {
    const client = {
      sessions: { getState: async () => { throw new Error("unused"); } },
      events: {
        list: async () => [],
        stream: async function* () {},
      },
    };

    expect(() => new SessionSyncController({ client, cursor: 7 })).toThrow(
      "A non-zero cursor requires initialState",
    );
  });

  it("does not replace a newer session bucket or regress its stream cursor", async () => {
    const initialState = applySessionSnapshot(createInitialClientState(), snapshot(7, "newer"));
    const streamCursors: Array<number | "latest" | undefined> = [];
    let controller!: SessionSyncController;
    const client = {
      sessions: { getState: async () => snapshot(3, "stale") },
      events: {
        list: async () => [],
        stream: async function* (options?: { cursor?: number | "latest" }) {
          streamCursors.push(options?.cursor);
          controller.abort();
        },
      },
    };

    controller = new SessionSyncController({ client, sessionId: "s1", initialState });
    await controller.start();

    expect(controller.currentState).toBe(initialState);
    expect(controller.currentState.buckets.s1?.session?.title).toBe("newer");
    expect(streamCursors).toEqual([7]);
  });

  it("reports an unsupported event schema once", async () => {
    const errors: unknown[] = [];
    const client = {
      sessions: {
        getState: async () => {
          throw new Error("session snapshot is not used for global sync");
        },
      },
      events: {
        list: async () => [],
        stream: async function* () {
          yield event(1, 2);
        },
      },
    };

    const controller = new SessionSyncController({
      client,
      onError: (error) => errors.push(error),
    });
    await controller.start();

    expect(controller.currentStatus).toBe("error");
    expect(errors).toHaveLength(1);
  });
});
