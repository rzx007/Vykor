import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AttachmentBlobStore, SessionStore } from "@vykor/services";
import { afterEach, describe, expect, it } from "vitest";

import { AttachmentService } from "../../attachment-service.js";
import { createAttachmentContentReader, createAttachmentImageReader } from "../attachment-access.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2xkAAAAASUVORK5CYII=", "base64");
// A complete ZIP containing Content_Types, package relationships and the Word document.
const docx = Buffer.from("UEsDBAoAAAAIAAAAIVCsbhJangAAANwAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbF2PsQ7CMBBDf6XKitqrGBhQ24UdGPiBU3JtI5pLlBwF/p4EpA6Mlu1nubu9A6Xq5RZOvZpFwhEg6ZkcpsYH4uyMPjqULOMEAfUdJ4J92x5AexZiqaUw1NBdVorRGqquGOWMjnoFTx8NGK8fLiebTFPV6Vcry73CEBarUaxnWNn8bdZ+HK2mrV9oIXpNKVme3NJsjkPLu4KHoYPvqeEDUEsDBAoAAAAIAAAAIVBhey9DiQAAAPIAAAALAAAAX3JlbHMvLnJlbHONzzsOAiEQBuCrEA6ws1pYGKCy2dZ4AQLDIy6PDBj19lJYrMbCcuaffH9GnHHVPZbcQqyNPdKam+Sh93oEaCZg0m0qFfNIXKGk+xjJQ9Xmqj3Cfp4PQFuDK7E12WIlp8XuOLs8K/5jF+eiwVMxt4S5/6j4uhiyJo9d8nshC/a9ngbLQQn4eFG9AFBLAwQKAAAACAAAACFQa9Td9XkAAAChAAAAEQAAAHdvcmQvZG9jdW1lbnQueG1sRc7BDcMgDAXQVaIMUEc99IAoK3QGSihBwjYyrki3b0gPvbwv2/qSbTcrhzdG0mnHQs30+7ypVgPQwhbRtwvXSMftxYJej1ESdJa1CofYWqaEBa7LcgP0mWZnu3ny+hlZBzJQ95CcMvkySawsamEsh3JaT39F+D/lvlBLAQIUAAoAAAAIAAAAIVCsbhJangAAANwAAAATAAAAAAAAAAAAAAAAAAAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQACgAAAAgAAAAhUGF7L0OJAAAA8gAAAAsAAAAAAAAAAAAAAAAAzwAAAF9yZWxzLy5yZWxzUEsBAhQACgAAAAgAAAAhUGvU3fV5AAAAoQAAABEAAAAAAAAAAAAAAAAAgQEAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAADAAMAuQAAACkCAAAAAA==", "base64");
const roots: string[] = [];
const stores: SessionStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function harness(name = "data.bin", bytes = Buffer.from([0, 1, 255, 128, 17]), mediaType?: string) {
  const root = await mkdtemp(join(tmpdir(), "vk-attachment-content-"));
  roots.push(root);
  const databasePath = join(root, "store.db");
  let store = new SessionStore({ path: databasePath });
  const blobs = new AttachmentBlobStore({ root: join(root, "attachments") });
  let attachments = new AttachmentService({ store: store.attachments, blobs, id: () => "att_original" });
  try {
    const asset = await attachments.import({
      displayName: name,
      declaredMediaType: mediaType,
      content: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    });
    store.sessions.create({ id: "owner", cwd: root, model: "text-only" });
    store.sessions.create({ id: "other", cwd: root, model: "text-only" });
    store.conversationTransactions.admitPrompt({ id: "input", sessionId: "owner", content: "use this", attachments: [{ assetId: asset.id }] });
    store.close();
    store = new SessionStore({ path: databasePath });
    stores.push(store);
    attachments = new AttachmentService({ store: store.attachments, blobs });
    return { store, attachments, asset, bytes, reader: createAttachmentContentReader({ store: store.conversations, attachments }) };
  } catch (error) {
    store.close();
    throw error;
  }
}

describe("authorized original attachment content", () => {
  it.each([
    ["screen.png", png, "image/png"],
    ["data.bin", Buffer.from([0, 1, 255, 128, 17]), "application/octet-stream"],
    ["notes.txt", Buffer.from("\uFEFFline one\r\n中文\r\n", "utf8"), "text/plain"],
    ["report.docx", docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ])("recovers unchanged %s bytes after reopening SQLite without decoding its content", async (name, bytes, mediaType) => {
    const { reader, asset } = await harness(name, bytes, mediaType);
    const content = await reader.readContent({ authorizationSessionId: "owner", assetId: asset.id });
    expect(content).toMatchObject({ assetId: "att_original", displayName: name, mediaType });
    expect(Buffer.from(content.bytes)).toEqual(bytes);
    expect(await readFile(content.path)).toEqual(bytes);
  });

  it("denies foreign and revoked durable references for non-image attachments", async () => {
    const { reader, asset, store } = await harness();
    await expect(reader.readContent({ authorizationSessionId: "other", assetId: asset.id })).rejects.toThrow("attachment_resource_access_denied");
    store.conversationTransactions.deleteSessionTree("owner");
    await expect(reader.readContent({ authorizationSessionId: "owner", assetId: asset.id })).rejects.toThrow("attachment_resource_access_denied");
  });

  it("rejects same-size corruption before bytes can be exported", async () => {
    const { reader, asset, attachments, bytes } = await harness();
    const source = await attachments.resolveReadyContentPath(asset.id);
    const damaged = Buffer.from(bytes);
    damaged[damaged.length - 1] ^= 1;
    await writeFile(source.path, damaged);
    await expect(reader.readContent({ authorizationSessionId: "owner", assetId: asset.id })).rejects.toThrow("attachment_resource_unavailable");
  });

  it("checks ownership again when an input is revoked during the byte read", async () => {
    const { asset, store, attachments } = await harness();
    const reader = createAttachmentContentReader({
      store: store.conversations,
      attachments: {
        get: (id) => attachments.get(id),
        resolveReadyContentPath: (id) => attachments.resolveReadyContentPath(id),
        openContent: async (id) => {
          const opened = await attachments.openContent(id);
          let revoked = false;
          return { ...opened, content: opened.content.pipeThrough(new TransformStream({ transform(chunk, controller) {
            if (!revoked) { revoked = true; store.conversationTransactions.deleteSessionTree("owner"); }
            controller.enqueue(chunk);
          } })) };
        },
      },
    });
    await expect(reader.readContent({ authorizationSessionId: "owner", assetId: asset.id })).rejects.toThrow("attachment_resource_access_denied");
  });

  it("does not ignore cancellation before reading a ready attachment", async () => {
    const { reader, asset } = await harness();
    const controller = new AbortController();
    controller.abort(new Error("content read cancelled"));
    await expect(reader.readContent({ authorizationSessionId: "owner", assetId: asset.id, signal: controller.signal })).rejects.toThrow("content read cancelled");
  });

  it("keeps the image reader's non-image fast path without rereading the file", async () => {
    const { asset, store, attachments } = await harness("notes.txt", Buffer.from("text"), "text/plain");
    const reader = createAttachmentImageReader({
      store: store.conversations,
      attachments: {
        get: () => { throw new Error("non-image content should not be opened"); },
        openContent: () => { throw new Error("non-image content should not be opened"); },
        resolveReadyContentPath: () => { throw new Error("non-image content should not be opened"); },
      },
    });
    await expect(reader.readImage({ authorizationSessionId: "owner", assetId: asset.id })).resolves.toBeUndefined();
    expect(attachments.get(asset.id).status).toBe("ready");
  });
});
