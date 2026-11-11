import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { AgentExecutionContext, StreamEvent, StreamMessageParams } from "@vykor/agent-contracts";
import { QueryEngine, ToolRegistry } from "@vykor/core";
import { PermissionChecker } from "@vykor/permissions";
import { SessionStore } from "@vykor/services";
import { applyConfiguredTools } from "../../../packages/agent-runtime/src/node/tools/default-runtime-tools.js";
import { createApprovalReviewer } from "../../../packages/agent-runtime/src/node/review/approval-reviewer.js";
import { createPermissionApprovalReviewService } from "../../../packages/server/src/permissions/approval-review-service.js";
import { StorePermissionBroker } from "../../../packages/server/src/permissions/permission-broker.js";
import { sessionPermissionRequest } from "../../../packages/server/src/permissions/session-approval.js";
import { createBrowserTool } from "../../../packages/server/src/application/browser-tools/browser-tool.js";

const wire = vi.hoisted(() => ({ requests: [] as StreamMessageParams[] }));
vi.mock("@vykor/agent-runtime", () => ({
  createConfiguredApprovalReviewer: async () => {
    const { createApprovalReviewer } = await import("../../../packages/agent-runtime/src/node/review/approval-reviewer.js");
    return createApprovalReviewer({ model: "offline", client: { async *streamMessage(request) {
      wire.requests.push(request);
      yield { type: "text_delta", delta: JSON.stringify({ decision: "approve", risk: "low", authorization: "task_implied", reason: "用户要求的页面检查" }) };
      yield { type: "complete", stopReason: "end_turn" };
    } } });
  },
}));

