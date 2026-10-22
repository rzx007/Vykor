import type { StreamingMessageClient } from "@vykor/agent-contracts";
import { describe, expect, it, vi } from "vitest";
import type { Settings } from "@vykor/host-config";

import type { ApprovalReviewInput } from "@vykor/protocol";
import { resolveApiClient } from "../runtime/default-runtime-provider.js";
import { createConfiguredApprovalReviewer } from "./configured-approval-reviewer.js";

vi.mock("../runtime/default-runtime-provider.js", () => ({ resolveApiClient: vi.fn() }));

describe("configured approval reviewer", () => {
  it("keeps provider resolution private and preserves an explicitly cleared base URL", async () => {
    const result = { decision: "approve", risk: "low", authorization: "task_implied", reason: "Within task" };
    const streamMessage = vi.fn(async function* () {
      yield { type: "text_delta" as const, delta: JSON.stringify(result) };
      yield { type: "complete" as const, stopReason: "end_turn" };
    });
    vi.mocked(resolveApiClient).mockResolvedValue({ streamMessage } as StreamingMessageClient);
    const settings = { model: "default-model" } as Settings;
    const reviewer = await createConfiguredApprovalReviewer({ settings, model: "session-model", provider: "session-provider", baseUrl: "", apiFormat: "openai", sessionId: "s" });
    expect(resolveApiClient).toHaveBeenCalledWith(settings, { model: "session-model", provider: "session-provider", baseUrl: "", apiFormat: "openai" }, undefined, "s");
    const input = { requestId: "q", sessionId: "s", inputId: "i", runtimeRevision: 1, tool: { name: "Write", source: "builtin" }, input: { path: "a.ts" }, evidence: { userInstruction: "Edit a.ts", cwd: "/repo", accessBoundary: "/repo", denyRules: [], reliableIsolation: true } } satisfies ApprovalReviewInput;
    await expect(reviewer.review(input)).resolves.toEqual(result);
    expect(streamMessage).toHaveBeenCalledWith(expect.objectContaining({ model: "session-model", tools: [] }));
  });
});
