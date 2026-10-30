import { describe, expect, it, vi } from "vitest";
import * as state from "../index.js";
import type { SessionEventRecord, SessionRunRecord, SessionStateSnapshot } from "../../types/index.js";
import type { SyncEventsClient } from "../sync.js";
import { VykorClient } from "../../transport/http-client.js";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/protocol";

const run = (id: string, status: SessionRunRecord["status"]): SessionRunRecord => ({
  id, sessionId: "session-1", inputId: "input-1", status, metadata: {}, createdAt: 1, startedAt: 2, updatedAt: 3,
});
const snapshot = (runs: SessionRunRecord[]): SessionStateSnapshot => ({
  cursor: 1,
  session: { id: "session-1", cwd: "/repo", title: "Agent", model: "configured", status: "idle", metadata: {}, createdAt: 1, updatedAt: 1 },
  inputs: [], runs, attempts: [], tasks: [], permissions: [],
  messages: [
    { id: "answer", sessionId: "session-1", seq: 1, role: "assistant", runId: "target", metadata: {}, createdAt: 1, updatedAt: 1 },
    { id: "unrelated", sessionId: "session-1", seq: 2, role: "assistant", runId: "another", metadata: {}, createdAt: 1, updatedAt: 1 },
  ],
  parts: [{ id: "text", sessionId: "session-1", messageId: "answer", seq: 1, type: "text", status: "completed", text: "finished", metadata: {}, createdAt: 1, updatedAt: 1 }],
});

describe("waitForRun", () => {
  it("cancels the HTTP response body when its target finishes on an open SSE connection", async () => {
    let cancelled = false;
    let requestSignal: AbortSignal | null | undefined;
    const client = new VykorClient({ baseUrl: "http://daemon", fetch: async (url, init) => {
      if (String(url).endsWith("/capabilities")) return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
      if (String(url).includes("/state")) return Response.json(snapshot([run("target", "running")]));
      requestSignal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const event: SessionEventRecord = { id: "done", seq: 2, schemaVersion: 1, sessionId: "session-1", type: "session.run.updated", payload: { run: run("target", "completed") }, createdAt: 4 };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        },
        cancel() { cancelled = true; },
      }));
    } });
    const result = await state.waitForRun(client, { sessionId: "session-1", runId: "target" });
    expect(result.run.status).toBe("completed");
    expect(cancelled).toBe(true);
    expect(requestSignal?.aborted).toBe(true);
  });

  it.each(["completed", "failed", "interrupted"] as const)("returns a %s snapshot for the requested run without opening a stream", async status => {
    let streams = 0;
    const client: SyncEventsClient = {
      sessions: { getState: async () => snapshot([run("another", "completed"), run("target", status)]) },
      events: { list: async () => [], stream: async function* () { streams++; } },
    };
    expect(state.waitForRun).toBeTypeOf("function");
    const result = await state.waitForRun(client, { sessionId: "session-1", runId: "target" });
    expect(result.run.status).toBe(status);
    expect(result.messages.map(item => item.message.id)).toEqual(["answer"]);
    expect(result.messages[0]?.parts[0]?.text).toBe("finished");
    expect(streams).toBe(0);
  });

  it("waits for its own terminal event and closes its iterator", async () => {
    let closed = false;
    const event = (seq: number, value: SessionRunRecord): SessionEventRecord => ({
      id: `event-${seq}`, seq, schemaVersion: 1, sessionId: "session-1", type: "session.run.updated", payload: { run: value }, createdAt: seq,
    });
    const client: SyncEventsClient = {
      sessions: { getState: async () => snapshot([run("target", "running")]) },
      events: { list: async () => [], stream: async function* () {
        try { yield event(2, run("another", "completed")); yield event(3, run("target", "completed")); }
        finally { closed = true; }
      } },
    };
    expect(state.waitForRun).toBeTypeOf("function");
    const result = await state.waitForRun(client, { sessionId: "session-1", runId: "target" });
    expect(result.run.id).toBe("target");
    expect(result.run.status).toBe("completed");
    expect(closed).toBe(true);
  });

  it("rejects cancellation without interrupting the daemon run", async () => {
    const abort = new AbortController();
    abort.abort(new Error("caller stopped waiting"));
    let reads = 0;
    const client: SyncEventsClient = {
      sessions: { getState: async () => { reads++; return snapshot([run("target", "running")]); } },
      events: { list: async () => [], stream: async function* () {} },
    };
    expect(state.waitForRun).toBeTypeOf("function");
    await expect(state.waitForRun(client, { sessionId: "session-1", runId: "target", signal: abort.signal })).rejects.toThrow("caller stopped waiting");
    expect(reads).toBe(0);
  });

  it("recovers completion from a refreshed snapshot after a dropped connection", async () => {
    let reads = 0;
    let streams = 0;
    const client: SyncEventsClient = {
      sessions: { getState: async () => { reads++; return { ...snapshot([run("target", reads === 1 ? "running" : "completed")]), cursor: reads }; } },
      events: { list: async () => [], stream: async function* () { streams++; throw new Error("connection lost"); } },
    };
    const result = await state.waitForRun(client, { sessionId: "session-1", runId: "target" });
    expect(result.run.status).toBe("completed");
    expect(reads).toBe(2);
    expect(streams).toBe(1);
  });

  it("rejects when the session was deleted while its run observer was disconnected", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    try {
      let reads = 0;
      const client = new VykorClient({ baseUrl: "http://daemon", fetch: async url => {
        if (String(url).endsWith("/capabilities")) return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
        if (String(url).includes("/state")) {
          if (++reads === 1) return Response.json(snapshot([run("target", "running")]));
          return Response.json({ error: "Session not found" }, { status: 404 });
        }
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.error(new TypeError("connection lost")); },
        }));
      } });
      const pending = state.waitForRun(client, { sessionId: "session-1", runId: "target", signal: abort.signal })
        .catch(error => error);
      setTimeout(() => abort.abort(new Error("observation did not stop after session deletion")), 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toMatchObject({ name: "VykorApiError", status: 404, body: { error: "Session not found" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a live observer on cancellation", async () => {
    const abort = new AbortController();
    let opened!: () => void;
    const ready = new Promise<void>(resolve => { opened = resolve; });
    let closed = false;
    const client: SyncEventsClient = {
      sessions: { getState: async () => snapshot([run("target", "running")]) },
      events: { list: async () => [], stream: async function* (options) {
        try {
          await new Promise<void>(resolve => {
            options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            opened();
          });
        } finally { closed = true; }
      } },
    };
    const pending = state.waitForRun(client, { sessionId: "session-1", runId: "target", signal: abort.signal });
    await ready;
    abort.abort(new Error("stop observer"));
    await expect(pending).rejects.toThrow("stop observer");
    expect(closed).toBe(true);
  });
});