it("automatically reviews host-registered Browser calls and the site confirmation without manual replies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vykor-browser-approval-"));
  const store = new SessionStore({ path: join(directory, "session.db") });
  const controller = new AbortController();
  wire.requests.length = 0;
  try {
    store.sessions.create({ id: "session", cwd: directory, model: "offline", metadata: {
      runtime: { model: "offline", approvalMode: "auto_review", workMode: "execute" },
    } });
    const admitted = store.conversationTransactions.admitPromptWithRun({ prompt: {
      sessionId: "session", content: "内置浏览器打开本地项目并检查页面",
    } });
    store.runs.updateRun(admitted.run.id, { status: "running" });
    store.conversations.createMessage({ sessionId: "session", role: "user", inputId: admitted.input.id, runId: admitted.run.id });
    const broker = new StorePermissionBroker({ permissions: store.permissions,
      getSession: id => store.sessions.get(id), latestEventSeq: () => store.conversations.latestEventSeq() });
    let siteApproved = false;
    const operations: string[] = [];
    const browser = createBrowserTool({ async execute({ action, approve }) {
      if (!siteApproved) {
        if (!await approve("Allow the Browser tool to inspect and interact with http://localhost:3001 for this session?")) throw new Error("Site denied");
        siteApproved = true;
      }
      operations.push(action.action);
      return { url: "http://localhost:3001", title: "Project", pageText: "Ready" };
    } }, async () => "unused.png", async () => ({}));
    const registry = new ToolRegistry();
    // Use the actual Node registration path: host additions have source agent.
    applyConfiguredTools(registry, { tools: [browser] });
    expect(registry.inspect("Browser")?.source).toEqual({ kind: "agent" });
    const execution: AgentExecutionContext = {
      scope: { agentId: "session", sessionId: "session", runId: admitted.run.id, inputId: admitted.input.id,
        cwd: directory, traceId: "trace", signal: controller.signal },
      tools: new Map([[browser.name, { definition: browser, invoke: browser.execute, source: registry.inspect(browser.name)!.source }]]),
      effects: { requestPermission: (request, context) => broker.ask(sessionPermissionRequest({
        store, request, context, settings: { permission: { mode: "auto_review" }, sandbox: { enabled: false } },
      })) },
      children: { hasChildAgent: () => false, spawnChildAgent: async () => { throw new Error("unexpected child"); },
        sendChildInput: async () => { throw new Error("unexpected child"); }, interruptChildAgent: async () => {},
        awaitChildAgent: async () => { throw new Error("unexpected child"); } },
      emit: async () => {}, takeSteeredInputs: async () => [], closeSteering() {}, observeInvocation() {},
    };
    const engine = new QueryEngine({ async *streamMessage() { throw new Error("unexpected agent model request"); } }, registry,
      new PermissionChecker({ mode: "auto_review", cwd: directory }),
      { register() {}, execute: async () => ({ blocked: false }) }, { cwd: directory, sessionId: "session", toolTimeoutMs: 2_000 });
    for (const [index, args] of [
      { action: "navigate", url: "http://localhost:3001" },
      { action: "inspect" },
      { action: "scroll", direction: "down" },
    ].entries()) {
      const result = await engine.executeTool({ type: "tool_use", id: `browser-${index}`, name: "Browser", input: args }, { execution });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
    }
    expect(operations).toEqual(["navigate", "inspect", "scroll"]);
    const requests = store.permissions.list();
    expect(requests).toHaveLength(4);
    expect(requests.every(request => request.status === "approved" && request.decision === "once"
      && !request.decidedByClientId && request.payload.approvalReview?.status === "approved")).toBe(true);
    expect(requests.filter(request => request.payload.confirmation === "once")).toHaveLength(1);
    expect(store.permissions.list({ status: "pending" })).toEqual([]);
    expect(broker.listApprovals()).toEqual([]);
    expect(wire.requests).toHaveLength(4);
    expect(wire.requests.every(request => JSON.parse(request.messages[0]!.content as string).tool.source === "agent")).toBe(true);
  } finally {
    controller.abort();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("releases a scheduled BackgroundShellCreate request after a truncated review without a manual reply", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vykor-scheduled-approval-"));
  const store = new SessionStore({ path: join(directory, "session.db") });
  const controller = new AbortController();
  try {
    store.sessions.create({ id: "session", cwd: directory, model: "offline", metadata: {
      runtime: { approvalMode: "auto_review", workMode: "execute" },
    } });
    const prompt = store.conversationTransactions.admitPrompt({
      id: "scheduled-input", sessionId: "session", content: "Read this project's Git status on a schedule.",
      metadata: { source: "scheduled_task", scheduledTaskId: "task" },
    });
    store.runs.createRun({ id: "scheduled-run", sessionId: "session", inputId: prompt.id,
      metadata: { source: "scheduled_task", scheduledTaskId: "task" } });
    let reviews = 0;
    const reviewer = createApprovalReviewer({ model: "offline", client: {
      async *streamMessage(): AsyncIterable<StreamEvent> {
        reviews++;
        if (reviews === 1) {
          yield { type: "text_delta", delta: '{"decision":"approve"' };
          yield { type: "complete", stopReason: "max_tokens" };
          return;
        }
        yield { type: "text_delta", delta: JSON.stringify({
          decision: "approve", risk: "low", authorization: "task_implied", reason: "Scheduled project status check.",
        }) };
        yield { type: "complete", stopReason: "end_turn" };
      },
    } });
    const service = createPermissionApprovalReviewService({
      getInput: id => store.conversations.getInput(id), getRun: id => store.runs.getRun(id), review: reviewer.review,
    });
    const broker = new StorePermissionBroker({
      permissions: store.permissions, getSession: id => store.sessions.get(id),
      latestEventSeq: () => store.conversations.latestEventSeq(),
      review: ({ request, input, signal }) => service.review({
        requestId: request.id, sessionId: input.sessionId, runId: input.runId,
        inputId: input.inputId!, runtimeRevision: input.runtimeRevision!,
        tool: { name: request.toolName, source: "builtin" }, input: input.input!,
        evidence: { cwd: directory, accessBoundary: directory, denyRules: [], reliableIsolation: false },
      }, signal),
    });
    const waiting = broker.ask({
      sessionId: "session", runId: "scheduled-run", inputId: prompt.id, runtimeRevision: 0,
      toolName: "BackgroundShellCreate", approvalMode: "auto_review", signal: controller.signal,
      input: { description: "Inspect project status", command: "git status --short" },
    });
    await vi.waitFor(() => expect(store.permissions.list()).toMatchObject([
      { status: "approved", decision: "once", payload: { approvalReview: { status: "approved" } } },
    ]));
    await expect(waiting).resolves.toEqual({ status: "approved", decision: "once" });
    expect(reviews).toBe(2);
    expect(broker.listApprovals()).toEqual([]);
    expect(store.permissions.list({ status: "pending" })).toEqual([]);
  } finally {
    controller.abort();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
