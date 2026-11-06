import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunScope, ToolContext, ToolResult } from "@vykor/agent-contracts";
import { SessionStore } from "@vykor/services";
import { ApplicationEventService } from "../../../events/application-event-service.js";
import { createSessionObservationTool } from "../session-observation-tool.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
});

function fixture(targetRunId: string | null = "observed") {
  const cwd = mkdtempSync(join(tmpdir(), "session-observation-"));
  const store = new SessionStore({ path: join(cwd, "state.db") });
  const lease = store.acquireApplicationOwner({ ownerId: "observer-test", pid: process.pid, staleAfterMs: 30_000 });
  const events = new ApplicationEventService(store.conversations);
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }), () => store.close(), () => events.close());
  const createTarget = () => store.sessions.create({ id: "target", cwd, model: "test" });
  createTarget();
  const targetPrompt = targetRunId === null ? undefined : store.conversationTransactions.admitPromptWithRun({
    prompt: { sessionId: "target", items: [{ type: "text", text: "Original work" }] },
    run: { id: targetRunId },
  });
  if (targetPrompt) store.runs.updateRun(targetPrompt.run.id, { status: "running" });
  const targetMessage = targetPrompt && store.conversations.createMessage({
    sessionId: "target", role: "user", inputId: targetPrompt.input.id, runId: targetPrompt.run.id,
  });
  const replaceTargetPrompt = () => {
    if (!targetMessage) throw new Error("Expected a target prompt to replace");
    return store.conversationTransactions.replaceLatestPromptWithAdmission({
      sessionId: "target",
      sourceMessageId: targetMessage.id,
      admission: { prompt: { sessionId: "target", items: [{ type: "text", text: "Different work" }] } },
      createRun: false,
    });
  };
  store.sessions.create({ id: "source", cwd, model: "test" });
  const grant = { targetSessionId: "target", targetRunId, afterSeq: store.conversations.latestEventSeq() };
  const { input, run } = store.conversationTransactions.admitPromptWithRun({
    prompt: { sessionId: "source", delivery: "queue", items: [{ type: "text", text: "observe-session target\nWait for results." }] },
    run: { metadata: { sessionObservationGrant: grant } },
  });
  store.runs.updateRun(run.id, { status: "running" });
  const controller = new AbortController();
  const scope: AgentRunScope = {
    agentId: "source", sessionId: "source", runId: run.id, inputId: input.id, cwd, traceId: "trace", signal: controller.signal,
  };
  const tool = createSessionObservationTool({ store, events, assertApplicationOwner: store.assertApplicationOwner.bind(store, lease), accepting: () => true }, scope, grant);
  const observe = (input: Record<string, unknown> = {}, context: Partial<ToolContext> = {}) =>
    tool.execute(input, { cwd, agent: { scope } as ToolContext["agent"], ...context });
  const change = <T>(write: () => T) => {
    const before = store.conversations.latestEventSeq();
    const result = write();
    events.broadcastSince(before);
    return result;
  };
  return { store, events, observe, change, controller, scope, createTarget, replaceTargetPrompt };
}

function read(result: ToolResult): unknown {
  expect(result.isError).not.toBe(true);
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Expected a JSON text result");
  return JSON.parse(content.text);
}

