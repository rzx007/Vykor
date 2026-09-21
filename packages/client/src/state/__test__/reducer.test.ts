import { describe, expect, it } from "vitest";

import {
  applyEvent,
  applyEvents,
  applySessionSnapshot,
  createInitialClientState,
  UnsupportedSessionEventSchemaVersionError,
} from "../reducer.js";
import { selectSessionMessagesWithParts } from "../selectors.js";
import { hydrateState } from "../sync.js";
import type {
  PermissionRequestRecord,
  SessionEventRecord,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionRunRecord,
  SessionExecutionRecord,
} from "../../types/index.js";

function session(id: string, updatedAt: number): SessionRecord {
  return {
    id,
    cwd: process.cwd(),
    title: id,
    model: "m",
    status: "idle",
    metadata: {},
    createdAt: updatedAt,
    updatedAt,
  };
}

function event(seq: number, type: string, payload: Record<string, unknown>, sessionId = "s1"): SessionEventRecord {
  return { id: `e${seq}`, seq, type, schemaVersion: 1, sessionId, payload, createdAt: seq };
}

describe("session event reducer", () => {
  it("removes a deleted session tree from the global state", () => {
    const created = applyEvents(createInitialClientState(), [
      event(1, "session.created", { session: session("root", 1) }, "root"),
      event(2, "session.created", { session: session("child", 2) }, "child"),
    ]);
    const deleted = applyEvent(created, {
      ...event(3, "session.deleted", { sessionIds: ["root", "child"] }),
      sessionId: undefined,
    });
    expect(deleted.sessionOrder).toEqual([]);
    expect(deleted.sessions).toEqual({});
    expect(deleted.buckets).toEqual({});
  });
  it("ignores a session snapshot older than the accepted snapshot cursor", () => {
    const newer = applySessionSnapshot(createInitialClientState(), {
      cursor: 7,
      session: { ...session("s1", 7), title: "newer" },
      inputs: [], messages: [], parts: [], runs: [], permissions: [],
    });
    const stale = applySessionSnapshot(newer, {
      cursor: 3,
      session: { ...session("s1", 3), title: "stale" },
      inputs: [], messages: [], parts: [], runs: [], permissions: [],
    });

    expect(stale).toBe(newer);
    expect(stale.buckets.s1?.session?.title).toBe("newer");
  });

  it("keeps the newest complete input attachment record regardless of snapshot/event arrival order", () => {
    const older: SessionInputRecord = {
      id: "input-1", sessionId: "s1", seq: 1, delivery: "queue", content: "look",
      attachments: [{
        id: "ref-old", sessionId: "s1", inputId: "input-1", assetId: "att-old", seq: 1,
        intent: "auto", displayName: "old.png", mediaType: "image/png", sizeBytes: 10,
        metadata: {}, createdAt: 1,
      }],
      metadata: {}, createdAt: 1,
    };
    const newer: SessionInputRecord = {
      ...older,
      attachments: [{
        id: "ref-new", sessionId: "s1", inputId: "input-1", assetId: "att-new", seq: 1,
        intent: "ocr", displayName: "new.png", mediaType: "image/png", sizeBytes: 20,
        metadata: {}, createdAt: 2,
      }],
    };
    const snapshot = {
      cursor: 2, session: session("s1", 2), inputs: [newer], messages: [], parts: [], runs: [], permissions: [],
    };
    const admitted = {
      ...event(1, "session.input.admitted", { input: older }),
      schemaVersion: 2,
    };
    const eventThenSnapshot = applySessionSnapshot(applyEvent(createInitialClientState(), admitted), snapshot);
    const snapshotThenEvent = applyEvent(applySessionSnapshot(createInitialClientState(), snapshot), admitted);

    expect(eventThenSnapshot.buckets.s1?.inputs).toEqual([newer]);
    expect(snapshotThenEvent.buckets.s1?.inputs).toEqual([newer]);
  });

  it("rejects an unknown event schema version without advancing the cursor", () => {
    const state = createInitialClientState();
    const incompatible = {
      ...event(1, "session.updated", {}),
      schemaVersion: 2,
    };

    expect(() => applyEvent(state, incompatible)).toThrow(
      UnsupportedSessionEventSchemaVersionError,
    );
    expect(state.lastSeq).toBe(0);
    expect(state.eventsBySeq).toEqual({});
  });

  it("accepts session.input.admitted at schema version 2", () => {
    const input: SessionInputRecord = {
      id: "input-1",
      sessionId: "s1",
      seq: 1,
      delivery: "queue",
      items: [{ type: "text", text: "hello" }],
      content: "hello",
      attachments: [],
      metadata: {},
      createdAt: 1,
    };
    const admitted = {
      ...event(1, "session.input.admitted", { input }),
      schemaVersion: 2,
    };

    const next = applyEvent(createInitialClientState(), admitted);

    expect(next.lastSeq).toBe(1);
    expect(next.buckets.s1?.inputs).toEqual([input]);
  });

  it("rejects session.input.admitted at the retired schema version 1", () => {
    const input: SessionInputRecord = {
      id: "input-1",
      sessionId: "s1",
      seq: 1,
      delivery: "queue",
      items: [{ type: "text", text: "hello" }],
      content: "hello",
      attachments: [],
      metadata: {},
      createdAt: 1,
    };

    expect(() =>
      applyEvent(
        createInitialClientState(),
        event(1, "session.input.admitted", { input }),
      ),
    ).toThrow(UnsupportedSessionEventSchemaVersionError);
  });

  it("hydrates canonical messages, parts, runs, and permissions from an attach snapshot", () => {
    const current = session("s1", 10);
    const message: SessionMessageRecord = {
      id: "m1", sessionId: "s1", seq: 1, role: "assistant", metadata: {}, createdAt: 10, updatedAt: 10,
    };
    const part: SessionMessagePartRecord = {
      id: "part1", sessionId: "s1", messageId: "m1", seq: 1, type: "text",
      status: "completed", text: "visible after attach", metadata: {}, createdAt: 10, updatedAt: 10,
    };
    const state = applySessionSnapshot(createInitialClientState(), {
      cursor: 42,
      session: current,
      inputs: [],
      messages: [message],
      parts: [part],
      runs: [],
      permissions: [],
    });

    expect(state.lastSeq).toBe(42);
    expect(selectSessionMessagesWithParts(state.buckets.s1)).toEqual([{ message, parts: [part] }]);
  });

  it("keys state by session and applies the core session event shapes", () => {
    const created = session("s1", 1);
    const message: SessionMessageRecord = {
      id: "m1",
      sessionId: "s1",
      seq: 1,
      role: "assistant",
      metadata: {},
      createdAt: 2,
      updatedAt: 2,
    };
    const part: SessionMessagePartRecord = {
      id: "p1",
      sessionId: "s1",
      messageId: "m1",
      seq: 1,
      type: "text",
      status: "completed",
      text: "hello",
      metadata: {},
      createdAt: 2,
      updatedAt: 2,
    };
    const run: SessionRunRecord = {
      id: "r1",
      sessionId: "s1",
      status: "running",
      metadata: {},
      createdAt: 3,
      updatedAt: 3,
    };
    const permission: PermissionRequestRecord = {
      id: "p1",
      sessionId: "s1",
      runId: "r1",
      toolName: "Write",
      payload: { path: "README.md" },
      status: "pending",
      createdAt: 4,
      updatedAt: 4,
    };

    const state = applyEvents(createInitialClientState(), [
      event(1, "session.created", { session: created }),
      event(2, "session.message.created", { message }),
      event(3, "session.message.part.updated", { part }),
      event(4, "session.run.updated", { run }),
      event(5, "permission.asked", { request: permission }),
    ]);

    expect(state.sessionOrder).toEqual(["s1"]);
    expect(state.buckets.s1?.session).toEqual({
      ...created,
      status: "running",
      updatedAt: run.updatedAt,
    });
    expect(state.buckets.s1?.messages).toEqual([message]);
    expect(state.buckets.s1?.partsByMessageId.m1).toEqual([part]);
    expect(selectSessionMessagesWithParts(state.buckets.s1)).toEqual([{ message, parts: [part] }]);
    expect(state.buckets.s1?.runs.r1).toEqual(run);
    expect(state.buckets.s1?.permissions.p1).toEqual(permission);
    expect(state.lastSeq).toBe(5);
  });

  it("hydrates and updates durable task projections", () => {
    const task: SessionExecutionRecord = {
      id: "task-1", sessionId: "s1", childSessionId: "child-1", runId: "run-1",
      type: "agent", status: "running", description: "Explore@default", cwd: process.cwd(),
      metadata: {}, createdAt: 1, startedAt: 1, updatedAt: 1,
    };
    let state = applySessionSnapshot(createInitialClientState(), {
      cursor: 1, session: session("s1", 1), inputs: [], messages: [], parts: [], runs: [], tasks: [task], permissions: [],
    });
    expect(state.buckets.s1?.tasks[task.id]).toEqual(task);
    const interrupted = { ...task, status: "interrupted" as const, error: "daemon restarted", finishedAt: 2, updatedAt: 2 };
    state = applyEvent(state, event(2, "session.task.updated", { task: interrupted }));
    expect(state.buckets.s1?.tasks[task.id]).toEqual(interrupted);
  });

  it("applies session.updated to refresh model and other session fields", () => {
    const created = session("s1", 1);
    const updated = { ...created, model: "new-model", updatedAt: 2 };
    const state = applyEvents(createInitialClientState(), [
      event(1, "session.created", { session: created }),
      event(2, "session.updated", { session: updated }),
    ]);
    expect(state.sessions.s1?.model).toBe("new-model");
    expect(state.buckets.s1?.session?.model).toBe("new-model");
  });

  it("derives the live session status from run updates", () => {
    const created = session("s1", 1);
    const running: SessionRunRecord = {
      id: "r1",
      sessionId: "s1",
      status: "running",
      metadata: {},
      createdAt: 2,
      updatedAt: 2,
    };
    const completed: SessionRunRecord = {
      ...running,
      status: "completed",
      finishedAt: 3,
      updatedAt: 3,
    };

    let state = applyEvents(createInitialClientState(), [
      event(1, "session.created", { session: created }),
      event(2, "session.run.updated", { run: running }),
    ]);
    expect(state.sessions.s1?.status).toBe("running");
    expect(state.buckets.s1?.session?.status).toBe("running");

    state = applyEvent(state, event(3, "session.run.updated", { run: completed }));
    expect(state.sessions.s1?.status).toBe("idle");
    expect(state.buckets.s1?.session?.status).toBe("idle");
    expect(state.buckets.s1?.session?.updatedAt).toBe(3);
  });

  it("replaces a session transcript from session.transcript.replaced", () => {
    const created = session("s1", 1);
    const oldMessage: SessionMessageRecord = {
      id: "m-old",
      sessionId: "s1",
      seq: 1,
      role: "user",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    };
    const oldPart: SessionMessagePartRecord = {
      id: "p-old",
      sessionId: "s1",
      messageId: "m-old",
      seq: 1,
      type: "text",
      status: "completed",
      text: "old",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    };
    const nextMessage: SessionMessageRecord = {
      id: "m-new",
      sessionId: "s1",
      seq: 1,
      role: "assistant",
      metadata: {},
      createdAt: 2,
      updatedAt: 2,
    };
    const nextPart: SessionMessagePartRecord = {
      id: "p-new",
      sessionId: "s1",
      messageId: "m-new",
      seq: 1,
      type: "text",
      status: "completed",
      text: "compacted",
      metadata: {},
      createdAt: 2,
      updatedAt: 2,
    };
    const state = applyEvents(createInitialClientState(), [
      event(1, "session.created", { session: created }),
      event(2, "session.message.created", { message: oldMessage }),
      event(3, "session.message.part.updated", { part: oldPart }),
      event(4, "session.transcript.replaced", {
        messages: [nextMessage],
        parts: [nextPart],
      }),
    ]);
    expect(state.buckets.s1?.messages.map((message) => message.id)).toEqual(["m-new"]);
    expect(state.buckets.s1?.partsByMessageId["m-new"]?.[0]?.text).toBe("compacted");
    expect(state.buckets.s1?.partsByMessageId["m-old"]).toBeUndefined();
  });

  it("dedupes events by seq and converges when records arrive out of order", () => {
    const first: SessionMessageRecord = {
      id: "m1",
      sessionId: "s1",
      seq: 1,
      role: "user",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    };
    const second: SessionMessageRecord = {
      id: "m2",
      sessionId: "s1",
      seq: 2,
      role: "assistant",
      metadata: {},
      createdAt: 2,
      updatedAt: 2,
    };
    const secondPart: SessionMessagePartRecord = {
      id: "p2",
      sessionId: "s1",
      messageId: "m2",
      seq: 1,
      type: "text",
      status: "running",
      text: "sec",
      metadata: {},
      createdAt: 2,
      updatedAt: 2,
    };

    let state = createInitialClientState();
    state = applyEvent(state, event(3, "session.message.created", { message: second }));
    state = applyEvent(state, event(2, "session.message.created", { message: first }));
    state = applyEvent(state, event(4, "session.message.part.updated", { part: secondPart }));
    state = applyEvent(state, event(5, "session.message.part.delta", {
      sessionId: "s1",
      messageId: "m2",
      partId: "p2",
      field: "text",
      delta: "ond",
    }));
    state = applyEvent(state, event(3, "session.message.created", { message: second }));

    expect(state.lastSeq).toBe(5);
    expect(state.transientCursor).toBe(5);
    expect(Object.keys(state.eventsBySeq).sort()).toEqual(["2", "3", "4"]);
    expect(state.buckets.s1?.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(state.buckets.s1?.partsByMessageId.m2?.[0]?.text).toBe("second");
  });

  it("does not append the same transient delta again after an SSE reconnect", () => {
    const delta = event(5, "session.message.part.delta", {
      sessionId: "s1",
      messageId: "m1",
      partId: "p1",
      field: "text",
      delta: "hello",
    });

    const once = applyEvent(createInitialClientState(), delta);
    const replayed = applyEvent(once, delta);

    expect(replayed).toBe(once);
    expect(replayed.buckets.s1?.partsByMessageId.m1?.[0]?.text).toBe("hello");
    expect(replayed.eventsBySeq[5]).toBeUndefined();
  });

  it("creates a placeholder part when a delta arrives before the part snapshot", () => {
    let state = createInitialClientState();
    state = applyEvent(state, event(1, "session.message.part.delta", {
      sessionId: "s1",
      messageId: "m1",
      partId: "p1",
      field: "text",
      delta: "hel",
    }));
    expect(state.buckets.s1?.partsByMessageId.m1?.[0]).toMatchObject({
      id: "p1",
      text: "hel",
      status: "running",
    });

    const part: SessionMessagePartRecord = {
      id: "p1",
      sessionId: "s1",
      messageId: "m1",
      seq: 1,
      type: "text",
      status: "running",
      text: "hello",
      metadata: {},
      createdAt: 1,
      updatedAt: 2,
    };
    state = applyEvent(state, event(2, "session.message.part.updated", { part }));
    expect(state.buckets.s1?.partsByMessageId.m1?.[0]?.text).toBe("hello");
  });

  it("appends reasoning deltas and creates a reasoning placeholder part", () => {
    let state = createInitialClientState();
    state = applyEvent(state, event(1, "session.message.part.delta", {
      sessionId: "s1",
      messageId: "m1",
      partId: "p1",
      field: "reasoning",
      delta: "先想一下",
    }));

    const part = state.buckets.s1?.partsByMessageId.m1?.[0];
    expect(part).toMatchObject({ id: "p1", type: "reasoning", text: "先想一下", status: "running" });

    state = applyEvent(state, event(2, "session.message.part.delta", {
      sessionId: "s1",
      messageId: "m1",
      partId: "p1",
      field: "reasoning",
      delta: "再动手",
    }));
    expect(state.buckets.s1?.partsByMessageId.m1?.[0]?.text).toBe("先想一下再动手");
  });

  it("updates permission state after reply and can hydrate from replayed history", () => {
    const pending: PermissionRequestRecord = {
      id: "p1",
      sessionId: "s1",
      toolName: "Bash",
      payload: {},
      status: "pending",
      createdAt: 1,
      updatedAt: 1,
    };
    const approved: PermissionRequestRecord = {
      ...pending,
      status: "approved",
      decision: "session",
      decidedByClientId: "tui-1",
      updatedAt: 2,
    };

    const state = hydrateState([
      event(1, "permission.asked", { request: pending }),
      event(2, "permission.replied", { request: approved }),
    ]);

    expect(state.buckets.s1?.permissions.p1).toMatchObject({
      status: "approved",
      decision: "session",
      decidedByClientId: "tui-1",
    });
  });
});
