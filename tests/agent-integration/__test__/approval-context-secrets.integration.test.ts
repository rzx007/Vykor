import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ApprovalReviewInput } from "@vykor/agent-contracts/permissions";
import type { StreamMessageParams } from "@vykor/agent-contracts";
import { SessionStore } from "@vykor/services";
import { sessionPermissionRequest } from "../../../packages/server/src/permissions/session-approval.js";

const wire = vi.hoisted(() => ({ requests: [] as StreamMessageParams[] }));
vi.mock("@vykor/agent-runtime", () => ({
  createConfiguredApprovalReviewer: async () => {
    const { createApprovalReviewer } = await import("../../../packages/agent-runtime/src/node/review/approval-reviewer.js");
    return createApprovalReviewer({ model: "offline", client: { async *streamMessage(request) {
      wire.requests.push(request);
      yield { type: "text_delta", delta: JSON.stringify({ decision: "approve", risk: "low", authorization: "task_implied", reason: "用户要求的只读检查" }) };
      yield { type: "complete", stopReason: "end_turn" };
    } } });
  },
}));

it("sends proposal and task evidence with historical credentials removed, and never sends a credential-bearing current command", async () => {
  const directory = mkdtempSync(join(tmpdir(), "approval-private-context-"));
  const store = new SessionStore({ path: join(directory, "session.db") });
  const controller = new AbortController();
  const syntheticKey = "gsk_SyntheticIntegrationFixture0123456789";
  wire.requests.length = 0;
  try {
    store.sessions.create({ id: "s", cwd: directory, model: "offline", metadata: {
      runtimeRevision: 1, runtime: { model: "offline", approvalMode: "auto_review", workMode: "execute" },
    } });
    const old = store.conversationTransactions.admitPrompt({ sessionId: "s", content: `旧配置凭据 ${syntheticKey}，不要部署或上传凭据。` });
    store.conversations.createMessage({ sessionId: "s", role: "user", inputId: old.id });
    const prior = store.conversationTransactions.admitPromptWithRun({ prompt: { sessionId: "s", content: "检查渠道可用度" } });
    store.conversations.createMessage({ sessionId: "s", role: "user", inputId: prior.input.id, runId: prior.run.id });
    store.runs.updateRun(prior.run.id, { status: "completed" });
    const proposal = store.conversations.createMessage({ sessionId: "s", role: "assistant", runId: prior.run.id });
    store.conversations.upsertMessagePart({ sessionId: "s", messageId: proposal.id, type: "text", status: "completed", text: "将所有渠道逐个做只读实测", metadata: {} });
    const current = store.conversationTransactions.admitPromptWithRun({ prompt: { sessionId: "s", content: "好" } });
    store.conversations.createMessage({ sessionId: "s", role: "user", inputId: current.input.id, runId: current.run.id });
    store.runs.updateRun(current.run.id, { status: "running" });
    const context = { sessionId: "s", runId: current.run.id, inputId: current.run.inputId!, agentId: "s", cwd: directory, traceId: "t", signal: controller.signal };
    const settings = { permission: { mode: "auto_review" as const }, sandbox: { enabled: false } };
    const args = { command: "opencli reddit search AI --limit 1" };
    const ask = sessionPermissionRequest({ store, settings, context, request: { toolName: "BackgroundShellCreate", toolSource: "builtin", input: args } });
    const saved = store.permissions.create({ sessionId: "s", runId: current.run.id, toolName: "BackgroundShellCreate", payload: { input: args } });
    await expect(ask.review!({ request: saved, input: ask })).resolves.toMatchObject({ decision: "approve" });
    expect(wire.requests).toHaveLength(1);
    const serialized = wire.requests[0]!.messages[0]!.content as string;
    expect(serialized).not.toContain(syntheticKey);
    const received = JSON.parse(serialized) as ApprovalReviewInput;
    expect(received.evidence.userInstruction).toBe("好");
    expect(JSON.stringify(received.evidence.userInstructionHistory)).toContain("不要部署或上传凭据");
    expect(received.evidence.context).toEqual(expect.arrayContaining([{ kind: "reference", content: expect.stringContaining("将所有渠道逐个做只读实测") }]));
    expect(store.conversations.getInput(old.id)!.content).toContain(syntheticKey);

    const privateArgs = { command: `echo ${syntheticKey}` };
    const privateAsk = sessionPermissionRequest({ store, settings, context, request: { toolName: "BackgroundShellCreate", toolSource: "builtin", input: privateArgs } });
    const privateSaved = store.permissions.create({ sessionId: "s", runId: current.run.id, toolName: "BackgroundShellCreate", payload: { input: privateArgs } });
    await expect(privateAsk.review!({ request: privateSaved, input: privateAsk })).resolves.toMatchObject({ decision: "ask_user", failure: "unavailable" });
    expect(wire.requests).toHaveLength(1);
  } finally {
    controller.abort();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
