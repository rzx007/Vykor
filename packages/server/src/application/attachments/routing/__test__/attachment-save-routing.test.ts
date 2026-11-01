import { expect, it } from "vitest";
import { AttachmentTextDecodingError } from "@vykor/services";
import { AttachmentCapabilityRouter } from "../attachment-capability-router.js";
import type { SessionInputAttachmentRecord } from "@vykor/domain-contracts/attachments";

const reference: SessionInputAttachmentRecord = { id: "r", sessionId: "s", inputId: "i", seq: 0, assetId: "a", intent: "auto", displayName: "data.bin", mediaType: "application/octet-stream", sizeBytes: 4, metadata: {}, createdAt: 1 };

it.each([
  ["image.png", "image/png"],
  ["scan.pdf", "application/pdf"],
  ["archive.zip", "application/zip"],
  ["data.bin", "application/octet-stream"],
  ["legacy.doc", "application/msword"],
  ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
])("accepts %s as an unread resource when saving is available without inspection", async (displayName, mediaType) => {
  const router = new AttachmentCapabilityRouter({
    resolveReadyContentPath: async () => { throw new Error("must not inspect image"); },
    readReadyText: async () => { throw new Error("must not inspect text"); },
  });
  const result = await router.route({ text: "save this", attachments: [{ ...reference, displayName, mediaType }],
    modelCapabilities: { image: "unsupported" }, providerCapabilities: { image: "unsupported", imageMediaTypes: [] }, availableTools: ["SaveAttachment"], attachmentOcrAvailable: false });
  expect(result.decisions[0]).toMatchObject({ route: "file_resource", complete: false, resourceUri: `attachment://a/${displayName}` });
  expect(result.content.every(block => block.type === "text")).toBe(true);
  expect(JSON.stringify(result.content)).toContain("SaveAttachment");
  expect(JSON.stringify(result.content)).toContain("尚未读取");
});

it("keeps undecodable text available for original-byte saving without claiming it was read", async () => {
  const router = new AttachmentCapabilityRouter({
    resolveReadyContentPath: async () => { throw new Error("not an image"); },
    readReadyText: async () => { throw new AttachmentTextDecodingError("unsupported_encoding", "legacy encoding"); },
  });
  const result = await router.route({ text: "save", attachments: [{ ...reference, displayName: "legacy.txt", mediaType: "text/plain" }],
    modelCapabilities: { image: "unsupported" }, providerCapabilities: { image: "unsupported", imageMediaTypes: [] }, availableTools: ["SaveAttachment"] });
  expect(result.decisions[0]).toMatchObject({ route: "file_resource", complete: false });
  expect(JSON.stringify(result.content)).toContain("attachment://a/legacy.txt");
  expect(JSON.stringify(result.content)).toContain("尚未读取");
});
