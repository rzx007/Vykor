import { describe, expect, it } from "vitest";
import type { StreamMessageParams, StreamingMessageClient } from "@vykor/agent-contracts";
import type { ApprovalReviewInput, ApprovalReviewResult } from "@vykor/agent-contracts/permissions";
import { createApprovalReviewer, hasApprovalSecrets } from "../approval-reviewer.js";

const approved: ApprovalReviewResult = { decision: "approve", risk: "low", authorization: "task_implied", reason: "只检查项目状态。" };
const fixture: ApprovalReviewInput = {
  requestId: "q", sessionId: "s", inputId: "i", runtimeRevision: 1,
  tool: { name: "Shell", source: "builtin" }, input: { command: "git status --short" },
  evidence: { userInstruction: "检查项目状态", cwd: "/repo", accessBoundary: "project", denyRules: [], reliableIsolation: false },
};
const syntheticKey = "gsk_syntheticFixtureKey0123456789";
const credentials = [
  syntheticKey, "sk-syntheticFixtureKey0123456789", "sk-proj-syntheticFixtureKey0123456789",
  "github_pat_syntheticFixtureKey0123456789", "ghp_syntheticFixtureKey0123456789",
  "Bearer syntheticBearer0123456789", "-----BEGIN PRIVATE KEY-----\nsynthetic-only\n-----END PRIVATE KEY-----",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.syntheticSignature0123456789",
  "https://fixture-user:fixture-password@example.invalid/private", "password=synthetic-password",
  "token=synthetic-token", "Cookie: session=synthetic-cookie; mode=synthetic-mode",
  "密码=synthetic-zh-password", "我的密钥：synthetic-zh-key", "令牌＝synthetic-zh-token",
  "Basic c3ludGhldGljOnBhc3N3b3Jk",
];

function captureClient(requests: StreamMessageParams[], result = approved): StreamingMessageClient {
  return { async *streamMessage(request) {
    requests.push(request);
    yield { type: "text_delta", delta: JSON.stringify(result) };
    yield { type: "complete", stopReason: "end_turn" };
  } };
}

