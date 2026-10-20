import { describe, expect, it, vi } from "vitest";
import { createConfiguredApprovalReviewer } from "@vykor/agent-runtime";

vi.mock("@vykor/agent-runtime", () => ({ createConfiguredApprovalReviewer: vi.fn() }));
import type { AgentEffectContext, Settings } from "@vykor/core";
import type { PermissionRequestRecord } from "@vykor/protocol";
import type { SessionStore } from "@vykor/services";
import { sessionPermissionRequest } from "./session-approval.js";
function fixture(toolName = "Shell", source = "builtin") {
  const session = { id: "s", status: "idle", metadata: { runtimeRevision: 1, runtime: { model: "offline", approvalMode: "auto_review", workMode: "execute" } } };
  const abort = new AbortController();
  const context: AgentEffectContext = { agentId: "a", sessionId: "s", runId: "r", inputId: "i", cwd: process.cwd(), traceId: "t", signal: abort.signal };
  const store = { sessions: { get: () => session }, runs: { getRun: () => ({ id: "r", inputId: "i", sessionId: "s", status: "running", metadata: {} }) }, conversations: { getInput: () => ({ id: "i", sessionId: "s", content: "Edit a.ts", metadata: {} }) } } as unknown as SessionStore;
  const settings = { permission: { mode: "auto_review" }, sandbox: { enabled: false } } as Settings;
  const original = { toolName, toolSource: source, toolDescription: "Registered tool", input: { path: "a.ts", command: "some-unknown-program" } };
  const input = sessionPermissionRequest({ store, settings, context, request: original });
  const request = { id: "q", status: "pending", toolName, payload: { input: structuredClone(original.input) } } as unknown as PermissionRequestRecord;
  return { session, abort, input, request, original };
}
describe("session authorization host boundary", () => {
  it("reviews the broker snapshot and captured tool facts after asynchronous setup", async () => {
    const sample = fixture("Write");
    const review = vi.fn(async () => ({ decision: "approve" as const, risk: "low" as const, authorization: "task_implied" as const, reason: "Within task" }));
    let ready!: () => void;
    vi.mocked(createConfiguredApprovalReviewer).mockImplementationOnce(() => new Promise(resolve => { ready = () => resolve({ review }); }));
    const captured = { ...sample.input, input: structuredClone(sample.request.payload.input as Record<string, unknown>) };
    const pending = sample.input.review!({ request: sample.request, input: captured });
    sample.original.input.path = "changed.ts";
    sample.original.toolSource = "plugin";
    sample.original.toolDescription = "Changed description";
    ready();
    await expect(pending).resolves.toMatchObject({ decision: "approve" });
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ path: "a.ts" }),
      tool: { name: "Write", source: "builtin", description: "Registered tool" },
    }), undefined);
  });

  it("binds approval to the captured session revision", () => {
    const sample = fixture();
    expect(sample.input.approvalMode).toBe("auto_review");
    expect(sample.input.isCurrent!()).toBe(true);
    sample.session.metadata.runtimeRevision++;
    expect(sample.input.isCurrent!()).toBe(false);
  });
  it("invalidates a cancelled run", () => {
    const sample = fixture(); sample.abort.abort(); expect(sample.input.isCurrent!()).toBe(false);
  });
  it("sends unknown commands to the user when no reliable isolation exists", async () => {
    const sample = fixture();
    await expect(sample.input.review!({ request: sample.request, input: sample.input })).resolves.toMatchObject({ decision: "ask_user", risk: "unknown" });
  });
  it("does not auto-approve an unclassified plugin by its description", async () => {
    const sample = fixture("Publish", "plugin");
    await expect(sample.input.review!({ request: sample.request, input: sample.input })).resolves.toMatchObject({ decision: "ask_user" });
  });
});
