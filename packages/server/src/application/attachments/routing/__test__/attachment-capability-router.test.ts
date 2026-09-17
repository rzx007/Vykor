import type { SessionInputAttachmentRecord } from "@openharness/protocol";
import { describe, expect, it, vi } from "vitest";
import { AttachmentTextDecodingError } from "@openharness/services";

import { AttachmentCapabilityRouter } from "../attachment-capability-router.js";

function attachment(
  assetId: string,
  seq: number,
  overrides: Partial<SessionInputAttachmentRecord> = {},
): SessionInputAttachmentRecord {
  return {
    id: `ref-${assetId}`,
    sessionId: "session-1",
    inputId: "input-1",
    assetId,
    seq,
    intent: "auto",
    displayName: `${assetId}.png`,
    mediaType: "image/png",
    sizeBytes: 4,
    metadata: {},
    createdAt: 1,
    ...overrides,
  };
}

function harness() {
  const resolveReadyContentPath = vi.fn(async (assetId: string) => ({
    assetId,
    path: `D:/daemon/blobs/${assetId}`,
    mediaType: "image/png",
    sizeBytes: 4,
  }));
  const readReadyText = vi.fn(async (assetId: string) => ({
    assetId,
    displayName: `${assetId}.txt`,
    mediaType: "text/plain",
    encoding: "utf-8" as const,
    text: "hello from attachment",
  }));
  return {
    resolveReadyContentPath,
    readReadyText,
    router: new AttachmentCapabilityRouter({ resolveReadyContentPath, readReadyText }),
  };
}

