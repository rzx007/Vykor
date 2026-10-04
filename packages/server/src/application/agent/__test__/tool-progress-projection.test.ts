import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentEventInput } from "@vykor/core";
import type { SessionEventRecord } from "@vykor/protocol";
import { SessionStore } from "@vykor/services";
import { applyEvents, createInitialClientState, syncEvents } from "@vykor/client";
import { SessionTranscriptProjection } from "../../session/transcript-projection.js";
import { DaemonAgentEventProjector } from "../daemon-agent-event-projector.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

async function harness() {
  const directory = mkdtempSync(join(tmpdir(), "vykor-tool-progress-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SessionStore({ path: join(directory, "session.db") });
  cleanup.push(() => store.close());
  const session = store.sessions.create({ cwd: directory, model: "test", metadata: { runtime: { model: "test" } } });
  const published: SessionEventRecord[] = [];
  const projector = new DaemonAgentEventProjector({
    rootAgent: {} as any, store, transcriptProjection: new SessionTranscriptProjection(store),
    executionProjector: {} as any, liveChildren: { register() {}, unregister() {} },
    events: { checkpoint: () => store.conversations.latestEventSeq(),
      publish(event) { published.push(event); },
      publishSince(cursor) { published.push(...store.conversations.listEvents({ afterSeq: cursor })); } }, log() {},
  });
  let sequence = 0;
  const emit = (event: AgentEventInput) => projector.apply({ ...event, id: `event-${++sequence}`, sequence,
    occurredAt: new Date().toISOString(), context: { agentId: "agent", sessionId: session.id, runId: "run", inputId: "input" },
  } as AgentEvent);
  await emit({ type: "input.accepted", data: { content: "work", delivery: "queue" } });
  await emit({ type: "run.started", data: {} });
  await emit({ type: "output.generation.started", data: { generationId: "gen", attempt: 1 } });
  const progress = (overrides: Record<string, unknown> = {}) => emit({ type: "domain.event", data: {
    name: "tool.generation.progress", payload: { generationId: "gen", attempt: 1, toolKey: "0", toolName: "Write", receivedChars: 8192, ...overrides },
  } });
  const start = (id = "call") => emit({ type: "tool.started", data: { toolUse: { type: "tool_use", id, name: "Write", input: { file_path: "a.ts", content: "body" } } } });
  const lifecycle = (phase: string, overrides: Record<string, unknown> = {}) => emit({ type: "domain.event", data: {
    name: "tool.lifecycle", payload: { toolUseId: "call", toolAttemptId: "tool_attempt_call_1", phase, ...overrides },
  } });
  return { store, session, emit, progress, start, lifecycle, published,
    run: () => store.runs.getRun("run")!, part: () => store.conversations.listMessageParts(session.id).find(p => p.toolUseId === "call")!,
  };
}

describe("tool progress projection", () => {
  it("clears an explicitly withdrawn path while retaining an omitted path and other calls", async () => {
    const h = await harness();
    await h.progress({ toolKey: "a", filePath: "fake.html" });
    await h.progress({ toolKey: "b", filePath: "other.html" });
    await h.progress({ toolKey: "a", receivedChars: 9000 });
    expect(h.run().metadata.toolGeneration).toEqual([
      expect.objectContaining({ toolKey: "a", filePath: "fake.html" }),
      expect.objectContaining({ toolKey: "b", filePath: "other.html" }),
    ]);
    await h.progress({ toolKey: "a", receivedChars: 9100, filePath: null });
    const client = applyEvents(createInitialClientState(), h.published);
    expect(client.buckets[h.session.id]?.runs.run?.metadata.toolGeneration).toEqual([
      expect.not.objectContaining({ filePath: "fake.html" }),
      expect.objectContaining({ toolKey: "b", filePath: "other.html" }),
    ]);
    expect((h.run().metadata.toolGeneration as any[])[0]).not.toHaveProperty("filePath");
  });
  it("omits path summaries for non-file tools", async () => {
    const h = await harness();
    await h.progress({ toolName: "Shell", filePath: "fake.html" });
    expect(h.run().metadata.toolGeneration).toEqual([expect.not.objectContaining({ filePath: "fake.html" })]);
  });
  it("streams only a bounded safe path and removes only the discarded invocation", async () => {
    const h = await harness();
    await h.progress({ toolKey: "a", filePath: "C:/fixture/index.html", raw: "PRIVATE BODY" });
    await h.progress({ toolKey: "b", filePath: "other.html" });
    const client = applyEvents(createInitialClientState(), h.published);
    expect(client.buckets[h.session.id]?.runs.run?.metadata.toolGeneration).toEqual([
      expect.objectContaining({ toolKey: "a", filePath: "C:/fixture/index.html" }),
      expect.objectContaining({ toolKey: "b", filePath: "other.html" }),
    ]);
    expect(JSON.stringify(h.run().metadata)).not.toContain("PRIVATE BODY");
    const persistedRun = (h.store as any).storage.database.connection.prepare("SELECT metadata_json FROM session_run WHERE id = ?").get("run");
    expect(persistedRun.metadata_json).not.toMatch(/PRIVATE BODY|C:\/fixture\/index.html/);
    expect(JSON.parse(persistedRun.metadata_json).toolGeneration).toEqual([]);
    expect(h.store.conversations.listMessageParts(h.session.id).filter(part => part.type === "tool")).toEqual([]);
    await h.progress({ toolKey: "a", receivedChars: 0, discarded: true });
    expect(h.run().metadata.toolGeneration).toEqual([expect.objectContaining({ toolKey: "b" })]);
    await h.progress({ toolKey: "missing", discarded: true });
    expect(h.run().metadata.toolGeneration).toHaveLength(1);
  });

  it.each(["a\n.html", "a\u007f.html", "x".repeat(4097), 123])( "omits unsafe path metadata (case %#)", async filePath => {
    const h = await harness();
    await h.progress({ filePath });
    expect(h.run().metadata.toolGeneration).toEqual([expect.not.objectContaining({ filePath })]);
  });
  it("publishes 240 isolated progress snapshots without retained history, dirty mutations or full-state transactions", async () => {
    const h = await harness();
    const storage = (h.store as any).storage;
    const atomic = vi.spyOn(storage.coordinator, "atomic");
    const dirtyRun = vi.spyOn(storage.mutations.runs, "add");
    const dirtySession = vi.spyOn(storage.mutations.sessions, "add");
    const before = h.store.conversations.latestEventSeq();
    const publishedBefore = h.published.length;
    for (let receivedChars = 1; receivedChars <= 240; receivedChars++) await h.progress({ receivedChars });
    expect(h.run().metadata.toolGeneration).toEqual([expect.objectContaining({ receivedChars: 240 })]);
    const retained = h.store.conversations.listEvents({ afterSeq: before });
    expect(retained.filter(event => event.type === "session.run.updated")).toHaveLength(0);
    expect(atomic).toHaveBeenCalledTimes(0);
    expect(dirtyRun).toHaveBeenCalledTimes(0);
    expect(dirtySession).toHaveBeenCalledTimes(0);
    const live = h.published.slice(publishedBefore);
    expect(live).toHaveLength(240);
    expect(live.map(event => event.seq)).toEqual(Array.from({ length: 240 }, (_, i) => before + i + 1));
    expect((live[0]!.payload.run as any).metadata.toolGeneration).toEqual([expect.objectContaining({ receivedChars: 1 })]);
    const client = applyEvents(createInitialClientState(), h.published);
    expect(client.buckets[h.session.id]?.runs.run?.metadata.toolGeneration).toEqual(h.run().metadata.toolGeneration);
  });

  it("recovers missed transient progress from the real session snapshot after reconnect", async () => {
    const h = await harness();
    await h.progress({ receivedChars: 1 });
    const beforeDisconnect = h.store.conversationTransactions.getSessionState(h.session.id);
    let connections = 0;
    const client = {
      sessions: { getState: async () => h.store.conversationTransactions.getSessionState(h.session.id) },
      events: {
        list: async () => [],
        stream: async function* () {
          if (++connections === 1) await h.progress({ receivedChars: 240 });
        },
      },
    };
    const snapshots = [];
    for await (const update of syncEvents(client, { sessionId: h.session.id, reconnectDelayMs: () => 0 })) {
      if (update.source === "snapshot") snapshots.push(update.state);
      if (snapshots.length === 2) break;
    }
    expect(snapshots[0]!.buckets[h.session.id]?.runs.run?.metadata.toolGeneration).toEqual([expect.objectContaining({ receivedChars: 1 })]);
    expect(snapshots[1]!.buckets[h.session.id]?.runs.run?.metadata.toolGeneration).toEqual([expect.objectContaining({ receivedChars: 240 })]);
    expect(h.store.conversations.listEvents({ afterSeq: beforeDisconnect.cursor })).toEqual([]);
  });

  it("overwrites cumulative generation counts without creating executable tool parts or duplicate domain records", async () => {
    const h = await harness();
    await h.progress();
    await h.progress({ receivedChars: 9000, toolUseId: "call" });
    expect(h.run().metadata.toolGeneration).toEqual([{ generationId: "gen", attempt: 1, toolKey: "0", toolName: "Write", toolUseId: "call", receivedChars: 9000 }]);
    expect(h.store.conversations.listMessageParts(h.session.id).filter(p => p.type === "tool")).toEqual([]);
    const events = h.store.conversations.listEvents({ sessionId: h.session.id });
    expect(events.filter(e => e.type === "agent.domain.event")).toEqual([]);
    const client = applyEvents(createInitialClientState(), h.published);
    expect(client.buckets[h.session.id]?.runs.run?.metadata.toolGeneration).toEqual(h.run().metadata.toolGeneration);
    await h.start();
    expect(h.run().metadata.toolGeneration).toEqual([]);
    expect(h.part().metadata.toolProgress).toEqual({ phase: "preparing", executionState: "not_started" });
  });

  it("rejects old attempts, settled attempts, invalid counts and excess active entries", async () => {
    const h = await harness();
    await h.progress({ attempt: 0 });
    await h.progress({ generationId: "old" });
    await h.progress({ receivedChars: -1 });
    expect(h.run().metadata.toolGeneration ?? []).toEqual([]);
    for (let i = 0; i < 34; i++) await h.progress({ toolKey: `${i}` });
    expect(h.run().metadata.toolGeneration).toHaveLength(32);
    await h.emit({ type: "model.attempt.finished", data: { generationId: "gen", attempt: 1, status: "failed", usageStatus: "unknown" } });
    expect(h.run().metadata.toolGeneration).toEqual([]);
    await h.progress();
    expect(h.run().metadata.toolGeneration).toEqual([]);
    await h.emit({ type: "output.generation.started", data: { generationId: "gen", attempt: 2 } });
    await h.progress();
    expect(h.run().metadata.toolGeneration).toEqual([]);
    await h.progress({ attempt: 2 });
    expect(h.run().metadata.toolGeneration).toHaveLength(1);
    await h.emit({ type: "run.completed", data: { output: "done" } });
    await h.progress({ attempt: 2 });
    expect(h.run().metadata.toolGeneration).toEqual([]);
  });

  it("binds lifecycle to a committed call and attempt, replaces its fields, and cannot revive returned or terminal tools", async () => {
    const h = await harness();
    await h.lifecycle("running");
    expect(h.part()).toBeUndefined();
    await h.start();
    await h.lifecycle("waiting_permission", { executionState: "not_started" });
    expect(h.part().metadata.toolProgress).toEqual({ phase: "waiting_permission", executionState: "not_started" });
    await h.lifecycle("running", { toolAttemptId: "other" });
    expect(h.part().metadata.toolProgress).toMatchObject({ phase: "waiting_permission" });
    await h.lifecycle("running");
    expect(h.part().metadata.toolProgress).toEqual({ phase: "running" });
    await h.lifecycle("completed", { executionState: "completed" });
    await h.lifecycle("queued");
    expect(h.part().metadata.toolProgress).toEqual({ phase: "completed", executionState: "completed" });
    await h.emit({ type: "tool.completed", data: { toolUseId: "call", result: { content: [{ type: "text", text: "done" }] } } });
    expect(h.part().metadata.toolProgress).toBeNull();
    await h.lifecycle("running");
    expect(h.part().status).toBe("completed");
    expect(h.part().metadata.toolProgress).toBeNull();
  });

  it.each(["preparing", "waiting_permission", "queued", "running", "completed"])("preserves execution truth when a %s tool is interrupted or recovered", async phase => {
    const h = await harness();
    await h.start();
    await h.lifecycle(phase, phase === "completed" ? { executionState: "completed" } : {});
    h.store.conversationTransactions.interruptActiveRuns("restart");
    const knownNotStarted = ["preparing", "waiting_permission", "queued"].includes(phase);
    expect(h.part().metadata.executionState).toBe(knownNotStarted ? "not_started" : phase === "completed" ? "completed" : "unknown");
    expect(h.part().metadata.toolProgress).toBeNull();
    expect(h.run().metadata.toolGeneration).toEqual([]);
    expect(h.part().status).not.toBe("running");
  });

  it("closes a queued tool as not started on cancellation", async () => {
    const h = await harness();
    await h.progress();
    await h.start();
    await h.lifecycle("queued");
    await h.emit({ type: "run.interrupted", data: { error: { name: "Error", message: "stopped" } } });
    expect(h.part()).toMatchObject({ status: "interrupted", metadata: { executionState: "not_started", toolProgress: null } });
    expect(h.run().metadata.toolGeneration).toEqual([]);
  });

  it("clears generation on retry and refuses delayed progress while waiting for the next attempt", async () => {
    const h = await harness();
    await h.progress();
    await h.emit({ type: "model.retry.scheduled", data: { generationId: "gen", attempt: 1, retryNumber: 1, maxRetries: 2,
      reason: "network", nextRetryAt: Date.now() + 1000, recoveryDeadlineAt: Date.now() + 5000 } });
    expect(h.run().metadata.toolGeneration).toEqual([]);
    await h.progress();
    expect(h.run().metadata.toolGeneration).toEqual([]);
  });

  it("does not classify an executing tool as unstarted because of inconsistent stale facts", async () => {
    const h = await harness();
    await h.start();
    await h.lifecycle("running", { executionState: "not_started" });
    h.store.conversationTransactions.interruptActiveRuns("restart");
    expect(h.part().metadata.executionState).toBe("unknown");
  });
});
