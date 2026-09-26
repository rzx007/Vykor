import { describe, expect, it } from "vitest";

import type { SessionMessagePartRecord } from "@vykor/protocol";
import {
  isCommittedPublicTextPart,
  isPublicTextPart,
  publicTextFromParts,
} from "../transcript-text.js";

function textPart(id: string, text: string, metadata: Record<string, unknown> = {}): SessionMessagePartRecord {
  return {
    id,
    sessionId: "s1",
    messageId: "m1",
    seq: 1,
    type: "text",
    status: "completed",
    text,
    metadata,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("transcript public text filtering", () => {
  it("excludes superseded parts from public text", () => {
    const parts = [
      textPart("p1", "旧的", { modelGeneration: { generationId: "g1", attempt: 1, superseded: true } }),
      textPart("p2", "新的", { modelGeneration: { generationId: "g1", attempt: 2, committed: true } }),
    ];
    expect(publicTextFromParts(parts)).toBe("新的");
    expect(isPublicTextPart(parts[0]!)).toBe(false);
  });

  it("keeps legacy parts visible", () => {
    expect(publicTextFromParts([textPart("p1", "legacy")])).toBe("legacy");
  });

  it("can additionally require committed text for memory/summary use", () => {
    const uncommitted = textPart("p1", "半截", {
      modelGeneration: { generationId: "g1", attempt: 1, committed: false },
    });
    expect(publicTextFromParts([uncommitted], "", { requireCommitted: true })).toBe("");
    expect(isCommittedPublicTextPart(uncommitted)).toBe(false);
    expect(publicTextFromParts([uncommitted])).toBe("半截");
  });
});
