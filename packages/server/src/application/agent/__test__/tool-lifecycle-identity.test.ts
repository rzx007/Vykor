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
  const directory = mkdtempSync(join(tmpdir(), "vykor-s1-projector-"));
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
  const intent = { toolUse: call, toolIdentity: "fixture/write@1", scope: {
    ...context, cwd: directory, signal: new AbortController().signal,
  } };
  const operation = store.toolOperations.prepare(intent);
  const lifecycle = (payload: Record<string, unknown>) => emit("domain.event", { name: "tool.lifecycle", payload: { toolUseId: "call", ...payload } });
  const part = () => store.conversations.listMessageParts("session").find(row => row.toolUseId === "call")!;
  return { store, emit, lifecycle, part, intent, operation };
}

describe("tool transcript identity follows actual operation receipts", () => {
  it("does not invent an attempt when validation rejects a call before operation preparation", async () => {
    const f = await fixture();
    await f.emit("tool.completed", { toolUseId: "call", result: {
      toolUseId: "call", toolName: "Write", isError: true, executionState: "not_started",
      content: [{ type: "text", text: "invalid parameters" }],
    } });
    expect(typeof f.part().metadata.toolAttemptId).not.toBe("string");
  });
  it("shows a persisted approval wait without inventing an execution attempt", async () => {
    const f = await fixture();
    expect(f.part().metadata.toolAttemptId).toBeUndefined();
    await f.lifecycle({ operationId: f.operation.operationId, phase: "waiting_permission", executionState: "not_started" });
    expect(f.part().metadata).toMatchObject({ operationId: f.operation.operationId,
      toolProgress: { phase: "waiting_permission", executionState: "not_started" } });
    expect(f.part().metadata.toolAttemptId).toBeUndefined();
    await f.emit("tool.completed", { toolUseId: "call", result: {
      operationId: f.operation.operationId, toolUseId: "call", toolName: "Write", isError: true,
      executionState: "not_started", content: [{ type: "text", text: "denied" }],
    } });
    expect(f.part().metadata.operationId).toBe(f.operation.operationId);
    expect(typeof f.part().metadata.toolAttemptId).not.toBe("string");
  });

  it("binds the persisted dispatch attempt and rejects unrelated or regressive lifecycle updates", async () => {
    const f = await fixture();
    const authorized = f.store.toolOperations.authorize({ intent: f.intent, operation: f.operation, policyVersion: "policy-v1" });
    const receipt = f.store.toolOperations.dispatch({ intent: f.intent, operation: authorized, policyVersion: "policy-v1", ownerId: "owner" });
    await f.lifecycle({ operationId: receipt.operationId, toolAttemptId: "unrelated-attempt", phase: "running" });
    expect(f.part().metadata.toolProgress).toMatchObject({ phase: "preparing" });
    await f.lifecycle({ ...receipt, phase: "running" });
    expect(f.part().metadata).toMatchObject({ operationId: receipt.operationId, toolAttemptId: receipt.toolAttemptId,
      toolProgress: { phase: "running" } });
    await f.lifecycle({ operationId: receipt.operationId, phase: "waiting_permission", executionState: "not_started" });
    expect(f.part().metadata.toolProgress).toMatchObject({ phase: "running" });
    f.store.runs.updateRun("run", { status: "interrupted" });
    await f.lifecycle({ ...receipt, phase: "completed", executionState: "completed" });
    expect(f.part().metadata.toolProgress).toMatchObject({ phase: "running" });
  });
});
