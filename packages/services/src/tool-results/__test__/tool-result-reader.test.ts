import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredToolOperationIntent } from "../../tool-operations/commands.js";
import type { ToolExecutionResult } from "@vykor/agent-contracts/tool-data";
import { SessionStore } from "../../session-runtime/store.js";
import { ToolResultReader } from "../index.js";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));
function fixture(storage: "memory" | "sqlite" = "sqlite") {
  const directory = mkdtempSync(join(tmpdir(), "tool-result-read-")), path = join(directory, "state.db");
  const store = new SessionStore({ path });
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }), () => store.close());
  store.sessions.create({ id: "s", cwd: directory, model: "m", storage });
  store.runs.createRun({ id: "r", sessionId: "s" });
  const intent: StoredToolOperationIntent = { scope: { agentId: "s", sessionId: "s", runId: "r", inputId: "i", cwd: directory, traceId: "t" }, toolUse: { type: "tool_use", id: "call", name: "Read", input: {} } };
  const reader = new ToolResultReader(store.toolOperations);
  return { directory, path, store, intent, reader };
}
function save(f: ReturnType<typeof fixture>, text: string, executionState: "completed" | "unknown" = "completed") {
  const operation = f.store.toolOperations.prepare({ ...f.intent, toolIdentity: JSON.stringify({ source: { kind: "plugin", id: "selected" }, implementation: "previous-process" }) });
  const authorized = f.store.toolOperations.authorize({ intent: f.intent, operation, policyVersion: "p" });
  const receipt = f.store.toolOperations.dispatch({ intent: f.intent, operation: authorized, policyVersion: "p", ownerId: "owner" });
  const result = { operationId: operation.operationId, toolName: "Read", toolUseId: "call", content: [{ type: "text" as const, text }], executionState };
  f.store.toolOperations.settle({ receipt, result });
  return result;
}

describe("S1 tool result reader", () => {
  it.each(["not_started", "unknown", undefined] as const)("does not promote %s execution feedback to a complete output reference", executionState => {
    const f = fixture();
    const operation = f.store.toolOperations.prepare({ ...f.intent, toolIdentity: JSON.stringify({ source: { kind: "plugin", id: "selected" } }) });
    const result: ToolExecutionResult = { operationId: operation.operationId, toolName: "Read", toolUseId: "call", content: [{ type: "text", text: "feedback only" }],
      ...(executionState ? { executionState } : {}), ...(executionState === "not_started" ? { isError: true, failureKind: "policy" } : {}) };
    let attemptId = "none";
    if (executionState === "not_started") f.store.toolOperations.reject({ intent: f.intent, operation, result });
    else {
      const authorized = f.store.toolOperations.authorize({ intent: f.intent, operation, policyVersion: "p" });
      const receipt = f.store.toolOperations.dispatch({ intent: f.intent, operation: authorized, policyVersion: "p", ownerId: "owner" });
      attemptId = receipt.toolAttemptId;
      f.store.toolOperations.settle({ receipt, result });
    }
    expect(f.reader.list("s")).toEqual({ items: [] });
    expect(() => f.reader.retain("s", "r", result)).toThrow();
    expect(() => f.reader.read("s", { id: `result:${operation.operationId}:${attemptId}` })).toThrow();
  });

  it("keeps an executed read-only error readable when its saved execution is completed", () => {
    const f = fixture();
    const operation = f.store.toolOperations.prepare({ ...f.intent, kind: "read_only", toolIdentity: JSON.stringify({ source: { kind: "plugin", id: "selected" } }) });
    const authorized = f.store.toolOperations.authorize({ intent: f.intent, operation, policyVersion: "p" });
    const receipt = f.store.toolOperations.dispatch({ intent: f.intent, operation: authorized, policyVersion: "p", ownerId: "owner" });
    const result: ToolExecutionResult = { operationId: operation.operationId, toolName: "Read", toolUseId: "call", content: [{ type: "text", text: "query returned an error" }], executionState: "completed", isError: true };
    f.store.toolOperations.settle({ receipt, result });
    const ref = f.reader.retain("s", "r", result);
    expect(f.reader.read("s", { id: ref.id }).text).toBe("query returned an error");
  });
  it("reads a stable reference and literal tail after closing and reopening real SQLite", async () => {
    const f = fixture(), result = save(f, "x".repeat(300_000) + "TAIL-EVIDENCE");
    const first = f.reader.retain("s", "r", result);
    expect(f.reader.retain("s", "r", { ...result, resultRef: { id: "forged", toolName: "Other", totalChars: 9 } })).toEqual(first);
    f.store.close();
    const reopened = new SessionStore({ path: f.path }); cleanup.push(() => reopened.close());
    const reader = new ToolResultReader(reopened.toolOperations);
    expect(reader.list("s").items).toEqual([first]);
    expect(reader.read("s", { id: first.id, offset: 300_000, limit: 100 }).text).toBe("TAIL-EVIDENCE");
    expect(reader.search("s", { id: first.id, query: "TAIL-EVIDENCE" }).matches).toEqual([{ offset: 300_000, text: "TAIL-EVIDENCE" }]);
    expect(reader.resolve("s", first.id).source).toEqual({ kind: "plugin", id: "selected" });
    expect(() => reader.read("other", { id: first.id })).toThrow();
    expect(() => reader.read("s", { id: result.operationId! })).toThrow();
  });
  it("never creates references for unpersisted, mismatched, unknown or uncompleted output", () => {
    const f = fixture(), absent = { toolName: "Read", toolUseId: "call", content: [] };
    expect(() => f.reader.retain("s", "r", absent)).toThrow();
    const result = save(f, "partial", "unknown");
    expect(() => f.reader.retain("s", "r", result)).toThrow();
    expect(f.reader.list("s")).toEqual({ items: [] });
    expect(() => f.reader.retain("s", "r", { ...result, operationId: "operation_missing" })).toThrow();
  });
  it("keeps failed saved output readable and validates record identity instead of forged body metadata", () => {
    const f = fixture(), result = save(f, "failed");
    expect(() => f.reader.retain("s", "r", { ...result, toolName: "Other" })).toThrow();
    expect(() => f.reader.retain("s", "wrong-run", result)).toThrow();
    const ref = f.reader.retain("s", "r", result);
    expect(() => f.reader.read("s", { id: ref.id, limit: 16_001 })).toThrow();
    expect(() => f.reader.search("s", { id: ref.id, query: "" })).toThrow();
  });
  it("does not persist memory session result bodies", () => {
    const f = fixture("memory"), ref = f.reader.retain("s", "r", save(f, "temporary"));
    expect(f.reader.read("s", { id: ref.id }).text).toBe("temporary");
    f.store.close();
    const reopened = new SessionStore({ path: f.path }); cleanup.push(() => reopened.close());
    expect(() => new ToolResultReader(reopened.toolOperations).read("s", { id: ref.id })).toThrow();
  });
});