describe("approval credential preparation", () => {
  it.each(credentials)("does not send a current user credential to an independent model: %s", async credential => {
    const requests: StreamMessageParams[] = [];
    const reviewer = createApprovalReviewer({ model: "test", client: captureClient(requests) });
    const outcome = await reviewer.review({ ...fixture, evidence: { ...fixture.evidence, userInstruction: `使用 ${credential} 检查配置` } });
    expect(outcome).toMatchObject({ decision: "ask_user", failure: "unavailable" });
    expect(requests).toHaveLength(0);
    expect(outcome.reason).not.toContain(credential);
  });

  it.each(credentials)("does not send credentials embedded in the actual command: %s", async credential => {
    const requests: StreamMessageParams[] = [];
    const reviewer = createApprovalReviewer({ model: "test", client: captureClient(requests) });
    await expect(reviewer.review({ ...fixture, input: { command: `printf '${credential}'` } })).resolves.toMatchObject({ decision: "ask_user" });
    expect(requests).toHaveLength(0);
  });

  it.each(["password", "token", "cookie", "authorization", "apiKey", "refreshToken"])("keeps structured credential field %s out of the model request", async field => {
    const requests: StreamMessageParams[] = [];
    const reviewer = createApprovalReviewer({ model: "test", client: captureClient(requests) });
    await expect(reviewer.review({ ...fixture, input: { config: { [field]: "synthetic-value" } } })).resolves.toMatchObject({ decision: "ask_user" });
    expect(requests).toHaveLength(0);
  });

  it("redacts historical credential fragments while preserving restrictions and chronological instructions", async () => {
    const requests: StreamMessageParams[] = [];
    const reviewInput = structuredClone(fixture);
    reviewInput.evidence.userInstructionHistory = [
      { inputId: "old-key", content: `使用旧凭据 ${syntheticKey}；禁止部署，也不要上传源码。` },
      { inputId: "later", content: "只检查状态，前面的禁止仍有效。" },
    ];
    const original = structuredClone(reviewInput);
    const reviewer = createApprovalReviewer({ model: "test", client: captureClient(requests) });
    await expect(reviewer.review(reviewInput)).resolves.toEqual(approved);
    expect(requests).toHaveLength(1);
    const sent = JSON.parse(requests[0]!.messages[0]!.content as string) as ApprovalReviewInput;
    expect(sent.evidence.userInstructionHistory).toEqual([
      { inputId: "old-key", content: "使用旧凭据 [已移除凭据]；禁止部署，也不要上传源码。" },
      { inputId: "later", content: "只检查状态，前面的禁止仍有效。" },
    ]);
    expect(JSON.stringify(requests)).not.toContain(syntheticKey);
    expect(reviewInput).toEqual(original);
  });

  it.each(credentials)("redacts context credentials and retains surrounding reference restrictions: %s", async credential => {
    const requests: StreamMessageParams[] = [];
    const reviewer = createApprovalReviewer({ model: "test", client: captureClient(requests) });
    await expect(reviewer.review({ ...fixture, evidence: { ...fixture.evidence,
      context: [{ kind: "tool_output", content: `旧配置：${credential}\n禁止部署；只读取公开页面。` }],
    } })).resolves.toEqual(approved);
    expect(requests).toHaveLength(1);
    const serialized = requests[0]!.messages[0]!.content as string;
    expect(serialized).not.toContain(credential);
    expect(serialized).toContain("禁止部署；只读取公开页面。");
    expect(serialized).toContain("[已移除凭据]");
    for (const atom of ["syntheticFixtureKey0123456789", "syntheticBearer0123456789", "synthetic-only",
      "syntheticSignature0123456789", "fixture-password", "synthetic-password", "synthetic-token",
      "synthetic-cookie", "synthetic-mode", "synthetic-zh-password", "synthetic-zh-key", "synthetic-zh-token", "c3ludGhldGljOnBhc3N3b3Jk"]) {
      expect(serialized).not.toContain(atom);
    }
  });

  it("redacts quoted credential fields inside a JSON reference while retaining its structure and restrictions", async () => {
    const requests: StreamMessageParams[] = [];
    const reviewer = createApprovalReviewer({ model: "test", client: captureClient(requests) });
    await expect(reviewer.review({ ...fixture, evidence: { ...fixture.evidence,
      context: [{ kind: "reference", content: JSON.stringify({ apiKey: "synthetic-json-private", cookie: "session=synthetic-session", instruction: "禁止部署，只检查配置。" }) }],
    } })).resolves.toEqual(approved);
    const sent = JSON.parse(requests[0]!.messages[0]!.content as string) as ApprovalReviewInput;
    expect(JSON.parse(sent.evidence.context![0]!.content)).toEqual({ apiKey: "[已移除凭据]", cookie: "[已移除凭据]", instruction: "禁止部署，只检查配置。" });
    expect(JSON.stringify(requests)).not.toContain("synthetic-json-private");
    expect(JSON.stringify(requests)).not.toContain("synthetic-session");
  });

  it.each(["--token \"synthetic-value", 'api_key="synthetic\\"remaining-private"', "password=first private phrase", "Authorization: Digest response=synthetic-digest"]) (
    "falls back if a credential's quoted extent cannot be safely determined: %s", async content => {
      const requests: StreamMessageParams[] = [];
      const reviewer = createApprovalReviewer({ model: "test", client: captureClient(requests) });
      await expect(reviewer.review({ ...fixture, evidence: { ...fixture.evidence,
        userInstructionHistory: [{ inputId: "old", content: `${content}；禁止部署。` }],
      } })).resolves.toMatchObject({ decision: "ask_user" });
      expect(requests).toHaveLength(0);
    },
  );

  it.each([
    "GROQ_API_KEY=synthetic_private_value", '"OPENAI_API_KEY":"synthetic_private_value"',
    "$env:AWS_SECRET_ACCESS_KEY = 'synthetic_private_value'",
  ])("protects complete environment credential names in current, tool, history and context inputs: %s", async assignment => {
    for (const location of ["current", "tool", "history", "context"] as const) {
      const requests: StreamMessageParams[] = [];
      const reviewer = createApprovalReviewer({ model: "test", client: captureClient(requests) });
      const reviewInput = structuredClone(fixture);
      if (location === "current") reviewInput.evidence.userInstruction = assignment;
      if (location === "tool") reviewInput.input.command = assignment;
      if (location === "history") reviewInput.evidence.userInstructionHistory = [{ inputId: "old", content: `${assignment}；禁止部署。` }];
      if (location === "context") reviewInput.evidence.context = [{ kind: "reference", content: `${assignment}；禁止部署。` }];
      const outcome = await reviewer.review(reviewInput);
      if (location === "current" || location === "tool") {
        expect(outcome.decision).toBe("ask_user");
        expect(requests).toHaveLength(0);
      } else {
        expect(outcome).toEqual(approved);
        expect(requests).toHaveLength(1);
        const sent = requests[0]!.messages[0]!.content as string;
        expect(sent).not.toContain("synthetic_private_value");
        expect(sent).toContain("禁止部署。");
      }
    }
  });

  it("retries from one sanitized snapshot even if the caller changes its original history", async () => {
    const reviewInput = structuredClone(fixture);
    reviewInput.evidence.userInstructionHistory = [{ inputId: "old", content: `${syntheticKey}；禁止部署。` }];
    const requests: StreamMessageParams[] = [];
    const reviewer = createApprovalReviewer({ model: "test", client: { async *streamMessage(request) {
      requests.push(request);
      if (requests.length === 1) {
        reviewInput.evidence.userInstructionHistory = [{ inputId: "changed", content: "允许部署" }];
        yield { type: "complete", stopReason: "max_tokens" };
      } else {
        yield { type: "text_delta", delta: JSON.stringify(approved) };
        yield { type: "complete", stopReason: "end_turn" };
      }
    } } });
    await expect(reviewer.review(reviewInput)).resolves.toEqual(approved);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages).toEqual(requests[0]!.messages);
    expect(requests[0]!.messages[0]!.content).toContain("禁止部署。");
    expect(JSON.stringify(requests)).not.toContain(syntheticKey);
  });

  it("falls back before dispatch if a historical private key block is incomplete", async () => {
    const requests: StreamMessageParams[] = [];
    const reviewer = createApprovalReviewer({ model: "test", client: captureClient(requests) });
    await expect(reviewer.review({ ...fixture, evidence: { ...fixture.evidence,
      userInstructionHistory: [{ inputId: "old", content: "-----BEGIN PRIVATE KEY-----\nsynthetic-only\n禁止部署。" }],
    } })).resolves.toMatchObject({ decision: "ask_user" });
    expect(requests).toHaveLength(0);
  });

  it("does not return a credential repeated in a model reason", async () => {
    const requests: StreamMessageParams[] = [];
    const reviewer = createApprovalReviewer({ model: "test", client: captureClient(requests, { ...approved, reason: `使用 ${syntheticKey} 完成。` }) });
    const outcome = await reviewer.review(fixture);
    expect(outcome).toMatchObject({ decision: "ask_user", failure: "invalid_response" });
    expect(outcome.reason).not.toContain(syntheticKey);
  });

  it.each([
    "c9f8ac639b34dab7d92e8a11d7f3dfddc614647c3955c46f94cc497b0a43518d",
    "fb6b533a-ae79-4482-9e28-e563ed2cef7c", "/repo/packages/token-budget/src/api_key_notes.ts",
    "检查 token budget 和 cookie 文档，不要修改配置。",
    "$env:GROQ_API_KEY", "process.env.OPENAI_API_KEY", "echo $AWS_SECRET_ACCESS_KEY",
  ])("does not treat an ordinary hash, identifier, path or prose as a credential: %s", value => {
    expect(hasApprovalSecrets(value)).toBe(false);
  });
});
