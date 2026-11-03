import { describe, expect, it } from "vitest";
import type { SessionMessagePartRecord, SessionMessageRecord, PermissionRequestRecord, SessionRunRecord } from "@vykor/domain-contracts/sessions";
import type { SessionStore } from "@vykor/services";
import { buildApprovalReviewContext } from "../approval-context.js";

function fixture() {
  const scope = { sessionId: "s", inputId: "current", runId: "run", requestId: "pending", runtimeRevision: 1, before: 100 };
  const messages = [
    { id: "u", sessionId: "s", seq: 1, role: "user", inputId: "prior", runId: "previous", createdAt: 1 },
    { id: "a", sessionId: "s", seq: 2, role: "assistant", runId: "previous", createdAt: 2 },
    { id: "current", sessionId: "s", seq: 3, role: "user", inputId: "current", runId: "run", createdAt: 3 },
  ] as SessionMessageRecord[];
  const parts = [{ id: "part", sessionId: "s", messageId: "a", seq: 1, type: "text", status: "completed", text: "只检查状态，不改配置", createdAt: 2, updatedAt: 2, metadata: {} }] as SessionMessagePartRecord[];
  const approvals: PermissionRequestRecord[] = [];
  const results: Array<{ id: string; sessionId: string; runId: string; sourceKind: string; toolName: string; createdAt: number; totalChars: number; text: string }> = [];
  const runs = [{ id: "previous", sessionId: "s", inputId: "prior", status: "completed", metadata: {} }] as SessionRunRecord[];
  const read: string[] = [];
  const store = { conversations: { listMessages: () => messages, listMessageParts: () => parts },
    runs: { getRun: (id: string) => runs.find(run => run.id === id) }, permissions: { list: () => approvals },
    toolResults: { list: () => results, readText: (id: string) => { read.push(id); return results.find(result => result.id === id)!.text; } },
  } as unknown as SessionStore;
  return { scope, store, messages, parts, approvals, results, runs, read };
}

describe("saved approval reference boundaries", () => {
  it("uses only the proposal immediately preceding the user's reply", () => {
    const sample = fixture();
    sample.messages.push({ id: "future", sessionId: "s", seq: 4, role: "assistant", createdAt: 101 } as SessionMessageRecord);
    sample.parts.push({ ...sample.parts[0]!, id: "later", messageId: "future", text: "未来指令", createdAt: 101, updatedAt: 101 });
    const context = buildApprovalReviewContext(sample.store, sample.scope);
    expect(context).toEqual([{ kind: "reference", content: expect.stringContaining("只检查状态，不改配置") }]);
    expect(JSON.stringify(context)).not.toContain("未来指令");
  });

  it.each(["incomplete", "oversized", "superseded"])("marks a %s proposal missing rather than sending a partial one", kind => {
    const sample = fixture();
    if (kind === "incomplete") sample.parts[0]!.status = "running";
    if (kind === "oversized") sample.parts[0]!.text = "x".repeat(4_001) + "禁止删除";
    if (kind === "superseded") sample.parts[0]!.metadata = { modelGeneration: { generationId: "old", attempt: 1, committed: true, superseded: true } };
    const text = JSON.stringify(buildApprovalReviewContext(sample.store, sample.scope));
    expect(text).toContain("omitted");
    expect(text).not.toContain("只检查状态");
    expect(text).not.toContain("xxxx");
  });

  it("never reads other-session, unrelated, delegated, external or future result bodies", () => {
    const sample = fixture();
    sample.runs[0]!.metadata = { parentRunId: "parent" };
    const base = { id: "ok", sessionId: "s", runId: "run", sourceKind: "builtin", toolName: "JobRead", createdAt: 5, totalChars: 8, text: "safe output" };
    sample.results.push(base, { ...base, id: "other-session", sessionId: "other" },
      { ...base, id: "other-run", runId: "unrelated" }, { ...base, id: "delegated", runId: "previous" },
      { ...base, id: "external", sourceKind: "plugin" }, { ...base, id: "future", createdAt: 101 });
    const context = buildApprovalReviewContext(sample.store, sample.scope);
    expect(sample.read).toEqual(["ok"]);
    expect(context).toEqual(expect.arrayContaining([{ kind: "tool_output", content: expect.stringContaining("safe output") }]));
  });

  it("uses only earlier exact approvals for this input, run and configuration", () => {
    const sample = fixture();
    const base = { id: "ok", sessionId: "s", runId: "run", toolName: "Shell", status: "approved", decision: "once", createdAt: 5, updatedAt: 6, payload: { inputId: "current", runtimeRevision: 1, input: { command: "git status" } } } as PermissionRequestRecord;
    sample.approvals.push(base, { ...base, id: "other-session", sessionId: "other" }, { ...base, id: "other-run", runId: "unrelated" },
      { ...base, id: "future", updatedAt: 101 }, { ...base, id: "denied", status: "denied" },
      { ...base, id: "old-config", payload: { ...base.payload, runtimeRevision: 0 } },
      { ...base, id: "other-input", payload: { ...base.payload, inputId: "other" } });
    const context = buildApprovalReviewContext(sample.store, sample.scope);
    const approval = context.filter(item => item.content.includes("Earlier exact approval"));
    expect(approval).toEqual([{ kind: "reference", content: expect.stringContaining('"requestId":"ok"') }]);
    expect(approval[0]!.content).toContain("not permission");
  });

  it("does not read an oversized result or silently hide budget omissions", () => {
    const sample = fixture();
    sample.results.push({ id: "huge", sessionId: "s", runId: "run", sourceKind: "builtin", toolName: "Read", createdAt: 5, totalChars: 10_000, text: "must not load" });
    const context = buildApprovalReviewContext(sample.store, sample.scope);
    expect(sample.read).toEqual([]);
    expect(context.at(-1)?.content).toContain("omitted");
  });
});
