import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AttachmentBlobStore, SessionStore } from "@vykor/services";
import { createFileReadTool } from "@vykor/tools";
import { afterEach, describe, expect, it } from "vitest";

import { AttachmentService } from "../../attachment-service.js";
import {
  createAttachmentImageReader,
  createAttachmentTextReader,
} from "../attachment-access.js";
import { createAttachmentReadTool } from "../attachment-read-tool.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2xkAAAAASUVORK5CYII=", "base64");
const roots: string[] = [];
const stores: SessionStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function harness(displayName = "screen.png", bytes = png, generated = false) {
  const root = await mkdtemp(join(tmpdir(), "vk-attachment-image-"));
  roots.push(root);
  const databasePath = join(root, "store.db");
  let store = new SessionStore({ path: databasePath });
  stores.push(store);
  const blobs = new AttachmentBlobStore({ root: join(root, "attachments") });
  let attachments = new AttachmentService({ store: store.attachments, blobs, id: () => "att_image" });
  const asset = await attachments.import({
    displayName,
    content: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
  });
  store.sessions.create({ id: "owner", cwd: root, model: "visual" });
  store.sessions.create({ id: "other", cwd: root, model: "visual" });
  if (generated) {
    const message = store.conversations.createMessage({ sessionId: "owner", role: "assistant" });
    store.conversations.upsertMessagePart({
      sessionId: "owner", messageId: message.id, type: "tool", status: "completed",
      toolName: "ImageGeneration", toolUseId: "generated-call", isError: false,
      input: { prompt: "generate" }, output: { content: [{ type: "text", text: "Generated image" }] },
    });
    store.conversations.upsertMessagePart({
      sessionId: "owner", messageId: message.id, type: "attachment", status: "completed",
      assetId: asset.id, intent: "tool_resource", displayName: asset.displayName,
      mediaType: asset.mediaType, sizeBytes: asset.sizeBytes,
      metadata: { source: "image_generation", toolUseId: "generated-call" },
    });
  } else {
    store.conversationTransactions.admitPrompt({
      id: "image-input", sessionId: "owner", content: "", attachments: [{ assetId: asset.id }],
    });
  }
  // Reopen SQLite so successful reads cannot rely on a live upload or run lease.
  store.close();
  stores.splice(stores.indexOf(store), 1);
  store = new SessionStore({ path: databasePath });
  stores.push(store);
  attachments = new AttachmentService({ store: store.attachments, blobs });
  const reader = createAttachmentImageReader({ store: store.conversations, attachments });
  return { root, store, attachments, reader, asset };
}

