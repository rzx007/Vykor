import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@vykor/agent-contracts";
import { SessionStore } from "@vykor/services";
import { DaemonAgentEventProjector } from "../daemon-agent-event-projector.js";
import { SessionTranscriptProjection } from "../../session/transcript/transcript-projection.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "vykor-lifecycle-projector-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const store = new SessionStore({ path: join(directory, "session.db") });
  cleanup.push(store.close.bind(store));
  store.sessions.create({ id: "session", cwd: directory, model: "offline", metadata: { runtime: { model: "offline" } } });
  store.conversationTransactions.admitPrompt({ id: "input", sessionId: "session", items: [{ type: "text", text: "work" }] });
  const projector = new DaemonAgentEventProjector({ projectorId: "daemon-agent:session", rootSessionId: "session", store, rootAgent: {} as any,
    transcriptProjection: new SessionTranscriptProjection(store), executionProjector: {} as any,
    liveChildren: { register() {}, unregister() {} },
    events: { checkpoint: () => store.conversations.latestEventSeq(), publish() {}, publishSince() {} }, log() {},
  });
  let sequence = 0;
  const context = { agentId: "session", sessionId: "session", runId: "run", inputId: "input", traceId: "trace" };
  const emit = (type: AgentEvent["type"], data: unknown) => projector.apply({ id: `event-${++sequence}`,
    sequence, occurredAt: new Date().toISOString(), type, data, context } as AgentEvent);
  const call = { type: "tool_use" as const, id: "call", name: "Write", input: { text: "value" } };
  await emit("run.started", {});
  await emit("tool.started", { toolUse: call });
  const lifecycle = (payload: Record<string, unknown>) => emit("domain.event", { name: "tool.lifecycle", payload: { toolUseId: "call", ...payload } });
  const part = () => store.conversations.listMessageParts("session").find(row => row.toolUseId === "call")!;
  return { store, emit, lifecycle, part };
}

describe("tool transcript identity follows the active actual call", () => {
  it("rejects unrelated and terminal-Run progress", async () => {
    const f = await fixture();
    await f.lifecycle({ toolAttemptId: "unrelated", phase: "running" });
    expect(f.part().metadata.toolProgress).toMatchObject({ phase: "preparing" });
    await f.lifecycle({ toolAttemptId: "tool_attempt_call_1", phase: "running" });
    expect(f.part().metadata).toMatchObject({ toolAttemptId: "tool_attempt_call_1", toolProgress: { phase: "running" } });
    f.store.runs.updateRun("run", { status: "interrupted" });
    await f.lifecycle({ toolAttemptId: "tool_attempt_call_1", phase: "completed", executionState: "completed" });
    expect(f.part().metadata.toolProgress).toMatchObject({ phase: "running" });
  });
  it("rejects stale generation progress even when a later call reuses the tool ID", async () => {
    const f = await fixture();
    await f.emit("output.generation.started", { generationId: "new", attempt: 1 });
    await f.emit("tool.started", { toolUse: { type: "tool_use", id: "call", name: "Write", input: {} } });
    await f.lifecycle({ generationId: "old", toolAttemptId: "tool_attempt_call_1", phase: "running" });
    expect(f.part().metadata.toolProgress).toMatchObject({ phase: "preparing" });
    await f.lifecycle({ generationId: "new", toolAttemptId: "tool_attempt_call_1", phase: "running" });
    expect(f.part().metadata.toolProgress).toMatchObject({ phase: "running" });
  });
  it("keeps pre-dispatch rejection unstarted", async () => {
    const f = await fixture();
    await f.emit("tool.completed", { toolUseId: "call", result: { toolUseId: "call", toolName: "Write", isError: true, executionState: "not_started", content: [] } });
    expect(typeof f.part().metadata.toolAttemptId).not.toBe("string");
  });
});
