import { describe, expect, it } from "vitest";

import {
  selectSessionModelRetry,
  selectSessionModelUsage,
  selectVisibleSessionMessagesWithParts,
} from "../selectors.js";

function bucket(overrides: Record<string, unknown> = {}): any {
  return {
    session: { id: "s1" },
    inputs: [],
    messages: [],
    partsByMessageId: {},
    runs: {},
    tasks: {},
    permissions: {},
    ...overrides,
  };
}

describe("selectVisibleSessionMessagesWithParts", () => {
  it("filters superseded parts and drops assistant messages with no visible parts", () => {
    const view = selectVisibleSessionMessagesWithParts(bucket({
      messages: [
        { id: "m1", seq: 1, role: "assistant", metadata: {} },
        { id: "m2", seq: 2, role: "assistant", metadata: {} },
      ],
      partsByMessageId: {
        m1: [
          { id: "p1", messageId: "m1", seq: 1, type: "text", text: "旧", metadata: { modelGeneration: { generationId: "g1", attempt: 1, superseded: true } } },
        ],
        m2: [
          { id: "p2", messageId: "m2", seq: 2, type: "text", text: "新", metadata: {} },
        ],
      },
    }));

    expect(view.map((row) => row.message.id)).toEqual(["m2"]);
    expect(view[0]!.parts.map((part) => part.text)).toEqual(["新"]);
  });

  it("keeps user messages even when they have no parts", () => {
    const view = selectVisibleSessionMessagesWithParts(bucket({
      messages: [{ id: "m1", seq: 1, role: "user", metadata: {} }],
      partsByMessageId: {},
    }));
    expect(view).toHaveLength(1);
  });
});

describe("selectSessionModelRetry", () => {
  it("returns the wait state of an active run", () => {
    const state = selectSessionModelRetry(bucket({
      runs: {
        r1: {
          id: "r1", status: "running", updatedAt: 5,
          metadata: {
            modelRetry: {
              generationId: "g1", attempt: 1, retryNumber: 2, maxRetries: 5,
              reason: "network", nextRetryAt: 1_000, recoveryDeadlineAt: 180_000,
            },
          },
        },
      },
    }));
    expect(state).toMatchObject({ generationId: "g1", retryNumber: 2, reason: "network" });
  });

  it("ignores terminal runs and malformed metadata", () => {
    expect(selectSessionModelRetry(bucket({
      runs: {
        r1: { id: "r1", status: "completed", updatedAt: 5, metadata: { modelRetry: { generationId: "g1" } } },
      },
    }))).toBeUndefined();
  });
});

describe("selectSessionModelUsage", () => {
  it("returns the most recent run's completeness summary", () => {
    expect(selectSessionModelUsage(bucket({
      runs: {
        r1: { id: "r1", status: "completed", updatedAt: 1, metadata: { modelUsage: { incomplete: false, unknownAttempts: 0, partialAttempts: 0 } } },
        r2: { id: "r2", status: "completed", updatedAt: 2, metadata: { modelUsage: { incomplete: true, unknownAttempts: 1, partialAttempts: 0 } } },
      },
    }))).toEqual({ incomplete: true, unknownAttempts: 1, partialAttempts: 0 });
  });
});
