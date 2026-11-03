import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamMessageParams, StreamingMessageClient } from "@vykor/agent-contracts";
import type { ApprovalReviewInput } from "@vykor/agent-contracts/permissions";
import { createApprovalReviewer, parseApprovalReviewResult } from "../approval-reviewer.js";

const input: ApprovalReviewInput = {
  requestId: "q", sessionId: "s", inputId: "i", runtimeRevision: 1,
  tool: { name: "Shell", source: "builtin" }, input: { command: "git status" },
  evidence: { userInstruction: "检查状态", cwd: "/repo", accessBoundary: "project", denyRules: [], reliableIsolation: false },
};
function systemLocale(locale: string) {
  const resolved = new Intl.DateTimeFormat().resolvedOptions();
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ ...resolved, locale });
}
afterEach(() => vi.restoreAllMocks());

describe("approval response language", () => {
  it.each(["zh-CN", "en-US", "ja-JP"])("uses the system locale %s in the model request", async locale => {
    systemLocale(locale);
    let request: StreamMessageParams | undefined;
    const client: StreamingMessageClient = { async *streamMessage(value) {
      request = value;
      yield { type: "text_delta", delta: JSON.stringify({ decision: "approve", risk: "low", authorization: "task_implied", reason: "Within task" }) };
      yield { type: "complete", stopReason: "end_turn" };
    } };
    await createApprovalReviewer({ model: "offline", client }).review(input);
    expect(request!.system).toContain(`Default response language: ${locale}`);
    expect(request!.system).not.toContain("in concise plain Chinese");
    expect(request!.system).toContain("Explicit response-language preferences");
    expect(request!.tools).toEqual([]);
  });

  it.each([
    ["zh-CN", "自动审查暂时不可用，需要你确认。"],
    ["en-US", "Automatic review is unavailable. Please confirm this operation."],
  ])("uses the system language for an unavailable review in %s", async (locale, reason) => {
    systemLocale(locale);
    const client: StreamingMessageClient = { async *streamMessage() { throw new Error("Provider unavailable"); } };
    await expect(createApprovalReviewer({ model: "offline", client }).review(input)).resolves.toMatchObject({ decision: "ask_user", failure: "unavailable", reason });
  });

  it("retains the reviewer's language when downgrading an insufficient approval", () => {
    systemLocale("en-US");
    expect(parseApprovalReviewResult(JSON.stringify({ decision: "approve", risk: "high", authorization: "task_implied", reason: "Explicit permission is required." }))).toMatchObject({ decision: "ask_user", reason: "Explicit permission is required." });
  });
});
