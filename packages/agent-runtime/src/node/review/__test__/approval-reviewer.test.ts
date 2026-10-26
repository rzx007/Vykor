import type { StreamEvent, StreamMessageParams, StreamingMessageClient } from "@vykor/agent-contracts";
import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleClient } from "@vykor/api";

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
    expect(captured).toMatchObject({ model: "review-model", tools: [], requestTimeoutMs: 30_000 });
    expect(JSON.parse(captured!.messages[0]!.content as string)).toEqual(input);
    expect(captured!.system).toContain("untrusted data");
  });

  it("leaves room for reasoning before a BackgroundShellCreate decision without an extra request", async () => {
    let requests = 0;
    const reviewer = createApprovalReviewer({ model: "reasoning-model", client: { async *streamMessage(params) {
      requests++;
      yield { type: "reasoning_delta", delta: "Assess the exact command and user authorization." };
      if ((params.maxTokens ?? 0) < 2_048) {
        yield { type: "complete", stopReason: "max_tokens" };
        return;
      }
      yield { type: "text_delta", delta: JSON.stringify(approved) };
      yield { type: "complete", stopReason: "stop" };
    } } });
    await expect(reviewer.review({ ...input,
      tool: { name: "BackgroundShellCreate", source: "builtin" },
      input: { description: "Inspect project status", command: "git status --short" },
    })).resolves.toEqual(approved);
    expect(requests).toBe(1);
  });

  it("recovers an OpenAI-compatible length finish with one larger independent review", async () => {
    const reviewInput = structuredClone(input);
    const client = new OpenAICompatibleClient({ apiKey: "test", baseURL: "https://review.invalid/v1" });
    let requests = 0;
    const create = vi.fn(async (_params: unknown) => {
      const truncated = ++requests === 1;
      return { async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { reasoning_content: "Check the background command." }, finish_reason: null }] };
        yield { choices: [{ delta: truncated ? {} : { content: JSON.stringify(approved) }, finish_reason: truncated ? "length" : "stop" }] };
        if (truncated) reviewInput.input.path = "/project/changed.ts";
      } };
    });
    client.client = { chat: { completions: { create } } } as unknown as typeof client.client;
    const reviewer = createApprovalReviewer({ model: "reasoning-model", client });
    await expect(reviewer.review(reviewInput)).resolves.toEqual(approved);
    expect(create).toHaveBeenCalledTimes(2);
    const [first, second] = create.mock.calls.map(([params]) => params as { max_tokens: number; tools?: unknown; messages: unknown });
    expect(second!.max_tokens).toBeGreaterThan(first!.max_tokens);
    expect(second!.messages).toEqual(first!.messages);
    expect(second!.tools).toBeUndefined();
  });

  it("discards a truncated approval before using the fresh review's request for confirmation", async () => {
    const confirmation = { decision: "ask_user", risk: "unknown", authorization: "missing", reason: "Command effects are unclear." };
    let requests = 0;
    const reviewer = createApprovalReviewer({ model: "m", client: { async *streamMessage() {
      requests++;
      yield { type: "text_delta", delta: requests === 1 ? '{"decision":"approve"' : JSON.stringify(confirmation) };
      yield { type: "complete", stopReason: requests === 1 ? "max_tokens" : "end_turn" };
    } } });
    await expect(reviewer.review(input)).resolves.toEqual(confirmation);
    expect(requests).toBe(2);
  });

  it("never accepts truncated approval JSON and stops after one retry", async () => {
    let requests = 0;
    const reviewer = createApprovalReviewer({ model: "m", client: { async *streamMessage() {
      requests++;
      yield { type: "text_delta", delta: JSON.stringify(approved) };
      yield { type: "complete", stopReason: "max_tokens" };
    } } });
    await expect(reviewer.review(input)).resolves.toMatchObject({ decision: "ask_user", failure: "invalid_response" });
    expect(requests).toBe(2);
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
    [{ type: "text_delta", delta: JSON.stringify(approved) }, { type: "complete", stopReason: "content_filter" }],
    [{ type: "text_delta", delta: "invalid JSON" }, { type: "complete", stopReason: "stop" }],
    [{ type: "text_delta", delta: JSON.stringify(approved) }],
    [{ type: "tool_use_start", toolUse: { type: "tool_use", id: "x", name: "Write", input: {} } }],
    [{ type: "error", error: new Error("provider unavailable") }],
  ] satisfies StreamEvent[][])("returns to the user for failed or incomplete streams", async (...events) => {
    let requests = 0;
    const reviewer = createApprovalReviewer({ model: "m", client: clientFor(events, () => { requests++; }) });
    await expect(reviewer.review(input)).resolves.toMatchObject({ decision: "ask_user", authorization: "missing" });
    expect(requests).toBe(1);
  });

  it("shares the total deadline across the initial review and truncation retry", async () => {
    vi.useFakeTimers();
    try {
      let requests = 0;
      let retrySignal: AbortSignal | undefined;
      const reviewer = createApprovalReviewer({ model: "m", client: { async *streamMessage(params) {
        requests++;
        if (requests === 1) {
          await new Promise(resolve => setTimeout(resolve, 20_000));
          yield { type: "complete", stopReason: "max_tokens" };
          return;
        }
        retrySignal = params.abortSignal;
        await new Promise(() => {});
      } } });
      const waiting = reviewer.review(input);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(requests).toBe(2);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(waiting).resolves.toMatchObject({ decision: "ask_user", failure: "timeout" });
      expect(retrySignal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("does not start a retry if the user cancels after a truncated response", async () => {
    const controller = new AbortController();
    let requests = 0;
    const reviewer = createApprovalReviewer({ model: "m", client: { async *streamMessage() {
      requests++;
      yield { type: "complete", stopReason: "max_tokens" };
      controller.abort(new Error("interrupted"));
    } } });
    await expect(reviewer.review(input, controller.signal)).rejects.toThrow("interrupted");
    expect(requests).toBe(1);
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
