import { expect, test } from "bun:test";
import type {
  SessionBucket,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
} from "@openharness/client";

import { bucketToTranscript } from "./transcript";

function input(id: string, seq: number, content: string, createdAt = seq): SessionInputRecord {
  return {
    id,
    sessionId: "s1",
    seq,
    delivery: "queue",
    content,
    items: [{ type: "text", text: content }],
    attachments: [],
    metadata: {},
    createdAt,
  };
}

function message(id: string, seq: number, role: SessionMessageRecord["role"], inputId?: string): SessionMessageRecord {
  return {
    id,
    sessionId: "s1",
    seq,
    role,
    ...(inputId ? { inputId } : {}),
    metadata: {},
    createdAt: seq,
    updatedAt: seq,
  };
}

function part(messageId: string, seq: number, text: string): SessionMessagePartRecord {
  return {
    id: `p:${messageId}`,
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

function reasoningPart(messageId: string, seq: number, text: string): SessionMessagePartRecord {
  return { ...part(messageId, seq, text), id: `p:${messageId}:reasoning`, type: "reasoning" };
}

function bucket(
  inputs: SessionInputRecord[],
  messages: SessionMessageRecord[],
  parts: SessionMessagePartRecord[],
  sessionUpdatedAt?: number,
): SessionBucket {
  return {
    ...(sessionUpdatedAt === undefined ? {} : {
      session: {
        id: "s1",
        cwd: process.cwd(),
        title: "test",
        model: "test",
        status: "idle",
        metadata: {},
        createdAt: 0,
        updatedAt: sessionUpdatedAt,
      } satisfies SessionRecord,
    }),
    inputs,
    messages,
    partsByMessageId: Object.fromEntries(messages.map((row) => [
      row.id,
      parts.filter((candidate) => candidate.messageId === row.id),
    ])),
    runs: {},
    attempts: {},
    tasks: {},
    permissions: {},
  };
}

test("keeps an admitted input at the transcript tail until its message is projected", () => {
  const inputs = [input("i1", 1, "first"), input("i2", 2, "second"), input("i3", 3, "latest", 5)];
  const messages = [
    message("m1", 1, "user", "i1"),
    message("m2", 2, "assistant"),
    message("m3", 3, "user", "i2"),
    message("m4", 4, "assistant"),
  ];
  const parts = [
    part("m1", 1, "first"),
    part("m2", 1, "reply one"),
    part("m3", 1, "second"),
    part("m4", 1, "reply two"),
  ];

  expect(bucketToTranscript(bucket(inputs, messages, parts)).map((item) => item.text)).toEqual([
    "first",
    "reply one",
    "second",
    "reply two",
    "latest",
  ]);
});

test("matches projected and pending user messages by input id instead of text", () => {
  const inputs = [input("i1", 1, "same"), input("i2", 2, "same")];
  const messages = [message("m1", 1, "user", "i1")];
  const items = bucketToTranscript(bucket(inputs, messages, [part("m1", 1, "same")]));

  expect(items).toEqual([
    { id: "input:i1", role: "user", text: "same" },
    { id: "input:i2", role: "user", text: "same" },
  ]);
});

test("keeps the input-backed row stable when the user message arrives before its part", () => {
  const inputs = [input("i1", 1, "hello")];
  const pending = bucketToTranscript(bucket(inputs, [], []));
  const projected = bucketToTranscript(bucket(inputs, [message("m1", 1, "user", "i1")], []));

  expect(pending).toEqual([{ id: "input:i1", role: "user", text: "hello" }]);
  expect(projected).toEqual(pending);
});

test("does not resurrect historical inputs after compact or rewind replaces message identities", () => {
  const inputs = [input("i1", 1, "old prompt", 1), input("i2", 2, "another old prompt", 2)];
  const messages = [message("replacement", 1, "system")];
  messages[0]!.createdAt = 10;
  messages[0]!.updatedAt = 10;

  expect(bucketToTranscript(bucket(inputs, messages, [part("replacement", 1, "compacted history")]))).toEqual([
    { id: "replacement", role: "system", text: "compacted history" },
  ]);

  expect(bucketToTranscript(bucket(inputs, [], [], 10))).toEqual([]);
});

test("projects reasoning parts as their own items", () => {
  const value = bucket(
    [input("i1", 1, "问题")],
    [message("m1", 2, "assistant")],
    [reasoningPart("m1", 1, "先想"), part("m1", 2, "答案")],
  );

  const items = bucketToTranscript(value);
  expect(items.map((item) => item.role)).toEqual(["reasoning", "assistant"]);
  expect(items[0]!.text).toBe("先想");
});

test("drops reasoning items when showReasoning is false", () => {
  const value = bucket(
    [input("i1", 1, "问题")],
    [message("m1", 2, "assistant")],
    [reasoningPart("m1", 1, "先想")],
  );

  expect(bucketToTranscript(value, { showReasoning: false })).toEqual([]);
});

test("hides only reasoning when assistant text and reasoning are interleaved", () => {
  const value = bucket(
    [input("i1", 1, "问题")],
    [message("m1", 2, "assistant")],
    [reasoningPart("m1", 1, "先想"), part("m1", 2, "答案")],
  );

  expect(bucketToTranscript(value, { showReasoning: false }))
    .toEqual([expect.objectContaining({ role: "assistant", text: "答案" })]);
  expect(bucketToTranscript(value, { showReasoning: true }).map((item) => item.role))
    .toEqual(["reasoning", "assistant"]);
});
