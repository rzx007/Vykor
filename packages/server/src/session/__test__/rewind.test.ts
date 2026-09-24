import { describe, expect, it } from "vitest";

import { rewindTranscript } from "../rewind.js";
import type { SessionMessagePartRecord, SessionMessageRecord } from "@vykor/protocol";

function message(
  id: string,
  seq: number,
  role: SessionMessageRecord["role"],
): SessionMessageRecord {
  return {
    id,
    sessionId: "s1",
    seq,
    role,
    metadata: {},
    createdAt: seq,
    updatedAt: seq,
  };
}

function textPart(id: string, messageId: string, seq: number, text: string): SessionMessagePartRecord {
  return {
    id,
    sessionId: "s1",
    messageId,
    seq,
    type: "text",
    status: "completed",
    text,
    metadata: {},
    createdAt: seq,
    updatedAt: seq,
  };
}

describe("rewindTranscript", () => {
  it("removes the last user turn and trailing assistant messages", () => {
    const messages = [
      message("m1", 1, "user"),
      message("m2", 2, "assistant"),
      message("m3", 3, "user"),
      message("m4", 4, "assistant"),
    ];
    const parts = [
      textPart("p1", "m1", 1, "hello"),
      textPart("p2", "m2", 2, "hi"),
      textPart("p3", "m3", 3, "again"),
      textPart("p4", "m4", 4, "ok"),
    ];

    const result = rewindTranscript(messages, parts, 1);
    expect(result.turns).toBe(1);
    expect(result.removed).toBe(2);
    expect(result.kept.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(result.kept[0]?.parts[0]?.text).toBe("hello");
  });

  it("returns empty kept when rewinding past all turns", () => {
    const messages = [message("m1", 1, "user")];
    const parts = [textPart("p1", "m1", 1, "only")];
    const result = rewindTranscript(messages, parts, 3);
    expect(result.turns).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.kept).toEqual([]);
  });
});
