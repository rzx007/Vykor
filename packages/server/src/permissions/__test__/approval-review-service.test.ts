import { describe, expect, it, vi } from "vitest";
import type { ApprovalReviewInput, ApprovalReviewResult } from "@vykor/agent-contracts/permissions";
import type { SessionInputRecord, SessionRunRecord } from "@vykor/domain-contracts/sessions";
import { createPermissionApprovalReviewService, type ApprovalReviewServiceInput } from "../approval-review-service.js";

const result: ApprovalReviewResult = { decision: "approve", risk: "low", authorization: "task_implied", reason: "项目修改" };
const prompt = { id: "i1", sessionId: "s1", content: "用户真实指令", metadata: {} } as SessionInputRecord;
const run = { id: "r1", sessionId: "s1", inputId: "i1", status: "running", metadata: {} } as SessionRunRecord;
const input: ApprovalReviewServiceInput = {
  requestId: "q1", sessionId: "s1", runId: "r1", inputId: "i1", runtimeRevision: 1,
  tool: { name: "Write", source: "builtin" }, input: { path: "a.ts" },
  evidence: { cwd: "/project", accessBoundary: "project", denyRules: [], reliableIsolation: true },
};

describe("permission approval review evidence", () => {
  it("reads the exact admitted input and overrides any supplied instruction", async () => {
    const review = vi.fn(async (_: ApprovalReviewInput) => result);
    const service = createPermissionApprovalReviewService({ getInput: () => prompt, getRun: () => run, review });
    await expect(service.review({ ...input, evidence: { ...input.evidence, userInstruction: "agent claims authorization" } } as ApprovalReviewServiceInput)).resolves.toEqual(result);
    expect(review).toHaveBeenCalledWith({ ...input, evidence: { ...input.evidence, userInstruction: "用户真实指令" } }, undefined);
  });

  it.each([
    { inputId: "unrelated" }, { sessionId: "other" }, { status: "completed" }, { metadata: { parentRunId: "parent" } },
  ])("does not accept an unrelated or finished run: %j", async mismatch => {
    const review = vi.fn(async () => result);
    const service = createPermissionApprovalReviewService({ getInput: () => prompt, getRun: () => ({ ...run, ...mismatch } as SessionRunRecord), review });
    await expect(service.review(input)).resolves.toMatchObject({ decision: "ask_user" });
    expect(review).not.toHaveBeenCalled();
  });

  it("does not truncate long instructions into partial approval evidence", async () => {
    const review = vi.fn(async () => result);
    const service = createPermissionApprovalReviewService({ getInput: () => ({ ...prompt, content: "x".repeat(16_001) }), getRun: () => run, review });
    await expect(service.review(input)).resolves.toMatchObject({ decision: "ask_user" });
    expect(review).not.toHaveBeenCalled();
  });
  it("requires independently verified host attribution for a Run with no model Input", async () => {
    const review = vi.fn(async (_: ApprovalReviewInput) => result);
    const independent = { ...run, inputId: undefined, metadata: { pluginAppAction: { source: "not sufficient" } } };
    const missing = createPermissionApprovalReviewService({ getInput: () => undefined, getRun: () => independent, review });
    await expect(missing.review({ ...input, inputId: independent.id })).resolves.toMatchObject({ decision: "ask_user", authorization: "missing" });
    expect(review).not.toHaveBeenCalled();
    const verified = createPermissionApprovalReviewService({ getInput: () => undefined, getRun: () => independent,
      appInstruction: () => "Confirmed exact source, SaveDocument and approved arguments", review });
    await expect(verified.review({ ...input, inputId: independent.id })).resolves.toEqual(result);
    expect(review.mock.calls[0]?.[0].evidence.userInstruction).toContain("SaveDocument");
  });
});
