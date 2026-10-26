import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { SessionStore } from "@vykor/services";
import { CURRENT_PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from "@vykor/protocol";
import { VykorHttpServer } from "../server.js";
import { DaemonApplication } from "../../application/daemon-application.js";

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
it("exposes manual review only behind daemon HTTP authentication and validates requests", async () => {
  const f = await fixture(), operation = f.unknown();
  const server = new VykorHttpServer({ application: f.application, token: "review-token", logger: () => {} });
  const path = `/sessions/root/tool-operations/${operation.operationId}`;
  const headers = { authorization: "Bearer review-token", [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION), "content-type": "application/json" };
  try {
    expect((await server.app.request(path, { headers: { [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION) } })).status).toBe(401);
    const listed = await server.app.request("/sessions/root/tool-operations", { headers });
    expect(listed.status).toBe(200); expect(await listed.json()).toMatchObject({ operations: [{ operationId: operation.operationId }] });
    expect((await server.app.request(path, { headers })).status).toBe(200);
    expect((await server.app.request(`${path}/reconcile`, { method: "POST", headers, body: JSON.stringify({ expectedRevision: operation.revision, outcome: "not_applied", evidence: " " }) })).status).toBe(400);
    expect((await server.app.request(`${path}/reconcile`, { method: "POST", headers, body: JSON.stringify({ expectedRevision: operation.revision - 1, outcome: "not_applied", evidence: "checked absent" }) })).status).toBe(409);
    const applied = await server.app.request(`${path}/reconcile`, { method: "POST", headers, body: JSON.stringify({ expectedRevision: operation.revision, outcome: "applied", evidence: "target exists, response missing" }) });
    expect(applied.status).toBe(200); expect(await applied.json()).toMatchObject({ operation: { state: "unknown", revision: operation.revision + 1 } });
    expect(f.store.toolOperations.listAttempts(operation.operationId)).toHaveLength(1);
  } finally { await server.close(); }
});

it("keeps custom hosts without the optional review resource usable", async () => {
  const f = await fixture();
  const legacy = Object.create(f.application) as import("../../application/daemon-application.js").DurableAgentApplication;
  Object.defineProperty(legacy, "toolOperationReview", { value: undefined });
  const server = new VykorHttpServer({ application: legacy, token: "review-token", logger: () => {} });
  try {
    const headers = { authorization: "Bearer review-token", [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION) };
    expect((await server.app.request("/sessions/root/tool-operations", { headers })).status).toBe(404);
    expect((await server.app.request("/sessions/root", { headers })).status).toBe(200);
  } finally { await server.close(); }
});
