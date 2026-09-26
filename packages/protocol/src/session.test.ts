import { describe, expect, it } from "vitest";

import {
  isCommittedModelPart,
  isSupersededModelPart,
  readModelGenerationMetadata,
  readSessionModelAttemptUsage,
  readSessionModelRetryState,
  readSessionModelUsage,
  type SessionMessagePartRecord,
} from "./session.js";

function part(metadata: Record<string, unknown>): SessionMessagePartRecord {
  return {
    id: "p1",
    sessionId: "s1",
    messageId: "m1",
    seq: 1,
    type: "text",
    status: "completed",
    metadata,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("readSessionModelRetryState", () => {
  const valid = {
    generationId: "g1",
    attempt: 2,
    retryNumber: 1,
    maxRetries: 5,
    reason: "network",
    nextRetryAt: 1_000,
    recoveryDeadlineAt: 180_000,
  };

  it("reads a well-formed retry state", () => {
    expect(readSessionModelRetryState({ modelRetry: valid })).toEqual(valid);
  });

  it("rejects malformed metadata", () => {
    expect(readSessionModelRetryState({})).toBeUndefined();
    expect(readSessionModelRetryState({ modelRetry: { ...valid, attempt: 0 } })).toBeUndefined();
    expect(readSessionModelRetryState({ modelRetry: { ...valid, reason: "bogus" } })).toBeUndefined();
    expect(readSessionModelRetryState({ modelRetry: { ...valid, nextRetryAt: Number.NaN } })).toBeUndefined();
    expect(readSessionModelRetryState({ modelRetry: null })).toBeUndefined();
  });
});

describe("model generation metadata", () => {
  it("treats legacy parts as committed and not superseded", () => {
    const legacy = part({});
    expect(isCommittedModelPart(legacy)).toBe(true);
    expect(isSupersededModelPart(legacy)).toBe(false);
    expect(readModelGenerationMetadata(legacy.metadata)).toBeUndefined();
  });

  it("requires committed=true for new-format parts", () => {
    const pending = part({ modelGeneration: { generationId: "g1", attempt: 1, committed: false } });
    expect(isCommittedModelPart(pending)).toBe(false);

    const committed = part({ modelGeneration: { generationId: "g1", attempt: 1, committed: true } });
    expect(isCommittedModelPart(committed)).toBe(true);
  });

  it("never treats a superseded part as committed", () => {
    const superseded = part({
      modelGeneration: { generationId: "g1", attempt: 1, superseded: true, committed: true },
    });
    expect(isSupersededModelPart(superseded)).toBe(true);
    expect(isCommittedModelPart(superseded)).toBe(false);
  });
});

describe("readSessionModelAttemptUsage", () => {
  it("allows unknown settlements without usage", () => {
    expect(readSessionModelAttemptUsage({
      generationId: "g1", attempt: 1, status: "failed", usageStatus: "unknown",
    })).toEqual({
      generationId: "g1", attempt: 1, status: "failed", usageStatus: "unknown",
    });
  });

  it("rejects a complete settlement without usage", () => {
    expect(readSessionModelAttemptUsage({
      generationId: "g1", attempt: 1, status: "completed", usageStatus: "complete",
    })).toBeUndefined();
  });

  it("reads partial usage with known numbers", () => {
    expect(readSessionModelAttemptUsage({
      generationId: "g1", attempt: 2, status: "failed", usageStatus: "partial",
      usage: { inputTokens: 10, outputTokens: 2 },
    })).toEqual({
      generationId: "g1", attempt: 2, status: "failed", usageStatus: "partial",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
  });

  it("rejects invalid numbers and unknown statuses", () => {
    expect(readSessionModelAttemptUsage({
      generationId: "g1", attempt: 1, status: "completed", usageStatus: "complete",
      usage: { inputTokens: -1, outputTokens: 0 },
    })).toBeUndefined();
    expect(readSessionModelAttemptUsage({
      generationId: "g1", attempt: 1, status: "weird", usageStatus: "complete",
      usage: { inputTokens: 1, outputTokens: 0 },
    })).toBeUndefined();
  });
});

describe("readSessionModelUsage", () => {
  it("reads the completeness summary", () => {
    expect(readSessionModelUsage({
      modelUsage: { incomplete: true, unknownAttempts: 1, partialAttempts: 2 },
    })).toEqual({ incomplete: true, unknownAttempts: 1, partialAttempts: 2 });
  });

  it("returns undefined when absent and defaults missing counters to 0", () => {
    expect(readSessionModelUsage({})).toBeUndefined();
    expect(readSessionModelUsage({ modelUsage: { incomplete: false } })).toEqual({
      incomplete: false, unknownAttempts: 0, partialAttempts: 0,
    });
  });
});
