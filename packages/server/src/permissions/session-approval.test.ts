import { describe, expect, it, vi } from "vitest";
import { createConfiguredApprovalReviewer } from "@vykor/agent-runtime";

vi.mock("@vykor/agent-runtime", () => ({ createConfiguredApprovalReviewer: vi.fn() }));
import type { AgentEffectContext } from "@vykor/agent-contracts";
import type { Settings } from "@vykor/host-config";
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
  it.each(["Shell", "TerminalOpen"])("reviews a routine %s command without requiring system isolation first", async toolName => {
    const sample = fixture(toolName);
    const command = { command: "git status --short" };
    sample.request.payload.input = command;
    const review = vi.fn(async () => ({ decision: "approve" as const, risk: "low" as const, authorization: "task_implied" as const, reason: "Read project status" }));
    vi.mocked(createConfiguredApprovalReviewer).mockResolvedValueOnce({ review });
    await expect(sample.input.review!({ request: sample.request, input: { ...sample.input, input: command } })).resolves.toMatchObject({ decision: "approve" });
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      input: command,
      evidence: expect.objectContaining({ reliableIsolation: false, userInstruction: "Edit a.ts" }),
    }), undefined);
  });

  it("reviews a user instruction in a forked conversation rather than treating it as an agent delegation", async () => {
    const sample = fixture("Write");
    Object.assign(sample.session, { parentId: "source-session" });
    const review = vi.fn(async () => ({ decision: "approve" as const, risk: "low" as const, authorization: "task_implied" as const, reason: "Within the fork's own user task" }));
    vi.mocked(createConfiguredApprovalReviewer).mockResolvedValueOnce({ review });
    await expect(sample.input.review!({ request: sample.request, input: sample.input })).resolves.toMatchObject({ decision: "approve" });
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "s", inputId: "i", evidence: expect.objectContaining({ userInstruction: "Edit a.ts" }),
    }), undefined);
  });

  it("retains the reviewer's request for human confirmation of an unknown command", async () => {
    const sample = fixture();
    const review = vi.fn(async () => ({ decision: "ask_user" as const, risk: "unknown" as const, authorization: "missing" as const, reason: "Unknown command effects" }));
    vi.mocked(createConfiguredApprovalReviewer).mockResolvedValueOnce({ review });
    await expect(sample.input.review!({ request: sample.request, input: sample.input })).resolves.toMatchObject({ decision: "ask_user", risk: "unknown" });
    expect(review).toHaveBeenCalledOnce();
  });
  it("does not auto-approve an unclassified plugin by its description", async () => {
    const sample = fixture("Publish", "plugin");
    await expect(sample.input.review!({ request: sample.request, input: sample.input })).resolves.toMatchObject({ decision: "ask_user" });
  });
});
