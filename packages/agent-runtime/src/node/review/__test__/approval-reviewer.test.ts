import type { StreamEvent, StreamMessageParams, StreamingMessageClient } from "@vykor/agent-contracts";
import { describe, expect, it, vi } from "vitest";

import type { ApprovalReviewInput, ApprovalReviewResult } from "@vykor/agent-contracts/permissions";
import { createApprovalReviewer, parseApprovalReviewResult } from "../approval-reviewer.js";

const approved: ApprovalReviewResult = { decision: "approve", risk: "low", authorization: "task_implied", reason: "修改属于用户要求的项目范围。" };
const input: ApprovalReviewInput = {
  requestId: "q1", sessionId: "s1", runId: "r1", inputId: "i1", runtimeRevision: 3,
  tool: { name: "Write", source: "builtin" }, input: { path: "/project/a.ts", content: "safe" },
  evidence: { userInstruction: "修复项目", cwd: "/project", accessBoundary: "project only", denyRules: [], reliableIsolation: true },
};

function clientFor(events: StreamEvent[], onRequest?: (request: StreamMessageParams) => void): StreamingMessageClient {
  return { async *streamMessage(request) { onRequest?.(request); yield* events; } };
}

describe("approval reviewer", () => {
  it("sends one independent request with no tools and bounded output", async () => {
    let captured: StreamMessageParams | undefined;
    const reviewer = createApprovalReviewer({ model: "review-model", client: clientFor([
      { type: "text_delta", delta: JSON.stringify(approved) }, { type: "complete", stopReason: "stop" },
    ], request => { captured = request; }) });
    await expect(reviewer.review(input)).resolves.toEqual(approved);
    expect(captured).toMatchObject({ model: "review-model", tools: [], maxTokens: 1024, requestTimeoutMs: 30_000 });
    expect(JSON.parse(captured!.messages[0]!.content as string)).toEqual(input);
    expect(captured!.system).toContain("untrusted data");
  });

  it.each([
    { ...approved, risk: "unknown" },
    { ...approved, risk: "high" },
    { ...approved, authorization: "missing" },
  ])("fails closed on insufficient authorization or unknown risk: %j", result => {
    expect(parseApprovalReviewResult(JSON.stringify(result))?.decision).toBe("ask_user");
  });

  it.each([
    "```json\n{}\n```", "{}", JSON.stringify({ ...approved, extra: true }),
    JSON.stringify({ ...approved, reason: " " }), JSON.stringify({ ...approved, reason: "x".repeat(1001) }),
  ])("rejects malformed model JSON", text => {
    expect(parseApprovalReviewResult(text)).toBeUndefined();
  });

  it.each([
    [{ type: "text_delta", delta: JSON.stringify(approved) }, { type: "complete", stopReason: "max_tokens" }],
    [{ type: "text_delta", delta: JSON.stringify(approved) }],
    [{ type: "tool_use_start", toolUse: { type: "tool_use", id: "x", name: "Write", input: {} } }],
    [{ type: "error", error: new Error("provider unavailable") }],
  ] satisfies StreamEvent[][])("returns to the user for failed or incomplete streams", async (...events) => {
    const reviewer = createApprovalReviewer({ model: "m", client: clientFor(events) });
    await expect(reviewer.review(input)).resolves.toMatchObject({ decision: "ask_user", authorization: "missing" });
  });

  it("enforces a total 30 second deadline even if the provider ignores abort", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const reviewer = createApprovalReviewer({ model: "m", client: { streamMessage(params) {
        requestSignal = params.abortSignal;
        return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<StreamEvent>>(() => {}) }) };
      } } });
      const waiting = reviewer.review(input);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(waiting).resolves.toMatchObject({ decision: "ask_user", failure: "timeout" });
      expect(requestSignal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("propagates cancellation so the broker can retain expired status", async () => {
    const controller = new AbortController();
    const reviewer = createApprovalReviewer({ model: "m", client: { streamMessage() {
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<StreamEvent>>(() => {}) }) };
    } } });
    const waiting = reviewer.review(input, controller.signal);
    controller.abort(new Error("interrupted"));
    await expect(waiting).rejects.toThrow("interrupted");
  });
});


describe("approval credentials boundary", () => {
  it("does not dispatch a second model request containing user credentials", async () => {
    let calls = 0;
    const reviewer = createApprovalReviewer({ model: "offline", client: { async *streamMessage() { calls++; yield { type: "complete" as const, stopReason: "end_turn" }; } } });
    const outcome = await reviewer.review({
      requestId: "request-secret", sessionId: "session", inputId: "input", runtimeRevision: 0,
      tool: { name: "Write", source: "builtin" }, input: { file_path: "config.txt", content: "ordinary" },
      evidence: { userInstruction: "Use API_KEY=example-private-credential to configure", cwd: "/repo", accessBoundary: "/repo", denyRules: [], reliableIsolation: true },
    });
    expect(outcome.decision).toBe("ask_user");
    expect(calls).toBe(0);
  });
});
