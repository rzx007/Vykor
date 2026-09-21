import { describe, expect, it, vi } from "vitest";
import type { SessionInputRecord } from "@openharness/protocol";

import { SessionTranscriptProjection } from "../transcript-projection.js";

function createStore() {
  let messageSeq = 0;
  let partSeq = 0;
  const messages: any[] = [];
  const store = {
    appendMessagePartDelta: vi.fn((input) => ({
      id: "e1",
      seq: 1,
      type: "session.message_part.delta",
      sessionId: input.sessionId,
      payload: input,
      createdAt: 1,
    })),
    createMessage: vi.fn((input) => {
      const message = {
        id: `m${++messageSeq}`,
        seq: messageSeq,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
        ...input,
      };
      messages.push(message);
      return message;
    }),
    listMessages: vi.fn(() => messages),
    listMessageParts: vi.fn(() => []),
    updateRun: vi.fn(),
    upsertMessagePart: vi.fn((input) => ({
      id: input.id ?? `p${++partSeq}`,
      seq: partSeq,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
      ...input,
    })),
  };
  return {
    ...store,
    conversations: {
      createMessage: store.createMessage,
      listMessages: store.listMessages,
      listMessageParts: store.listMessageParts,
      upsertMessagePart: store.upsertMessagePart,
    },
    incrementalOutput: { appendMessagePartDelta: store.appendMessagePartDelta },
    runs: { updateRun: store.updateRun },
  };
}

function createInput(
  overrides: Partial<SessionInputRecord> = {},
): SessionInputRecord {
  return {
    id: "i1",
    sessionId: "s1",
    seq: 1,
    delivery: "follow_up",
    items: [{ type: "text", text: "hello" }],
    content: "hello",
    attachments: [],
    metadata: {},
    createdAt: 1,
    ...overrides,
  };
}

