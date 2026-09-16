import { describe, expect, it } from "vitest";

import { SessionSyncController } from "../session-sync-controller.js";
import { applySessionSnapshot, createInitialClientState } from "../reducer.js";
import type { SessionEventRecord, SessionRecord, SessionStateSnapshot } from "../../types/index.js";

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
