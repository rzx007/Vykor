import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { SessionStore } from "@vykor/services";
import { ToolOperationReviewService } from "../tool-operation-review-service.js";
import { DaemonApplication } from "../../../daemon-application.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "operation-review-"));
  const store = new SessionStore({ path: join(directory, "state.db") });
  const application = new DaemonApplication({ store, ownerId: "review-owner", settings: { model: "m", plugins: { enabled: false }, memory: { enabled: false } }, log: () => {} });
  cleanups.push(async () => { await application.close(); store.close(); const target = resolve(directory), child = relative(resolve(tmpdir()), target); if (!child || child.startsWith("..") || isAbsolute(child) || !target.includes("operation-review-")) throw new Error("Unsafe cleanup"); rmSync(target, { recursive: true, force: true }); });
  await application.ready();
  for (const id of ["root", "child", "other"]) store.sessions.create({ id, ...(id === "child" ? { parentId: "root" } : {}), cwd: directory, model: "m" });
  const unknown = (sessionId = "child", runId = "original", terminal = true, settled = true) => {
    store.runs.createRun({ id: runId, sessionId });
    const intent = { scope: { sessionId, agentId: sessionId, runId, inputId: "input", traceId: "trace", cwd: directory }, toolUse: { type: "tool_use" as const, id: "call", name: "Write", input: { body: "secret".repeat(3000) } } };
    const operation = store.toolOperations.prepare({ ...intent, toolIdentity: "builtin" });
    const authorized = store.toolOperations.authorize({ intent, operation, policyVersion: "v1" });
    // The owner is held by the application. A recovered dispatched row has the same audit shape.
    const owner = "review-owner";
    const receipt = store.toolOperations.dispatch({ intent, operation: authorized, policyVersion: "v1", ownerId: owner });
    if (settled) store.toolOperations.settle({ receipt, result: { toolUseId: "call", toolName: "Write", executionState: "unknown", content: [{ type: "text", text: "raw unknown receipt" }] } });
    if (terminal) store.runs.updateRun(runId, { status: "interrupted" });
    return store.toolOperations.get(operation.operationId)!;
  };
  const review = (application as unknown as { toolOperationReview?: { list(id: string): unknown; get(id: string, op: string): unknown; reconcile(id: string, op: string, input: unknown): unknown } }).toolOperationReview;
  return { store, application, review, unknown };
}
describe("host tool operation review", () => {
  it("shows unsettled terminal dispatches with recovery steps while keeping active dispatches out", async () => {
    const f = await fixture();
    f.unknown("child", "active-dispatch", false, false);
    const operation = f.unknown("child", "finished-dispatch", true, false);
    const rows = f.review!.list("root") as Array<{ operationId: string; state: string; recoveryHint?: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operationId: operation.operationId, state: "dispatching", recoveryHint: expect.stringMatching(/重启/) });
    expect(JSON.stringify(rows)).not.toContain("secret");
    expect(f.review!.get("root", operation.operationId)).toHaveProperty("recoveryHint", rows[0]!.recoveryHint);
    expect(() => f.review!.reconcile("root", operation.operationId, {
      expectedRevision: operation.revision, outcome: "not_applied", evidence: "read-only target inspection",
    })).toThrow(/重启/);
    expect(f.store.toolOperations.get(operation.operationId)?.state).toBe("dispatching");
    expect(f.store.toolOperations.listAttempts(operation.operationId)).toMatchObject([{ status: "dispatching" }]);
  });

  it("lists only unknown identities in the same tree and returns bounded previews by ID", async () => {
    const f = await fixture(), operation = f.unknown(); f.unknown("other", "other-run");
    const list = f.review?.list("root");
    expect(list).toEqual([expect.objectContaining({ operationId: operation.operationId, sessionId: "child", state: "unknown", revision: operation.revision })]);
    expect(JSON.stringify(list)).not.toContain("secret"); expect(JSON.stringify(list)).not.toContain("raw unknown receipt");
    const detail = f.review?.get("root", operation.operationId) as { inputPreview: string; resultPreview: string };
    expect(detail.inputPreview.length).toBeLessThanOrEqual(4000); expect(detail.resultPreview).toContain("raw unknown receipt");
    expect(() => f.review!.get("other", operation.operationId)).toThrow(/not found|belong|tree/i);
  });
  it("refuses active Runs, stale revisions and missing evidence without changing the original Attempt", async () => {
    const f = await fixture(), operation = f.unknown("child", "active", false);
    expect(f.review).toBeDefined();
    const input = { expectedRevision: operation.revision, outcome: "not_applied", evidence: "read-only audit confirms absence" };
    f.store.runs.updateRun(operation.runId, { status: "running" });
    expect(() => f.review!.reconcile("root", operation.operationId, input)).toThrow(/active|terminal|ended/i);
    f.store.runs.updateRun(operation.runId, { status: "interrupted" });
    expect(() => f.review!.reconcile("root", operation.operationId, { ...input, expectedRevision: operation.revision - 1 })).toThrow(/revision/i);
    expect(() => f.review!.reconcile("root", operation.operationId, { ...input, evidence: " " })).toThrow(/evidence/i);
    expect(() => f.review!.reconcile("other", operation.operationId, input)).toThrow(/not found|belong|tree/i);
    expect(f.store.toolOperations.get(operation.operationId)?.revision).toBe(operation.revision);
  });
  it("preserves unknown without a completed result and records evidence before explicit not_applied", async () => {
    const f = await fixture(), operation = f.unknown(); expect(f.review).toBeDefined();
    const applied = f.review!.reconcile("root", operation.operationId, { expectedRevision: operation.revision, outcome: "applied", evidence: "record exists, response unavailable" }) as { revision: number; state: string };
    expect(applied.state).toBe("unknown");
    const resolved = f.review!.reconcile("root", operation.operationId, { expectedRevision: applied.revision, outcome: "not_applied", evidence: "read-only record lookup confirms absence" }) as { state: string };
    expect(resolved.state).toBe("not_applied");
    expect(f.store.toolOperations.listAttempts(operation.operationId)).toMatchObject([{ status: "unknown", result: { content: [{ text: "raw unknown receipt" }] }, reconciliations: [{ outcome: "applied" }, { outcome: "not_applied" }] }]);
    expect(f.store.toolOperations.listAttempts(operation.operationId)).toHaveLength(1);
  });
  it("accepts only an explicit completed result for applied and preserves raw audit", async () => {
    const f = await fixture(), operation = f.unknown(); expect(f.review).toBeDefined();
    const resolved = f.review!.reconcile("root", operation.operationId, { expectedRevision: operation.revision, outcome: "applied", evidence: "checked target record and original response", result: { toolUseId: "call", toolName: "Write", executionState: "completed", content: [{ type: "text", text: "confirmed response" }] } }) as { state: string };
    expect(resolved.state).toBe("confirmed");
    expect(f.store.toolOperations.listAttempts(operation.operationId)[0]?.result?.executionState).toBe("unknown");
    expect(f.review!.list("root")).toEqual([]);
  });
});


