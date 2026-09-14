import { describe, expect, it } from "vitest";

import { buildCompactAttachmentSection } from "../compact-attachment-catalog.js";

describe("buildCompactAttachmentSection", () => {
  it("keeps stable resources and only exposes representations that actually completed", () => {
    const references = [
      {
        id: "ref-image",
        sessionId: "session-1",
        inputId: "input-1",
        assetId: "att-image",
        seq: 0,
        intent: "ocr" as const,
        displayName: "收据.png",
        mediaType: "image/png",
        sizeBytes: 2048,
        metadata: {},
        createdAt: 10,
      },
      {
        id: "ref-text",
        sessionId: "session-1",
        inputId: "input-2",
        assetId: "att-text",
        seq: 0,
        intent: "tool_resource" as const,
        displayName: "notes.txt",
        mediaType: "text/plain",
        sizeBytes: 42,
        metadata: {},
        createdAt: 20,
      },
    ];
    const assets = new Map([
      ["att-image", {
        id: "att-image",
        displayName: "收据.png",
        mediaType: "image/png",
        sizeBytes: 2048,
        sha256: "a".repeat(64),
        status: "ready" as const,
        createdAt: 1,
        updatedAt: 1,
      }],
      ["att-text", {
        id: "att-text",
        displayName: "notes.txt",
        mediaType: "text/plain",
        sizeBytes: 42,
        sha256: "b".repeat(64),
        status: "ready" as const,
        createdAt: 2,
        updatedAt: 2,
      }],
    ]);
    const store = {
      listSessionInputAttachments: () => references,
      attachments: {
        getAttachment: (assetId: string) => assets.get(assetId),
        listAttachmentRepresentations: (assetId: string) => assetId === "att-text"
          ? [
              {
                id: "rep-failed",
                assetId,
                kind: "plain_text" as const,
                status: "failed" as const,
                processor: "safe-text",
                processorVersion: "0",
                cacheKey: "failed",
                mediaType: "text/plain",
                error: "bad encoding",
                metadata: {},
                createdAt: 2,
                updatedAt: 3,
              },
              {
                id: "rep-complete",
                assetId,
                kind: "plain_text" as const,
                status: "completed" as const,
                processor: "safe-text",
                processorVersion: "1",
                cacheKey: "complete",
                mediaType: "text/plain",
                text: "hello from notes",
                metadata: {},
                createdAt: 4,
                updatedAt: 5,
              },
            ]
          : [],
      },
    };

    const section = buildCompactAttachmentSection(store, "session-1");

    expect(section?.heading).toBe("Conversation Attachments");
    expect(section?.content).toContain("assetId=att-image");
    expect(section?.content).toContain("attachment://att-image/%E6%94%B6%E6%8D%AE.png");
    expect(section?.content).toContain("Use ImageToText to inspect this image");
    expect(section?.content).toContain("assetId=att-text");
    expect(section?.content).toContain("Use Read with attachment://att-text/notes.txt");
    expect(section?.content).toContain("processor=safe-text@1");
    expect(section?.content).toContain("hello from notes");
    expect(section?.content).not.toContain("rep-failed");
  });

  it("marks missing assets unavailable and bounds previews and entry count", () => {
    const references = Array.from({ length: 22 }, (_, index) => ({
      id: `ref-${index}`,
      sessionId: "session-1",
      inputId: `input-${index}`,
      assetId: `att-${index}`,
      seq: 0,
      intent: "tool_resource" as const,
      displayName: `file-${index}.txt`,
      mediaType: "text/plain",
      sizeBytes: 2000,
      metadata: {},
      createdAt: index,
    }));
    const store = {
      listSessionInputAttachments: () => references,
      attachments: {
        getAttachment: (assetId: string) => assetId === "att-21"
          ? undefined
          : {
              id: assetId,
              displayName: `${assetId}.txt`,
              mediaType: "text/plain",
              sizeBytes: 2000,
              sha256: "c".repeat(64),
              status: "ready" as const,
              createdAt: 1,
              updatedAt: 1,
            },
        listAttachmentRepresentations: (assetId: string) => assetId === "att-20"
          ? [{
              id: "rep-long",
              assetId,
              kind: "plain_text" as const,
              status: "completed" as const,
              processor: "safe-text",
              processorVersion: "1",
              cacheKey: "long",
              mediaType: "text/plain",
              text: "x".repeat(1500),
              metadata: {},
              createdAt: 1,
              updatedAt: 1,
            }]
          : [],
      },
    };

    const section = buildCompactAttachmentSection(store, "session-1", {
      maxEntries: 2,
      maxPreviewChars: 100,
    });

    expect(section?.content).toContain("assetId=att-20");
    expect(section?.content).toContain("x".repeat(100));
    expect(section?.content).toContain("truncated=true");
    expect(section?.content).toContain("assetId=att-21");
    expect(section?.content).toContain("original attachment is unavailable");
    expect(section?.content).toContain("20 additional attachment references omitted");
  });

  it("returns undefined when the session has no attachment references", () => {
    expect(buildCompactAttachmentSection({
      listSessionInputAttachments: () => [],
      attachments: {
        getAttachment: () => undefined,
        listAttachmentRepresentations: () => [],
      },
    }, "session-1")).toBeUndefined();
  });
});