describe("SessionObserve", () => {
  it("returns only the fixed target's progress even after the target starts another Run", async () => {
    const f = fixture();
    const completed = f.store.runs.updateRun("observed", { status: "completed", error: "private", metadata: { hidden: "private" } });
    f.store.runs.createRun({ id: "later", sessionId: "target" });
    expect(read(await f.observe())).toEqual({
      targetSessionId: "target",
      targetRunId: "observed",
      status: "completed",
      updatedAt: completed.updatedAt,
      pending: [],
      timedOut: false,
    });
    expect(f.events.subscriberCount).toBe(0);
  });

  it("keeps an initially idle target idle when its first Run appears", async () => {
    const f = fixture(null);
    f.store.runs.createRun({ id: "later", sessionId: "target" });
    expect(read(await f.observe({ timeoutMs: 100 }))).toMatchObject({
      targetSessionId: "target", targetRunId: null, status: "idle", pending: [], timedOut: false,
    });
    expect(f.events.subscriberCount).toBe(0);
  });

  it("releases the subscription when the target finishes", async () => {
    const f = fixture();
    const waiting = f.observe({ timeoutMs: 1_000 });
    expect(f.events.subscriberCount).toBe(1);
    f.change(() => f.store.runs.updateRun("observed", { status: "failed", error: "private failure" }));
    expect(read(await waiting)).toMatchObject({ status: "failed", pending: [], timedOut: false });
    expect(f.events.subscriberCount).toBe(0);
  });

  it("replays changes that happened after the snapshot and before subscribing", async () => {
    const f = fixture();
    const subscribe = f.events.subscribe.bind(f.events);
    vi.spyOn(f.events, "subscribe").mockImplementationOnce(options => {
      f.store.runs.updateRun("observed", { status: "interrupted", error: "private reason" });
      return subscribe(options);
    });
    expect(read(await f.observe({ timeoutMs: 100 }))).toMatchObject({ status: "interrupted", timedOut: false });
    expect(f.events.subscriberCount).toBe(0);
  });

  it("returns only actionable categories for the selected Run", async () => {
    const f = fixture();
    f.store.runs.createRun({ id: "other", sessionId: "target" });
    for (const request of [
      { toolName: "AskUser", runId: "other" },
      { toolName: "Shell", payload: { childSessionId: "child", childRunId: "child-run" } },
      { toolName: "Shell", runId: "observed", payload: { reusedApprovalRequestId: "earlier" } },
      ...["reviewing", "approved", "denied"].map(status => ({
        toolName: "Shell", runId: "observed", payload: { approvalReview: { status } },
      })),
    ]) f.store.permissions.create({ sessionId: "target", ...request });

    expect(read(await f.observe())).toMatchObject({ status: "running", pending: [], timedOut: false });
    const waiting = f.observe({ timeoutMs: 1_000 });
    f.change(() => {
      f.store.permissions.create({ sessionId: "target", runId: "observed", toolName: "AskUser", payload: { input: { kind: "question", question: "private" } } });
      f.store.permissions.create({ sessionId: "target", runId: "observed", toolName: "Shell", payload: { reason: "private" } });
    });
    expect(read(await waiting)).toMatchObject({ status: "running", pending: ["approval", "question"], timedOut: false });
    expect(f.events.subscriberCount).toBe(0);
  });

  it("wakes when automatic review changes a direct request to human approval", async () => {
    const f = fixture();
    const request = f.store.permissions.create({
      sessionId: "target", runId: "observed", toolName: "Shell", payload: { approvalReview: { status: "reviewing" } },
    });
    const waiting = f.observe({ timeoutMs: 1_000 });
    f.change(() => f.store.permissions.updatePayload(request.id, { approvalReview: { status: "ask_user" } }));
    expect(read(await waiting)).toMatchObject({ status: "running", pending: ["approval"], timedOut: false });
    expect(f.events.subscriberCount).toBe(0);
  });

  it("rejects a target recreated under the same IDs while waiting", async () => {
    const f = fixture();
    const waiting = f.observe({ timeoutMs: 1_000 });
    f.change(() => {
      f.store.conversationTransactions.deleteSessionTree("target");
      f.createTarget();
      f.store.runs.createRun({ id: "observed", sessionId: "target" });
      f.store.runs.updateRun("observed", { status: "completed" });
    });
    expect(await waiting).toMatchObject({ isError: true });
    expect(f.events.subscriberCount).toBe(0);
  });

  it("wakes when an edit removes the pinned Run", async () => {
    const f = fixture();
    vi.useFakeTimers();
    const waiting = f.observe({ timeoutMs: 1_000 });
    expect(f.events.subscriberCount).toBe(1);
    f.change(f.replaceTargetPrompt);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.events.subscriberCount).toBe(0);
    expect(await waiting).toMatchObject({ isError: true });
  });

  it("rejects a recreated Run with the same ID in the same target session", async () => {
    const f = fixture();
    vi.useFakeTimers();
    const waiting = f.observe({ timeoutMs: 1_000 });
    expect(f.events.subscriberCount).toBe(1);
    const { input } = f.replaceTargetPrompt();
    f.change(() => f.store.conversationTransactions.createReplayRun(input.id, { id: "observed" }));
    expect(await f.observe()).toMatchObject({ isError: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.events.subscriberCount).toBe(0);
    expect(await waiting).toMatchObject({ isError: true });
  });

  it("revalidates the original Run and input from the host context", async () => {
    const f = fixture();
    for (const field of ["runId", "sessionId", "inputId"] as const) {
      const agent = { scope: { ...f.scope, [field]: "foreign" } } as ToolContext["agent"];
      expect(await f.observe({}, { agent })).toMatchObject({ isError: true });
    }
    const waiting = f.observe({ timeoutMs: 1_000 });
    f.store.runs.updateRun(f.scope.runId, { status: "completed" });
    f.change(() => f.store.runs.updateRun("observed", { status: "completed" }));
    expect(await waiting).toMatchObject({ isError: true });
    expect(f.events.subscriberCount).toBe(0);
  });

  it("checks the stored grant again before returning after a wake-up", async () => {
    const f = fixture();
    const waiting = f.observe({ timeoutMs: 1_000 });
    f.store.runs.updateRun(f.scope.runId, { metadata: { sessionObservationGrant: null } });
    f.change(() => f.store.runs.updateRun("observed", { status: "completed" }));
    expect(await waiting).toMatchObject({ isError: true });
    expect(f.events.subscriberCount).toBe(0);
  });

  it.each(["tool", "run"])("cancels a wait when its %s is aborted", async kind => {
    const f = fixture();
    const toolController = new AbortController();
    const waiting = f.observe({ timeoutMs: 1_000 }, { abortSignal: toolController.signal });
    (kind === "tool" ? toolController : f.controller).abort();
    expect(await waiting).toMatchObject({ isError: true });
    expect(f.store.runs.getRun("observed")?.status).toBe("running");
    expect(f.events.subscriberCount).toBe(0);
  });

  it("returns a timed-out snapshot when the target stays running", async () => {
    const f = fixture();
    expect(read(await f.observe({ timeoutMs: 10 }))).toMatchObject({ status: "running", pending: [], timedOut: true });
    expect(f.events.subscriberCount).toBe(0);
  });

  it("caps a requested wait at thirty seconds", async () => {
    const f = fixture();
    vi.useFakeTimers();
    const waiting = f.observe({ timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.events.subscriberCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.events.subscriberCount).toBe(0);
    expect(read(await waiting)).toMatchObject({ status: "running", timedOut: true });
  });

  it("reads again at the tool deadline even if the last change was not broadcast", async () => {
    const f = fixture();
    vi.useFakeTimers();
    const waiting = f.observe({ timeoutMs: 30_000 }, { deadlineAt: Date.now() + 100 });
    await vi.advanceTimersByTimeAsync(10);
    f.store.runs.updateRun("observed", { status: "completed" });
    await vi.advanceTimersByTimeAsync(89);
    expect(f.events.subscriberCount).toBe(0);
    expect(read(await waiting)).toMatchObject({ status: "completed", timedOut: false });
  });

  it("returns a retryable error when the event stream closes", async () => {
    const f = fixture();
    const waiting = f.observe({ timeoutMs: 1_000 });
    f.events.close();
    expect(await waiting).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringMatching(/retry/i) }],
    });
    expect(f.events.subscriberCount).toBe(0);
  });

  it("rejects extra arguments and invalid timeouts", async () => {
    const f = fixture();
    for (const args of [{ targetSessionId: "another" }, { timeoutMs: -1 }, { timeoutMs: NaN }, { timeoutMs: "10" }]) {
      expect(await f.observe(args)).toMatchObject({ isError: true });
    }
    expect(f.events.subscriberCount).toBe(0);
  });
});