it("lets an available parent review an archived child's unknown operation without retry", async () => {
  const f = await fixture(), operation = f.unknown();
  f.store.sessions.archive("child");
  expect(f.review!.list("root")).toEqual([expect.objectContaining({ operationId: operation.operationId })]);
  expect(f.review!.get("root", operation.operationId)).toMatchObject({ sessionId: "child", state: "unknown" });
  expect(() => f.review!.get("child", operation.operationId)).toThrow(/session.*unavailable/i);
  expect(f.review!.reconcile("root", operation.operationId, { expectedRevision: operation.revision, outcome: "not_applied", evidence: "parent operator checked target record is absent" })).toMatchObject({ state: "not_applied" });
  expect(f.store.toolOperations.listAttempts(operation.operationId)).toHaveLength(1);
});

it("fences review reads and writes when readiness or owner lease is lost", () => {
  const directory = mkdtempSync(join(tmpdir(), "operation-review-owner-"));
  const store = new SessionStore({ path: join(directory, "state.db") });
  const lease = store.acquireApplicationOwner({ ownerId: "first", pid: process.pid, staleAfterMs: 30000 });
  store.sessions.create({ id: "root", cwd: directory, model: "m" });
  let accepting = false;
  const review = new ToolOperationReviewService({ store, ownerLease: () => lease, accepting: () => accepting, reconcile: input => store.toolOperations.reconcile(input) });
  try {
    expect(() => review.list("root")).toThrow(/not accepting/i);
    expect(() => review.reconcile("root", "missing", { expectedRevision: 1, outcome: "unknown", evidence: "checked" })).toThrow(/not accepting/i);
    accepting = true; expect(review.list("root")).toEqual([]);
    store.acquireApplicationOwner({ ownerId: "next", pid: process.pid, staleAfterMs: 30000, canTakeOver: () => true });
    expect(() => review.list("root")).toThrow(/owned|owner/i);
    expect(() => review.reconcile("root", "missing", { expectedRevision: 1, outcome: "unknown", evidence: "checked" })).toThrow(/owned|owner/i);
  } finally {
    store.close();
    const target = resolve(directory), child = relative(resolve(tmpdir()), target);
    if (!child || child.startsWith("..") || isAbsolute(child) || !target.includes("operation-review-owner-")) throw new Error("Unsafe cleanup");
    rmSync(target, { recursive: true, force: true });
  }
});