describe("authorized attachment image reads", () => {
  it("reopens generated images from this conversation and revokes access when their message is removed", async () => {
    const { reader, asset, store } = await harness("generated.png", png, true);
    expect(store.conversations.listSessionInputAttachments("owner")).toHaveLength(0);
    const image = await reader.readImage({ authorizationSessionId: "owner", assetId: asset.id });
    expect(Buffer.from(image!.bytes)).toEqual(png);
    await expect(reader.readImage({ authorizationSessionId: "other", assetId: asset.id }))
      .rejects.toThrow("attachment_resource_access_denied");
    store.conversationTransactions.replaceTranscript({ sessionId: "owner", messages: [] });
    await expect(reader.readImage({ authorizationSessionId: "owner", assetId: asset.id }))
      .rejects.toThrow("attachment_resource_access_denied");
  });

  it.each([
    { source: "image_generation", modelGeneration: { generationId: "uncommitted", attempt: 1, committed: false } },
    { source: "untrusted-metadata" },
  ])("does not authorize an uncommitted or untrusted generated attachment: %j", async metadata => {
    const { reader, asset, store } = await harness("generated.png", png, true);
    const part = store.conversations.listMessageParts("owner").find(part => part.type === "attachment")!;
    store.conversations.upsertMessagePart({
      id: part.id, sessionId: part.sessionId, messageId: part.messageId, type: "attachment", metadata,
    });
    await expect(reader.readImage({ authorizationSessionId: "owner", assetId: asset.id }))
      .rejects.toThrow("attachment_resource_access_denied");
  });

  it("does not borrow a successful generation call from a different message", async () => {
    const { reader, asset, store } = await harness("generated.png", png, true);
    const parts = store.conversations.listMessageParts("owner");
    const tool = parts.find(part => part.type === "tool")!;
    const attachment = parts.find(part => part.type === "attachment")!;
    store.conversationTransactions.replaceTranscript({ sessionId: "owner", messages: [
      { role: "assistant", parts: [tool] },
      { role: "assistant", parts: [attachment] },
    ] });
    await expect(reader.readImage({ authorizationSessionId: "owner", assetId: asset.id }))
      .rejects.toThrow("attachment_resource_access_denied");
  });

  it.each([
    { toolName: "PluginTool", status: "completed" as const, isError: false },
    { toolName: "ImageGeneration", status: "failed" as const, isError: true },
    { toolName: "ImageGeneration", status: "completed" as const, isError: false, metadata: { modelGeneration: { generationId: "uncommitted-tool", attempt: 1, committed: false } } },
    { toolName: "ImageGeneration", status: "completed" as const, isError: false, toolUseId: "unrelated-call" },
  ])("does not trust generated-image metadata without a successful matching ImageGeneration call: %j", async override => {
    const { reader, asset, store } = await harness("generated.png", png, true);
    const tool = store.conversations.listMessageParts("owner").find(part => part.type === "tool")!;
    store.conversations.upsertMessagePart({
      id: tool.id, sessionId: tool.sessionId, messageId: tool.messageId, type: "tool", ...override,
    });
    await expect(reader.readImage({ authorizationSessionId: "owner", assetId: asset.id }))
      .rejects.toThrow("attachment_resource_access_denied");
  });

  it("reads the same original bytes from durable input references after reopening the store", async () => {
    const { reader, asset } = await harness();
    const image = await reader.readImage({ authorizationSessionId: "owner", assetId: asset.id });
    expect(image).toMatchObject({ assetId: "att_image", displayName: "screen.png", mediaType: "image/png" });
    expect(Buffer.from(image!.bytes)).toEqual(png);
    expect(await readFile(image!.path)).toEqual(png);
    expect(createHash("sha256").update(image!.bytes).digest("hex")).toBe(asset.sha256);
  });

  it("rejects another conversation and rechecks a reference removed after reader construction", async () => {
    const { reader, store, asset } = await harness();
    await expect(reader.readImage({ authorizationSessionId: "other", assetId: asset.id }))
      .rejects.toThrow("attachment_resource_access_denied");
    store.conversationTransactions.deleteSessionTree("owner");
    await expect(reader.readImage({ authorizationSessionId: "owner", assetId: asset.id }))
      .rejects.toThrow("attachment_resource_access_denied");
  });

  it("rejects same-size corruption instead of sending changed image bytes", async () => {
    const { reader, attachments, asset } = await harness();
    const source = await attachments.resolveReadyContentPath(asset.id);
    const changed = Buffer.from(png);
    changed[changed.length - 1] ^= 1;
    await writeFile(source.path, changed);
    await expect(reader.readImage({ authorizationSessionId: "owner", assetId: asset.id }))
      .rejects.toThrow("attachment_resource_unavailable");
  });

  it("rejects unavailable assets even when an input reference remains", async () => {
    const { attachments, store, asset } = await harness();
    const reader = createAttachmentImageReader({
      store: store.conversations,
      attachments: {
        get: (id) => ({ ...attachments.get(id), status: "failed" }),
        openContent: (id) => attachments.openContent(id),
        resolveReadyContentPath: (id) => attachments.resolveReadyContentPath(id),
      },
    });
    await expect(reader.readImage({ authorizationSessionId: "owner", assetId: asset.id }))
      .rejects.toThrow("attachment_resource_unavailable");
  });

  it("leaves authorized text resources to the text reader", async () => {
    const { reader, asset } = await harness("notes.txt", Buffer.from("hello"));
    await expect(reader.readImage({ authorizationSessionId: "owner", assetId: asset.id })).resolves.toBeUndefined();
  });
});

