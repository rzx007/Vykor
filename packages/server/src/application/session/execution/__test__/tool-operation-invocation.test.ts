import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentEventInput, AgentExecutionContext, ToolDefinition, ToolResult } from "@vykor/agent-contracts";
import { executeCheckedTools, ToolRegistry } from "@vykor/core";
import { SessionStore } from "@vykor/services";
import { ToolOperationService } from "../tool-operation-service.js";
import { ToolOperationReviewService } from "../tool-operation-review-service.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "tool-invocation-review-"));
  cleanups.push(() => {
    const target = resolve(directory), child = relative(resolve(tmpdir()), target);
    if (!child || child.startsWith("..") || isAbsolute(child) || !target.includes("tool-invocation-review-")) throw new Error("Unsafe temporary cleanup");
    rmSync(target, { recursive: true, force: true });
  });
  const store = new SessionStore({ path: join(directory, "state.db") });
  cleanups.push(() => store.close());
  const lease = store.acquireApplicationOwner({ ownerId: "owner", pid: process.pid, staleAfterMs: 30000 });
  store.sessions.create({ id: "s", cwd: directory, model: "m" });
  store.runs.createRun({ id: "r", sessionId: "s" });
  store.runs.updateRun("r", { status: "running" });
  const service = new ToolOperationService({ store, ownerLease: () => lease });
  const review = new ToolOperationReviewService({ store, ownerLease: () => lease, accepting: () => true, reconcile: input => service.reconcile(input) });
  const controller = new AbortController();
  let finish!: (result: ToolResult) => void;
  let reject!: (error: Error) => void;
  let calls = 0;
  const registry = new ToolRegistry();
  registry.register({ name: "Write", description: "Non-cooperative external write", inputSchema: { type: "object" },
    execute: () => { calls++; return new Promise<ToolResult>((resolve, rejectResult) => { finish = resolve; reject = rejectResult; }); },
  } satisfies ToolDefinition);
  const events: AgentEventInput[] = [];
  const execution: AgentExecutionContext = {
    toolSafety: service, scope: { agentId: "s", sessionId: "s", runId: "r", inputId: "i", cwd: directory, traceId: "t", signal: controller.signal },
    profile: { executableHooks: false }, effects: { requestPermission: async () => ({ status: "approved" }) },
    children: {} as AgentExecutionContext["children"], emit: async event => { events.push(event); }, takeSteeredInputs: async () => [], closeSteering() {},
  };
  const run = () => executeCheckedTools({ toolUses: [{ type: "tool_use", id: "call", name: "Write", input: {} }], toolRegistry: registry,
    timeoutMs: 10, execution, permissionChecker: { checkTool: async () => ({ action: "allow" }) },
    hookExecutor: { register() {}, execute: async () => ({ blocked: false }) }, createToolContext: () => ({ cwd: directory }), isTrustedSummary: () => false });
  const current = () => store.toolOperations.list({ runId: "r" })[0]!;
  const terminal = () => store.runs.updateRun("r", { status: "failed" });
  const reconcile = (outcome: "applied" | "not_applied" | "unknown") => review.reconcile("s", current().operationId, {
    expectedRevision: current().revision, outcome, evidence: "Human read-only observation",
    ...(outcome === "applied" ? { result: { toolUseId: "call", toolName: "Write", executionState: "completed" as const, content: [{ type: "text" as const, text: "observed" }] } } : {}),
  });
  return { store, service, review, controller, events, run, current, terminal, reconcile, finish: (result: ToolResult) => finish(result), reject: (error: Error) => reject(error), calls: () => calls };
}

describe("actual tool invocation and manual review", () => {
  it.each(["applied", "not_applied"] as const)("refuses %s while a timed-out invocation can still finish", async outcome => {
    vi.useFakeTimers();
    const f = fixture(), pending = f.run();
    await vi.advanceTimersByTimeAsync(11);
    expect((await pending).results[0]?.executionState).toBe("unknown");
    f.terminal();
    const before = f.current();
    expect(() => f.reconcile(outcome)).toThrow(/invocation|executing|pending/i);
    expect(f.current().revision).toBe(before.revision);
    expect(f.current().state).toBe("unknown");
    f.finish({ content: [{ type: "text", text: "actual complete" }], executionState: "completed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.current().state).toBe("confirmed");
  });

  it("records unknown evidence during a timed-out invocation and saves its late completion once", async () => {
    vi.useFakeTimers();
    const f = fixture(), pending = f.run();
    await vi.advanceTimersByTimeAsync(11);
    const initial = await pending;
    f.terminal();
    expect(f.reconcile("unknown").state).toBe("unknown");
    f.finish({ content: [{ type: "text", text: "actual complete" }], executionState: "completed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.current()).toMatchObject({ state: "confirmed", result: { executionState: "completed" }, reconciliations: [{ outcome: "unknown" }] });
    expect(f.store.toolOperations.listAttempts(f.current().operationId)).toMatchObject([{ status: "confirmed", result: { executionState: "completed" }, reconciliations: [{ outcome: "unknown" }] }]);
    expect(initial.results).toHaveLength(1);
    expect(initial.results[0]?.executionState).toBe("unknown");
    expect(f.events.filter(event => event.type === "domain.event" && event.data.name === "tool.lifecycle" && event.data.payload?.phase === "completed")).toHaveLength(0);
    expect(f.events.some(event => event.type === "domain.event" && event.data.name === "tool.operation.audit_failed")).toBe(false);
    expect(f.calls()).toBe(1);
  });

  it("keeps aborted invocations pending until their actual rejection", async () => {
    vi.useFakeTimers();
    const f = fixture(), pending = f.run();
    await vi.advanceTimersByTimeAsync(0);
    f.controller.abort(new Error("Run interrupted"));
    expect((await pending).results[0]?.executionState).toBe("unknown");
    f.terminal();
    expect(() => f.reconcile("not_applied")).toThrow(/invocation|executing|pending/i);
    f.reject(new Error("External request terminated"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.reconcile("not_applied").state).toBe("not_applied");
  });

  it.each(["unknown", "rejected"] as const)("allows review after an invocation has already settled %s", async outcome => {
    vi.useFakeTimers();
    const f = fixture(), pending = f.run();
    await vi.advanceTimersByTimeAsync(0);
    if (outcome === "rejected") f.reject(new Error("External transport failed"));
    else f.finish({ content: [{ type: "text", text: "Remote state unknown" }], executionState: "unknown", isError: true });
    await vi.advanceTimersByTimeAsync(0);
    expect((await pending).results[0]?.executionState).toBe("unknown");
    f.terminal();
    expect(f.reconcile("not_applied").state).toBe("not_applied");
    expect(f.calls()).toBe(1);
  });

  it("clears tracking when a normal invocation finishes before its deadline", async () => {
    vi.useFakeTimers();
    const f = fixture(), pending = f.run();
    await vi.advanceTimersByTimeAsync(0);
    f.finish({ content: [{ type: "text", text: "written" }], executionState: "completed" });
    await vi.advanceTimersByTimeAsync(0);
    expect((await pending).results[0]?.executionState).toBe("completed");
    expect(f.current().state).toBe("confirmed");
    await vi.advanceTimersByTimeAsync(20);
    expect(f.current().state).toBe("confirmed");
    expect(f.calls()).toBe(1);
  });
});
