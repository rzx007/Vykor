import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { VykorClient, syncEvents } from "../../../../client/src/index.js";
import { SessionTranscriptProjection } from "../../application/session/transcript-projection.js";
import { buildAgentTranscript } from "../../application/agent/agent-transcript.js";
import { VykorHttpServer } from "../server.js";
import { CURRENT_PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from "@vykor/protocol";

// Fixed ASCII bodies; full-body counts distinguish previews from complete sends.
const writeBody = "WRITE_BODY_".repeat(10_000);
const oldBody = "EDIT_OLD_".repeat(10_000);
const newBody = "EDIT_NEW_".repeat(10_000);
const shellBody = "SHELL_ERROR_".repeat(10_000);
const bodies = [writeBody, oldBody, newBody, shellBody];
function measure(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { bytes: Buffer.byteLength(text), fullBodies: bodies.map(body => text.split(body).length - 1) };
}

it("measures fixed long tool bodies at real HTTP snapshot, history, replay and ordinary update boundaries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oh-part-summary-"));
  vi.stubEnv("VYKOR_CONFIG_DIR", join(directory, "config"));
  const server = new VykorHttpServer({ storePath: join(directory, "sessions.db"), logger: () => {} });
  try {
    await server.application.ready();
    const client = new VykorClient({ baseUrl: "http://daemon.test", fetch: async (input, init) => server.app.request(String(input), init) });
    const session = await client.sessions.create({ cwd: directory, model: "test-model" });
    const projection = new SessionTranscriptProjection(server.store);
    const state = projection.beginRun(session.id, "input", "run", { id: "input", sessionId: session.id, seq: 1, delivery: "queue", items: [], content: "", attachments: [], metadata: { transcriptVisibility: "hidden" }, createdAt: 1 });
    for (const [id, name, input, result] of [
      ["write", "Write", { file_path: "sample.ts", content: writeBody }, { content: [{ type: "text", text: "written" }] }],
      ["edit", "Edit", { file_path: "sample.ts", old_string: oldBody, new_string: newBody }, { content: [{ type: "text", text: "edited" }] }],
      ["shell", "Shell", { command: "fixture" }, { content: [{ type: "text", text: shellBody }], isError: true, failureKind: "command", executionState: "completed", recoveryHint: "inspect stderr", metadata: { outputResourceUri: "shell-output://fixture" } }],
    ] as const) {
      projection.projectStreamEvent(state, { type: "tool_use_start", toolUse: { id, name, input } });
      projection.projectStreamEvent(state, { type: "tool_use_end", toolUseId: id, result: result as any });
      server.store.conversations.upsertMessagePart({ id, sessionId: session.id, messageId: state.assistantMessageId!, type: "tool", metadata: { ordinaryStatusUpdate: true } });
    }
    const urls = { snapshot: `/sessions/${session.id}/state`, history: `/sessions/${session.id}/parts?limit=3`, replay: `/events?sessionId=${session.id}`, updates: `/events?sessionId=${session.id}` };
    const measurements: Record<string, unknown> = {};
    for (const [name, url] of Object.entries(urls)) {
      const response = await server.app.request(url, { headers: { [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION) } });
      expect(response.status).toBe(200);
      const payload = await response.json();
      measurements[name] = measure(name === "updates" ? payload.events.filter((event: any) => event.type === "session.message.part.updated") : payload);
    }
    console.log("FIXED_SAMPLE_FULL", JSON.stringify(measurements));
    const summaries: Record<string, unknown> = {};
    for (const [name, url] of Object.entries(urls)) {
      const response = await server.app.request(`${url}${url.includes("?") ? "&" : "?"}partView=summary`, { headers: { [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION) } });
      const payload = await response.json();
      summaries[name] = measure(name === "updates" ? payload.events.filter((event: any) => event.type === "session.message.part.updated") : payload);
    }
    console.log("FIXED_SAMPLE_SUMMARY", JSON.stringify(summaries));
    expect((summaries.snapshot as ReturnType<typeof measure>).fullBodies).toEqual([0, 0, 0, 0]);
    expect((summaries.updates as ReturnType<typeof measure>).bytes).toBeLessThan(30_000);
    for (const entry of Object.values(summaries)) expect((entry as ReturnType<typeof measure>).fullBodies).toEqual([0, 0, 0, 0]);
    const summarySnapshot = await client.sessions.getState(session.id, { partView: "summary" });
    const write = summarySnapshot.parts.find(part => part.id === "write")!;
    expect(write.bodyView).toEqual({ input: "preview", output: "full" });
    const fullWrite = await client.sessions.getMessagePart(session.id, write.messageId, write.id);
    expect(fullWrite.input?.content).toBe(writeBody);
    expect(fullWrite).not.toHaveProperty("bodyView");
    await expect(client.sessions.getMessagePart(session.id, "wrong-message", write.id)).rejects.toMatchObject({ status: 404 });
    await expect(client.sessions.getMessagePart(session.id, write.messageId, "missing")).rejects.toMatchObject({ status: 404 });
    const other = await client.sessions.create({ cwd: directory, model: "test-model" });
    await expect(client.sessions.getMessagePart(other.id, write.messageId, write.id)).rejects.toMatchObject({ status: 404 });
    const page = await client.sessions.listMessageParts(session.id, { partView: "summary", afterSeq: write.seq, limit: 1 });
    expect(page.map(part => part.id)).toEqual(["edit"]);
    expect(page[0]?.bodyView?.input).toBe("preview");

    // Real SSE replay followed by a real ordinary status update uses the same projection.
    const abort = new AbortController();
    const iterator = client.events.stream({ sessionId: session.id, cursor: 0, partView: "summary", signal: abort.signal })[Symbol.asyncIterator]();
    const replayEvents: unknown[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) throw new Error("SSE ended early");
      replayEvents.push(next.value);
      if (next.value.seq === summarySnapshot.cursor) break;
    }
    expect(measure(replayEvents).fullBodies).toEqual([0, 0, 0, 0]);
    const liveCursor = server.store.conversations.latestEventSeq();
    server.store.conversations.upsertMessagePart({ id: "shell", sessionId: session.id, messageId: write.messageId, type: "tool", metadata: { ordinaryStatusUpdate: "live" } });
    server.application.events.broadcastSince(liveCursor);
    const live = (await iterator.next()).value!;
    expect(live.type).toBe("session.message.part.updated");
    expect(measure(live).fullBodies).toEqual([0, 0, 0, 0]);
    expect(live.payload.part).toMatchObject({ status: "failed", isError: true, bodyView: { output: "preview", outputReferences: ["shell-output://fixture"] }, metadata: { failureKind: "command", executionState: "completed" } });
    console.log("FIXED_SAMPLE_SSE", JSON.stringify({ replay: measure(replayEvents), liveUpdate: measure(live) }));
    abort.abort();
    await iterator.return?.();

    const reconnectSources: string[] = [];
    for await (const update of syncEvents({ sessions: client.sessions, events: { list: options => client.events.list(options), stream: async function* () {} } }, { sessionId: session.id, partView: "summary", reconnectDelayMs: () => 0 })) {
      reconnectSources.push(update.source);
      expect(measure(update.state.buckets[session.id]?.partsByMessageId).fullBodies).toEqual([0, 0, 0, 0]);
      if (reconnectSources.length === 3) break;
    }
    expect(reconnectSources).toEqual(["snapshot", "reconnecting", "snapshot"]);
    const snapshot = await client.sessions.getState(session.id);
    expect(snapshot.parts.find(part => part.id === "write")?.input?.content).toBe(writeBody);
    expect(snapshot.parts.find(part => part.id === "shell")?.output).toMatchObject({ content: [{ text: shellBody }] });
    const modelHistory = buildAgentTranscript(server.store.conversations.listMessages(session.id), server.store.conversations.listMessageParts(session.id));
    expect(measure(modelHistory.messages).fullBodies).toEqual([1, 1, 1, 1]);
    const replaced = server.store.conversations.appendEvent({ type: "session.transcript.replaced", sessionId: session.id, payload: { messages: snapshot.messages, parts: snapshot.parts } });
    const replacedSummary = await client.events.list({ sessionId: session.id, afterSeq: replaced.seq - 1, partView: "summary" });
    expect(measure(replacedSummary).fullBodies).toEqual([0, 0, 0, 0]);
    expect((await client.events.list({ sessionId: session.id, afterSeq: replaced.seq - 1 }))[0]?.payload.parts).toEqual(snapshot.parts);
  } finally {
    await server.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