describe("AttachmentCapabilityRouter", () => {
  it("routes unsupported image models to an explicit ImageToText resource hint", async () => {
    const { router, resolveReadyContentPath } = harness();
    const result = await router.route({
      text: "读一下票据",
      attachments: [attachment("receipt", 0)],
      modelCapabilities: { image: "unsupported" },
      providerCapabilities: { image: "native", imageMediaTypes: ["image/png"] },
      availableTools: ["ImageToText"],
      attachmentOcrAvailable: true,
    } as any);

    expect(resolveReadyContentPath).not.toHaveBeenCalled();
    expect(result.decisions).toEqual([
      expect.objectContaining({ assetId: "receipt", route: "image_to_text_tool" }),
    ]);
    expect(result.content).toEqual([
      { type: "text", text: "读一下票据" },
      { type: "text", text: expect.stringContaining("ImageToText") },
    ]);
    expect((result.content[1] as { text: string }).text).toContain("receipt");
  });

  it("keeps an attachment OCR reference beside a natively delivered image", async () => {
    const { router, resolveReadyContentPath } = harness();
    const result = await router.route({
      text: "OCR this image",
      attachments: [attachment("receipt", 0)],
      modelCapabilities: { image: "native" },
      providerCapabilities: { image: "native", imageMediaTypes: ["image/png"] },
      availableTools: ["ImageToText"],
      attachmentOcrAvailable: true,
    } as any);

    expect(resolveReadyContentPath).toHaveBeenCalledWith("receipt");
    expect(result.decisions).toEqual([
      expect.objectContaining({ assetId: "receipt", route: "native_image" }),
    ]);
    expect(result.content).toEqual([
      { type: "text", text: "OCR this image" },
      expect.objectContaining({ type: "image" }),
      { type: "text", text: expect.stringContaining('"attachment_id":"receipt"') },
    ]);
  });

  it("blocks OCR fallback before provider execution when ImageToText is filtered out", async () => {
    const { router } = harness();
    await expect(router.route({
      text: "read",
      attachments: [attachment("receipt", 0)],
      modelCapabilities: { image: "unsupported" },
      providerCapabilities: { image: "native", imageMediaTypes: ["image/png"] },
      availableTools: [],
      attachmentOcrAvailable: true,
    } as any)).rejects.toMatchObject({ code: "attachment_ocr_tool_unavailable" });
  });
  it.each(["unknown", "unsupported"] as const)("falls back when model image support is %s", async (image) => {
    const { router, resolveReadyContentPath } = harness();
    await expect(
      router.route({
        text: "describe",
        attachments: [attachment("a", 0)],
        modelCapabilities: { image },
        providerCapabilities: {
          image: "native",
          imageMediaTypes: ["image/png"],
        },
        availableTools: ["ImageToText"],
        attachmentOcrAvailable: true,
      }),
    ).resolves.toMatchObject({ decisions: [{ route: "image_to_text_tool" }] });
    expect(resolveReadyContentPath).not.toHaveBeenCalled();
  });

  it.each(["unknown", "unsupported"] as const)("falls back when provider image support is %s", async (image) => {
    const { router } = harness();
    await expect(
      router.route({
        text: "",
        attachments: [attachment("a", 0)],
        modelCapabilities: { image: "native" },
        providerCapabilities: { image, imageMediaTypes: ["image/png"] },
        availableTools: ["ImageToText"],
        attachmentOcrAvailable: true,
      }),
    ).resolves.toMatchObject({ decisions: [{ route: "image_to_text_tool" }] });
  });

  it("routes explicit OCR and OCR-compatible media without blob I/O", async () => {
    const { router, resolveReadyContentPath } = harness();
    await expect(
      router.route({
        text: "read",
        attachments: [attachment("ocr", 0, { intent: "ocr" })],
        modelCapabilities: { image: "native" },
        providerCapabilities: {
          image: "native",
          imageMediaTypes: ["image/png"],
        },
        availableTools: ["ImageToText"],
        attachmentOcrAvailable: true,
      }),
    ).resolves.toMatchObject({ decisions: [{ route: "image_to_text_tool" }] });
    await expect(
      router.route({
        text: "read",
        attachments: [attachment("bmp", 0, { mediaType: "image/bmp" })],
        modelCapabilities: { image: "native" },
        providerCapabilities: { image: "native", imageMediaTypes: ["image/png"] },
        availableTools: ["ImageToText"],
        attachmentOcrAvailable: true,
      }),
    ).resolves.toMatchObject({ decisions: [{ route: "image_to_text_tool" }] });
    expect(resolveReadyContentPath).not.toHaveBeenCalled();
  });

  it("blocks unsupported content before blob I/O", async () => {
    const { router, resolveReadyContentPath, readReadyText } = harness();
    await expect(
      router.route({
        text: "read",
        attachments: [
          attachment("pdf", 0, {
            displayName: "a.pdf",
            mediaType: "application/pdf",
          }),
        ],
        modelCapabilities: { image: "native" },
        providerCapabilities: {
          image: "native",
          imageMediaTypes: ["image/png"],
        },
      }),
    ).rejects.toMatchObject({ code: "attachment_document_unsupported" });
    expect(resolveReadyContentPath).not.toHaveBeenCalled();
    expect(readReadyText).not.toHaveBeenCalled();
  });

  it("inlines a small text attachment with an explicit untrusted-data boundary", async () => {
    const { router, readReadyText, resolveReadyContentPath } = harness();
    const result = await router.route({
      text: "summarize",
      attachments: [attachment("notes", 0, {
        displayName: "notes.txt",
        mediaType: "text/plain",
        sizeBytes: 21,
      })],
      modelCapabilities: { image: "unsupported" },
      providerCapabilities: { image: "unsupported", imageMediaTypes: [] },
    });

    expect(readReadyText).toHaveBeenCalledWith("notes", expect.anything());
    expect(resolveReadyContentPath).not.toHaveBeenCalled();
    expect(result.decisions).toEqual([
      expect.objectContaining({ assetId: "notes", route: "text_inline", complete: true }),
    ]);
    expect(result.content).toEqual([
      { type: "text", text: "summarize" },
      { type: "text", text: expect.stringContaining("hello from attachment") },
    ]);
  });

  it("exposes a bounded preview and attachment URI for large text", async () => {
    const { router, readReadyText } = harness();
    readReadyText.mockResolvedValueOnce({
      assetId: "large",
      displayName: "large.log",
      mediaType: "text/plain",
      encoding: "utf-8",
      text: "x".repeat(16_001),
    });
    const result = await router.route({
      text: "",
      attachments: [attachment("large", 0, {
        displayName: "large.log",
        mediaType: "text/plain",
        sizeBytes: 16_001,
      })],
      modelCapabilities: { image: "unsupported" },
      providerCapabilities: { image: "unsupported", imageMediaTypes: [] },
    });

    expect(result.decisions).toEqual([
      expect.objectContaining({
        route: "text_resource",
        complete: false,
        resourceUri: "attachment://large/large.log",
      }),
    ]);
    const block = result.content[0] as { type: "text"; text: string };
    expect(block.text).toContain("attachment://large/large.log");
    expect(block.text).toContain(
      '{"file_path":"attachment://large/large.log","offset":1,"limit":2000}',
    );
    expect(block.text).toContain("不要调用 ReadMcpResource");
    expect(block.text).not.toContain("x".repeat(3_001));
  });

  it.each([
    ["report.docx", "application/zip", "attachment_document_unsupported"],
    ["table.xlsx", "application/zip", "attachment_document_unsupported"],
    ["slides.pptx", "application/zip", "attachment_document_unsupported"],
    ["data.zip", "application/zip", "attachment_archive_unsupported"],
    ["program.bin", "application/octet-stream", "attachment_binary_unsupported"],
  ])("blocks %s with a stable reason", async (displayName, mediaType, code) => {
    const { router, readReadyText, resolveReadyContentPath } = harness();
    await expect(router.route({
      text: "read",
      attachments: [attachment("blocked", 0, { displayName, mediaType })],
      modelCapabilities: { image: "native" },
      providerCapabilities: { image: "native", imageMediaTypes: ["image/png"] },
    })).rejects.toMatchObject({ code });
    expect(readReadyText).not.toHaveBeenCalled();
    expect(resolveReadyContentPath).not.toHaveBeenCalled();
  });

  it.each([
    ["unsupported_encoding", "attachment_text_encoding_unsupported"],
    ["invalid_text", "attachment_text_invalid"],
  ] as const)("preserves the stable %s text failure", async (kind, code) => {
    const { router, readReadyText } = harness();
    readReadyText.mockRejectedValueOnce(new AttachmentTextDecodingError(kind, "bad text"));
    await expect(router.route({
      text: "read",
      attachments: [attachment("bad", 0, { displayName: "bad.txt", mediaType: "text/plain" })],
      modelCapabilities: { image: "unsupported" },
      providerCapabilities: { image: "unsupported", imageMediaTypes: [] },
    })).rejects.toMatchObject({ code });
  });

  it("materializes text and images in stable attachment order", async () => {
    const { router } = harness();
    await expect(
      router.route({
        text: "compare",
        attachments: [attachment("second", 2), attachment("first", 1)],
        modelCapabilities: { image: "native" },
        providerCapabilities: {
          image: "native",
          imageMediaTypes: ["image/png"],
        },
      }),
    ).resolves.toMatchObject({
      content: [
        { type: "text", text: "compare" },
        { type: "image", source: { path: "D:/daemon/blobs/first" } },
        { type: "image", source: { path: "D:/daemon/blobs/second" } },
      ],
    });
  });

  it("does not expose partial blocks when one blob fails", async () => {
    const resolveReadyContentPath = vi
      .fn()
      .mockResolvedValueOnce({
        assetId: "a",
        path: "D:/daemon/blobs/a",
        mediaType: "image/png",
        sizeBytes: 4,
      })
      .mockRejectedValueOnce(new Error("missing blob"));
    const router = new AttachmentCapabilityRouter({
      resolveReadyContentPath,
      readReadyText: vi.fn(),
    });

    await expect(
      router.route({
        text: "",
        attachments: [attachment("a", 0), attachment("b", 1)],
        modelCapabilities: { image: "native" },
        providerCapabilities: {
          image: "native",
          imageMediaTypes: ["image/png"],
        },
      }),
    ).rejects.toMatchObject({
      code: "attachment_materialization_failed",
      assetIds: ["a", "b"],
    });
  });

  it("stops before materialization when already aborted", async () => {
    const { router, resolveReadyContentPath } = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      router.route({
        text: "",
        attachments: [attachment("a", 0)],
        modelCapabilities: { image: "native" },
        providerCapabilities: {
          image: "native",
          imageMediaTypes: ["image/png"],
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "attachment_routing_aborted" });
    expect(resolveReadyContentPath).not.toHaveBeenCalled();
  });
});