describe("SessionTranscriptProjection", () => {
  it("does not project an internal input as a user message", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store as any);

    projection.beginRun("s1", "i1", "r1", createInput({
      content: "继续推进目标",
      metadata: { transcriptVisibility: "hidden" },
    }));

    expect(store.createMessage).not.toHaveBeenCalled();
    expect(store.upsertMessagePart).not.toHaveBeenCalled();
  });

  it("projects structured input items onto the durable user text part", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store as any);
    const items = [
      { type: "text" as const, text: "画一下 " },
      { type: "skill" as const, name: "archify", path: "/repo/archify/SKILL.md" },
    ];

    projection.beginRun("s1", "i1", "r1", createInput({
      content: "画一下 $archify",
      items,
    }));

    expect(store.upsertMessagePart).toHaveBeenCalledWith({
      sessionId: "s1",
      messageId: "m1",
      type: "text",
      status: "completed",
      text: "画一下 $archify",
      metadata: { items },
    });
  });

  it("projects direct and blocked attachment transformations onto one user message", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store as any);
    const input = createInput({ attachments: [
      { id: "ref-1", sessionId: "s1", inputId: "i1", assetId: "asset-1", seq: 0, intent: "auto", displayName: "a.png", mediaType: "image/png", sizeBytes: 4, metadata: {}, createdAt: 1 },
    ] });

    projection.projectAttachmentTransformations({
      sessionId: "s1",
      inputId: "i1",
      runId: "r1",
      input,
      decisions: [{ assetId: "asset-1", intent: "auto", mediaType: "image/png", route: "native_image" }],
      status: "completed",
    });
    projection.beginRun("s1", "i1", "r1", input);

    expect(store.createMessage).toHaveBeenCalledTimes(1);
    expect(store.upsertMessagePart).toHaveBeenCalledWith(expect.objectContaining({
      type: "transformation",
      kind: "direct",
      assetId: "asset-1",
      status: "completed",
    }));
  });
  it("projects text deltas into live message-part events", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun("s1", "i1", "r1", createInput());

    const applied = projection.projectStreamEvent(state, { type: "text_delta", delta: "world" });

    expect(store.createMessage).toHaveBeenCalledWith({
      sessionId: "s1",
      role: "user",
      runId: "r1",
      inputId: "i1",
    });
    expect(applied.liveEvent).toMatchObject({
      type: "session.message_part.delta",
      sessionId: "s1",
    });
    expect(store.appendMessagePartDelta).toHaveBeenCalledWith({
      sessionId: "s1",
      messageId: "m2",
      partId: "p2",
      field: "text",
      delta: "world",
    });
  });

  it("marks a preamble before tools as commentary", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun("s1", "i1", "r1", createInput());

    projection.projectStreamEvent(state, { type: "text_delta", delta: "I will inspect it." });
    projection.projectStreamEvent(state, {
      type: "tool_use_start",
      toolUse: { id: "tool-1", name: "Read", input: { path: "package.json" } },
    });

    expect(store.upsertMessagePart).toHaveBeenCalledWith(expect.objectContaining({
      id: "p2",
      type: "text",
      status: "completed",
      metadata: { phase: "commentary" },
    }));
  });

  it("marks a tool-free completed response as the final answer", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun("s1", "i1", "r1", createInput());

    projection.projectStreamEvent(state, { type: "text_delta", delta: "Done." });
    projection.projectStreamEvent(state, { type: "complete", stopReason: "stop" });

    expect(store.upsertMessagePart).toHaveBeenCalledWith(expect.objectContaining({
      id: "p2",
      type: "text",
      status: "completed",
      metadata: { phase: "final_answer" },
    }));
  });

  it("keeps tool names available when completing tool parts", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun("s1", "i1", "r1", createInput());

    projection.projectStreamEvent(state, {
      type: "tool_use_start",
      toolUse: { id: "tool-1", name: "shell", input: { cmd: "pwd" } },
    });
    const applied = projection.projectStreamEvent(state, {
      type: "tool_use_end",
      toolUseId: "tool-1",
      result: {
        output: "ok",
        isError: false,
        metadata: {
          shellFamily: "powershell",
          shellDialect: "pwsh",
          shellExecutable: "pwsh.exe",
          shellDisplayName: "PowerShell 7.6",
          pathStyle: "windows",
          exitCode: 0,
          status: "completed",
        },
      },
    });

    expect(applied.completedToolName).toBe("shell");
    expect(store.upsertMessagePart).toHaveBeenLastCalledWith({
      id: "tool-1",
      sessionId: "s1",
      messageId: "m2",
      type: "tool",
      status: "completed",
      toolUseId: "tool-1",
      toolName: "shell",
      input: { cmd: "pwd" },
      output: {
        output: "ok",
        isError: false,
        metadata: {
          shellFamily: "powershell",
          shellDialect: "pwsh",
          shellExecutable: "pwsh.exe",
          shellDisplayName: "PowerShell 7.6",
          pathStyle: "windows",
          exitCode: 0,
          status: "completed",
        },
      },
      isError: false,
      metadata: {
        shellFamily: "powershell",
        shellDialect: "pwsh",
        shellExecutable: "pwsh.exe",
        shellDisplayName: "PowerShell 7.6",
        pathStyle: "windows",
        exitCode: 0,
        status: "completed",
        toolCallId: "tool-1",
        toolAttemptId: "tool_attempt_tool-1_1",
        outcome: "completed",
      },
    });
  });

  it("projects local OCR provenance onto the completed tool part", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun("s1", "i1", "r1", createInput());
    projection.projectStreamEvent(state, {
      type: "tool_use_start",
      toolUse: { id: "ocr-1", name: "ImageToText", input: { attachment_id: "att-1" } },
    });
    projection.projectStreamEvent(state, {
      type: "tool_use_end",
      toolUseId: "ocr-1",
      result: {
        content: [{ type: "text", text: "hello" }],
        metadata: {
          attachmentOcr: {
            assetId: "att-1",
            representationId: "rep-1",
            processor: "light-ocr",
            status: "completed",
          },
        },
      },
    });

    expect(store.upsertMessagePart).toHaveBeenLastCalledWith(expect.objectContaining({
      id: "ocr-1",
      assetId: "att-1",
      representationId: "rep-1",
      processor: "light-ocr",
      metadata: expect.objectContaining({
        attachmentOcr: expect.objectContaining({ status: "completed" }),
      }),
    }));
  });

  it("projects generated image metadata as durable assistant attachments", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun("s1", "i1", "r1", createInput());
    projection.projectStreamEvent(state, {
      type: "tool_use_start",
      toolUse: { id: "image-1", name: "ImageGeneration", input: { prompt: "a fox" } },
    });

    projection.projectStreamEvent(state, {
      type: "tool_use_end",
      toolUseId: "image-1",
      result: {
        content: [{ type: "text", text: "generated" }],
        metadata: {
          generatedImages: [
            {
              assetId: "att-image-1",
              displayName: "generated-image-1.png",
              mediaType: "image/png",
              sizeBytes: 128,
            },
            {
              assetId: "att-image-2",
              displayName: "generated-image-2.webp",
              mediaType: "image/webp",
              sizeBytes: 256,
            },
          ],
        },
      },
    });

    expect(store.upsertMessagePart).toHaveBeenCalledWith({
      id: "generated-attachment:image-1:0",
      sessionId: "s1",
      messageId: "m2",
      type: "attachment",
      status: "completed",
      assetId: "att-image-1",
      intent: "tool_resource",
      displayName: "generated-image-1.png",
      mediaType: "image/png",
      sizeBytes: 128,
      metadata: {
        source: "image_generation",
        toolUseId: "image-1",
      },
    });
    expect(store.upsertMessagePart).toHaveBeenCalledWith(expect.objectContaining({
      id: "generated-attachment:image-1:1",
      assetId: "att-image-2",
      intent: "tool_resource",
    }));
  });

  it("uses stable generated attachment part ids when a tool result is replayed", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun("s1", "i1", "r1", createInput());
    projection.projectStreamEvent(state, {
      type: "tool_use_start",
      toolUse: { id: "image-replay", name: "ImageGeneration", input: {} },
    });
    const event = {
      type: "tool_use_end" as const,
      toolUseId: "image-replay",
      result: {
        content: [{ type: "text" as const, text: "generated" }],
        metadata: {
          generatedImages: [{
            assetId: "att-replay",
            displayName: "generated.png",
            mediaType: "image/png",
            sizeBytes: 64,
          }],
        },
      },
    };

    projection.projectStreamEvent(state, event);
    projection.projectStreamEvent(state, event);

    const attachmentParts = store.upsertMessagePart.mock.calls
      .map(([part]) => part)
      .filter((part) => part.type === "attachment");
    expect(attachmentParts).toHaveLength(2);
    expect(attachmentParts.map((part) => part.id)).toEqual([
      "generated-attachment:image-replay:0",
      "generated-attachment:image-replay:0",
    ]);
    expect(attachmentParts.map((part) => part.messageId)).toEqual(["m2", "m2"]);
  });

  it("ignores malformed generated image metadata", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun("s1", "i1", "r1", createInput());

    projection.projectStreamEvent(state, {
      type: "tool_use_end",
      toolUseId: "image-invalid",
      result: {
        content: [{ type: "text", text: "invalid metadata" }],
        metadata: {
          generatedImages: [
            { assetId: "", displayName: "missing-id.png", mediaType: "image/png", sizeBytes: 1 },
            { assetId: "att-text", displayName: "not-image.txt", mediaType: "text/plain", sizeBytes: 1 },
            { assetId: "att-size", displayName: "bad-size.png", mediaType: "image/png", sizeBytes: -1 },
          ],
        },
      },
    });

    expect(store.upsertMessagePart.mock.calls
      .map(([part]) => part)
      .filter((part) => part.type === "attachment")).toEqual([]);
  });

  it("closes only running parts owned by the failed run", () => {
    const store = createStore();
    store.listMessages.mockReturnValue([
      { id: "m1", runId: "r1" },
      { id: "m2", runId: "r2" },
    ] as any);
    store.listMessageParts.mockReturnValue([
      { id: "p1", messageId: "m1", type: "text", status: "running" },
      { id: "p2", messageId: "m1", type: "tool", status: "completed" },
      { id: "p3", messageId: "m2", type: "text", status: "running" },
    ] as any);
    const projection = new SessionTranscriptProjection(store);

    projection.finalizeRunParts("s1", "r1", "failed");

    expect(store.upsertMessagePart).toHaveBeenCalledOnce();
    expect(store.upsertMessagePart).toHaveBeenCalledWith({
      id: "p1",
      sessionId: "s1",
      messageId: "m1",
      type: "text",
      status: "failed",
    });
  });

  it("does not duplicate a steered user message when projection is retried", () => {
    const store = createStore();
    store.listMessages
      .mockReturnValueOnce([])
      .mockReturnValue([{ id: "m-steer", inputId: "steer-1" }] as any);
    const projection = new SessionTranscriptProjection(store);
    const state = {
      sessionId: "s1",
      runId: "r1",
      inputId: "i1",
      assistantTurnCompleted: false,
      toolParts: new Map(),
    };
    const input = createInput({
      id: "steer-1",
      seq: 2,
      delivery: "steer" as const,
      content: "continue",
    });

    projection.projectSteeredInputs(state, [input]);
    projection.projectSteeredInputs(state, [input]);

    expect(store.createMessage).toHaveBeenCalledOnce();
  });

  it("projects an attachment-only input without an empty text part", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const input = createInput({
      content: "",
      attachments: [{
        id: "ref-1",
        sessionId: "s1",
        inputId: "i1",
        assetId: "att-1",
        seq: 0,
        intent: "vision",
        displayName: "screen.png",
        mediaType: "image/png",
        sizeBytes: 42,
        metadata: {},
        createdAt: 1,
      }],
    });

    projection.beginRun("s1", "i1", "r1", input);

    expect(store.upsertMessagePart).toHaveBeenCalledOnce();
    expect(store.upsertMessagePart).toHaveBeenCalledWith({
      sessionId: "s1",
      messageId: "m1",
      type: "attachment",
      status: "completed",
      assetId: "att-1",
      intent: "vision",
      displayName: "screen.png",
      mediaType: "image/png",
      sizeBytes: 42,
      metadata: { inputAttachmentId: "ref-1" },
    });
  });

  it("projects text before attachments and keeps attachment reference order", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const input = createInput({
      content: "inspect these",
      attachments: [
        {
          id: "ref-2",
          sessionId: "s1",
          inputId: "i1",
          assetId: "att-2",
          seq: 2,
          intent: "ocr",
          displayName: "second.png",
          mediaType: "image/png",
          sizeBytes: 22,
          metadata: {},
          createdAt: 1,
        },
        {
          id: "ref-1",
          sessionId: "s1",
          inputId: "i1",
          assetId: "att-1",
          seq: 1,
          intent: "vision",
          displayName: "first.png",
          mediaType: "image/png",
          sizeBytes: 11,
          metadata: {},
          createdAt: 1,
        },
      ],
    });

    projection.beginRun("s1", "i1", "r1", input);

    expect(store.upsertMessagePart.mock.calls.map(([part]) => part.type)).toEqual([
      "text",
      "attachment",
      "attachment",
    ]);
    expect(store.upsertMessagePart.mock.calls.map(([part]) => part.assetId).filter(Boolean)).toEqual([
      "att-1",
      "att-2",
    ]);
  });

  it("uses the same attachment projection for steered inputs", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = {
      sessionId: "s1",
      runId: "r1",
      inputId: "i1",
      assistantTurnCompleted: false,
      toolParts: new Map(),
    };
    const input = createInput({
      id: "steer-1",
      seq: 2,
      delivery: "steer",
      content: "",
      attachments: [{
        id: "ref-steer",
        sessionId: "s1",
        inputId: "steer-1",
        assetId: "att-steer",
        seq: 0,
        intent: "document",
        displayName: "notes.pdf",
        mediaType: "application/pdf",
        sizeBytes: 99,
        metadata: {},
        createdAt: 1,
      }],
    });

    projection.projectSteeredInputs(state, [input]);

    expect(store.upsertMessagePart).toHaveBeenCalledOnce();
    expect(store.upsertMessagePart).toHaveBeenCalledWith(expect.objectContaining({
      type: "attachment",
      assetId: "att-steer",
      metadata: { inputAttachmentId: "ref-steer" },
    }));
  });

  it("projects reasoning deltas into a reasoning part", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun("s1", "i1", "r1", createInput());

    projection.projectStreamEvent(state, {
      type: "reasoning_delta",
      delta: "先看文件。",
      source: "reasoning_content",
    });

    expect(store.upsertMessagePart).toHaveBeenCalledWith(expect.objectContaining({
      type: "reasoning",
      status: "running",
      metadata: { source: "reasoning_content" },
    }));
    expect(store.appendMessagePartDelta).toHaveBeenCalledWith(expect.objectContaining({
      field: "reasoning",
      delta: "先看文件。",
    }));
  });

  it("starts a new reasoning part when the source changes", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun("s1", "i1", "r1", createInput());
    projection.projectStreamEvent(state, { type: "reasoning_delta", delta: "think", source: "think" });
    projection.projectStreamEvent(state, { type: "reasoning_delta", delta: "replay", source: "reasoning_content" });
    projection.projectStreamEvent(state, { type: "reasoning_delta", delta: "more", source: "think" });

    expect(store.upsertMessagePart.mock.calls
      .map(([part]) => part)
      .filter((part) => part.type === "reasoning")
      .map((part) => [part.status, part.metadata?.source]))
      .toEqual([
        ["running", "think"], ["completed", undefined],
        ["running", "reasoning_content"], ["completed", undefined],
        ["running", "think"],
      ]);
  });

  it("closes the reasoning part when text starts and opens a new one later", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun("s1", "i1", "r1", createInput());

    projection.projectStreamEvent(state, {
      type: "reasoning_delta",
      delta: "first",
      source: "think",
    });
    projection.projectStreamEvent(state, { type: "text_delta", delta: "正文" });
    projection.projectStreamEvent(state, {
      type: "reasoning_delta",
      delta: "second",
      source: "think",
    });

    const reasoningParts = store.upsertMessagePart.mock.calls
      .map(([input]) => input)
      .filter((input) => input.type === "reasoning");
    expect(reasoningParts).toHaveLength(3);
    expect(reasoningParts[0]).toMatchObject({ status: "running" });
    expect(reasoningParts[1]).toMatchObject({ status: "completed" });
    expect(reasoningParts[2]).toMatchObject({ status: "running" });
  });

  it("keeps text before and after reasoning in separate ordered parts", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun("s1", "i1", "r1", createInput({ content: "" }));

    projection.projectStreamEvent(state, { type: "text_delta", delta: "先给结论。" });
    projection.projectStreamEvent(state, {
      type: "reasoning_delta",
      delta: "再展开推理。",
      source: "think",
    });
    projection.projectStreamEvent(state, { type: "text_delta", delta: "结论如上。" });

    expect(store.upsertMessagePart.mock.calls.map(([part]) => `${part.type}:${part.status}`)).toEqual([
      "text:running",
      "text:completed",
      "reasoning:running",
      "reasoning:completed",
      "text:running",
    ]);
    expect(store.upsertMessagePart).toHaveBeenCalledWith({
      id: "p1",
      sessionId: "s1",
      messageId: "m2",
      type: "text",
      status: "completed",
      metadata: { phase: "commentary" },
    });
    const deltas = store.appendMessagePartDelta.mock.calls.map(([input]) => input);
    expect(deltas.map((delta) => delta.field)).toEqual(["text", "reasoning", "text"]);
    expect(deltas.map((delta) => delta.partId)).toEqual(["p1", "p2", "p3"]);
  });

  it("closes the reasoning part before a steered input continues the run", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun("s1", "i1", "r1", createInput());

    projection.projectStreamEvent(state, {
      type: "reasoning_delta",
      delta: "before steer",
      source: "think",
    });
    projection.projectSteeredInputs(state, [createInput({
      id: "steer-1",
      seq: 2,
      delivery: "steer",
      content: "continue",
    })]);
    projection.projectStreamEvent(state, {
      type: "reasoning_delta",
      delta: "after steer",
      source: "think",
    });

    const reasoningParts = store.upsertMessagePart.mock.calls
      .map(([input]) => input)
      .filter((input) => input.type === "reasoning");
    expect(reasoningParts).toHaveLength(3);
    expect(reasoningParts[1]).toMatchObject({ status: "completed" });
    expect(store.appendMessagePartDelta).toHaveBeenLastCalledWith(expect.objectContaining({
      field: "reasoning",
      delta: "after steer",
      partId: "p4",
    }));
  });

  it("appends the truncation notice once after the reasoning part reaches the char limit", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun("s1", "i1", "r1", createInput());

    projection.projectStreamEvent(state, {
      type: "reasoning_delta",
      delta: "x".repeat(1_000_000),
      source: "think",
    });
    projection.projectStreamEvent(state, {
      type: "reasoning_delta",
      delta: "overflow",
      source: "think",
    });
    projection.projectStreamEvent(state, {
      type: "reasoning_delta",
      delta: "more",
      source: "think",
    });

    const deltas = store.appendMessagePartDelta.mock.calls.map(([input]) => input);
    expect(deltas).toHaveLength(2);
    expect(deltas[0].delta).toHaveLength(1_000_000);
    expect(deltas[1].delta).toBe("\n\n…（思考内容过长，已截断）");
  });
});