describe("Read image attachment resources", () => {
  async function imageTool(visual: boolean, localOcr?: Parameters<typeof createAttachmentReadTool>[0]["localOcr"]) {
    const context = await harness();
    const tool = createAttachmentReadTool({
      defaultTool: createFileReadTool(),
      authorizationSessions: { resolve: (id) => id },
      attachmentReader: createAttachmentTextReader({ store: context.store.conversations, attachments: context.attachments }),
      attachmentImageReader: context.reader,
      supportsImageInput: async () => visual,
      ...(localOcr ? { localOcr } : {}),
    });
    return { ...context, tool };
  }

  it("returns a native image for an authorized historical URI in a WSL session", async () => {
    const { root, tool } = await imageTool(true);
    const result = await tool.execute(
      { file_path: "attachment://att_image/misleading.txt" },
      { cwd: "/work", sessionId: "owner", environment: { info: { kind: "wsl" } } } as never,
    );
    expect(result).toMatchObject({ executionState: "completed", content: [{ type: "image", source: { type: "file", mediaType: "image/png" } }] });
    expect(result.isError).not.toBe(true);
    expect(result.compactSummary).toContain("attachment://att_image/");
    expect(result.compactSummary).not.toContain(root);
    expect(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")).not.toContain(root);
  });

  it("does not send visual content to a non-visual model", async () => {
    const { tool } = await imageTool(false);
    const result = await tool.execute({ file_path: "attachment://att_image/screen.png" }, { cwd: "/work", sessionId: "owner" });
    expect(result).toMatchObject({ isError: true, failureKind: "configuration", executionState: "not_started" });
    expect(result.content.every((block) => block.type === "text")).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("不支持直接读取图片");
  });

  it("uses host OCR bytes for a non-visual model without treating the URI as a WSL file", async () => {
    const { tool } = await imageTool(false, {
      recognizeImageBytes: async ({ bytes }) => ({ status: "completed", text: Buffer.from(bytes).equals(png) ? "visible screenshot text" : "wrong bytes", lineCount: 1 }),
    });
    const result = await tool.execute(
      { file_path: "attachment://att_image/screen.png" },
      { cwd: "/work", sessionId: "owner", environment: { info: { kind: "wsl" } } } as never,
    );
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("visible screenshot text") }]);
    expect((result.content[0] as { text: string }).text).toContain("不能描述或推断其他图像内容");
  });

  it("uses OCR when a visual provider does not accept the attachment media type", async () => {
    const bmp = Buffer.alloc(58);
    bmp.write("BM");
    bmp.writeUInt32LE(58, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(1, 18);
    bmp.writeInt32LE(1, 22);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(24, 28);
    bmp.writeUInt32LE(4, 34);
    const context = await harness("scan.bmp", bmp);
    const tool = createAttachmentReadTool({
      defaultTool: createFileReadTool(),
      authorizationSessions: { resolve: (id) => id },
      attachmentReader: createAttachmentTextReader({ store: context.store.conversations, attachments: context.attachments }),
      attachmentImageReader: context.reader,
      supportsImageInput: async (_context, mediaType?: string) => mediaType !== "image/bmp",
      localOcr: { recognizeImageBytes: async () => ({ status: "completed", text: "bitmap words", lineCount: 1 }) },
    });
    const result = await tool.execute({ file_path: "attachment://att_image/scan.bmp" }, { cwd: "/work", sessionId: "owner" });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("bitmap words") }]);
  });

  it("denies a forged URI from a different conversation", async () => {
    const { tool } = await imageTool(true);
    const result = await tool.execute({ file_path: "attachment://att_image/screen.png" }, { cwd: "/work", sessionId: "other" });
    expect(result).toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
    expect(result.content).toEqual([{ type: "text", text: "attachment_resource_access_denied" }]);
  });
});
