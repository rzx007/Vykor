import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { StreamEvent } from "@vykor/agent-contracts";
import { SessionStore } from "@vykor/services";
import { createApprovalReviewer } from "../../../packages/agent-runtime/src/node/review/approval-reviewer.js";
import { createPermissionApprovalReviewService } from "../../../packages/server/src/permissions/approval-review-service.js";
import { StorePermissionBroker } from "../../../packages/server/src/permissions/permission-broker.js";

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
