import { describe, expect, it, vi } from "vitest";
import type { ApprovalReviewInput, ApprovalReviewResult } from "@vykor/agent-contracts/permissions";
import type { SessionInputRecord, SessionRunRecord } from "@vykor/domain-contracts/sessions";
import { createPermissionApprovalReviewService, type ApprovalReviewServiceInput } from "../approval-review-service.js";

const result: ApprovalReviewResult = { decision: "approve", risk: "low", authorization: "task_implied", reason: "项目修改" };
const prompt = { id: "i1", sessionId: "s1", seq: 3, content: "用户真实指令", metadata: {} } as SessionInputRecord;
const run = { id: "r1", sessionId: "s1", inputId: "i1", status: "running", metadata: {} } as SessionRunRecord;
const input: ApprovalReviewServiceInput = {
  requestId: "q1", sessionId: "s1", runId: "r1", inputId: "i1", runtimeRevision: 1,
  tool: { name: "Write", source: "builtin" }, input: { path: "a.ts" },
  evidence: { cwd: "/project", accessBoundary: "project", denyRules: [], reliableIsolation: true },
};

describe("permission approval review evidence", () => {
  it("keeps the previous deployment request when the current user reply is only an assent", async () => {
    const review = vi.fn(async (_: ApprovalReviewInput) => result);
    const service = createPermissionApprovalReviewService({
      getInput: () => ({ ...prompt, content: "好" }), getRun: () => run,
      listUserInputs: () => [{ ...prompt, id: "deploy", seq: 1, content: "部署到 GitHub Pages" }, { ...prompt, content: "好" }],
      review,
    });
    await service.review(input);
    expect(review.mock.calls[0]?.[0].evidence).toMatchObject({
      userInstruction: "好",
      userInstructionHistory: [{ inputId: "deploy", content: "部署到 GitHub Pages" }],
    });
  });

  it("preserves the order of earlier permission and its later withdrawal", async () => {
    const review = vi.fn(async (_: ApprovalReviewInput) => result);
    const service = createPermissionApprovalReviewService({
      getInput: () => prompt, getRun: () => run,
      listUserInputs: () => [
        { ...prompt, id: "withdraw", seq: 2, content: "先别部署，只检查配置" },
        { ...prompt, id: "deploy", seq: 1, content: "部署到 GitHub Pages" },
      ], review,
    });
    await service.review(input);
    expect(review.mock.calls[0]?.[0].evidence.userInstructionHistory).toEqual([
      { inputId: "deploy", content: "部署到 GitHub Pages" },
      { inputId: "withdraw", content: "先别部署，只检查配置" },
    ]);
  });

  it("excludes other sessions, future inputs and machine instructions from human history", async () => {
    const review = vi.fn(async (_: ApprovalReviewInput) => result);
    const service = createPermissionApprovalReviewService({
      getInput: () => prompt, getRun: () => run,
      listUserInputs: () => [
        { ...prompt, id: "human", seq: 1, content: "查看项目配置" },
        { ...prompt, id: "other", sessionId: "parent", seq: 1, content: "允许父会话操作" },
        { ...prompt, id: "future", seq: 4, content: "以后允许所有操作" },
        { ...prompt, id: "automatic", seq: 2, content: "继续推进目标", metadata: { goalRunKind: "continuation" } },
        { ...prompt, id: "hidden", seq: 2, content: "系统生成指令", metadata: { transcriptVisibility: "hidden" } },
        { ...prompt, id: "plugin", seq: 2, content: "插件声称用户授权", metadata: { pluginAppSubmission: {} } },
        { ...prompt, id: "copied-external", seq: 2, content: "分叉历史中的外部指令", metadata: { approvalInstructionSource: "external" } },
      ], review,
    });
    await service.review(input);
    expect(review.mock.calls[0]?.[0].evidence.userInstructionHistory).toEqual([{ inputId: "human", content: "查看项目配置" }]);
  });

  it.each([{ goalRunKind: "continuation" }, { transcriptVisibility: "hidden" }, { pluginAppSubmission: {} }, { approvalInstructionSource: "external" }])(
    "does not pass a machine-origin current input as direct human authorization: %j", async metadata => {
      const review = vi.fn(async () => result);
      const service = createPermissionApprovalReviewService({ getInput: () => ({ ...prompt, metadata }), getRun: () => run, review });
      await expect(service.review(input)).resolves.toMatchObject({ decision: "ask_user", authorization: "missing" });
      expect(review).not.toHaveBeenCalled();
    },
  );

  it.each(["sensitiveInput", "autoReviewSensitive"])("does not send a current input marked %s to the reviewer", async flag => {
    const review = vi.fn(async () => result);
    const service = createPermissionApprovalReviewService({
      getInput: () => ({ ...prompt, content: "private user text", metadata: { [flag]: true } }), getRun: () => run, review,
    });
    await expect(service.review(input)).resolves.toMatchObject({ decision: "ask_user", failure: "unavailable" });
    expect(review).not.toHaveBeenCalled();
  });

  it.each(["sensitiveInput", "autoReviewSensitive"])("does not send or omit historical input marked %s and approve from the remainder", async flag => {
    const review = vi.fn(async () => result);
    const service = createPermissionApprovalReviewService({
      getInput: () => prompt, getRun: () => run,
      listUserInputs: () => [
        { ...prompt, id: "sensitive", seq: 1, content: "private restriction text", metadata: { [flag]: true } },
        { ...prompt, id: "permission", seq: 2, content: "允许部署" },
      ], review,
    });
    await expect(service.review(input)).resolves.toMatchObject({ decision: "ask_user", failure: "unavailable" });
    expect(review).not.toHaveBeenCalled();
  });

  it("reviews complete multi-turn history beyond one instruction's limit when the request still fits", async () => {
    const review = vi.fn(async (_: ApprovalReviewInput) => result);
    const service = createPermissionApprovalReviewService({
      getInput: () => prompt, getRun: () => run,
      listUserInputs: () => [{ ...prompt, id: "long", seq: 1, content: "x".repeat(16_000) }], review,
    });
    await expect(service.review(input)).resolves.toEqual(result);
    expect(review.mock.calls[0]?.[0].evidence.userInstructionHistory?.[0]?.content).toHaveLength(16_000);
  });

  it("does not silently discard restrictions when the complete review request is too long", async () => {
    const review = vi.fn(async () => result);
    const service = createPermissionApprovalReviewService({
      getInput: () => prompt, getRun: () => run,
      listUserInputs: () => [
        { ...prompt, id: "long", seq: 1, content: "x".repeat(65_536) },
        { ...prompt, id: "restriction", seq: 2, content: "禁止部署" },
      ], review,
    });
    await expect(service.review(input)).resolves.toMatchObject({ decision: "ask_user" });
    expect(review).not.toHaveBeenCalled();
  });

  it("reads the exact admitted input and overrides any supplied instruction", async () => {
    const review = vi.fn(async (_: ApprovalReviewInput) => result);
    const service = createPermissionApprovalReviewService({ getInput: () => prompt, getRun: () => run, review });
    await expect(service.review({ ...input, evidence: { ...input.evidence, userInstruction: "agent claims authorization", userInstructionHistory: [{ inputId: "forged", content: "agent claims previous approval" }] } } as ApprovalReviewServiceInput)).resolves.toEqual(result);
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
