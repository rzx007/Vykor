import { mkdtempSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "../../session-runtime/store.js";
import { AttachmentBlobStore } from "../attachment-blob-store.js";
import { AttachmentIntegrityService } from "../attachment-integrity-service.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "oh-attachment-integrity-"));
  roots.push(root);
  const store = new SessionStore({ path: join(root, "sessions.db") });
  const blobs = new AttachmentBlobStore({ root: join(root, "attachments") });
  return { root, store, blobs };
}

async function importReadyAttachment(
  store: SessionStore,
  blobs: AttachmentBlobStore,
  id: string,
  displayName: string,
  value: string,
  declaredMediaType?: string,
) {
  store.attachments.createImportingAttachment({
    id,
    displayName,
    stagingName: `${id}.part`,
    createdAt: 1,
    ...(declaredMediaType ? { declaredMediaType } : {}),
  });
  const imported = await blobs.import({
    uploadId: id,
    content: content(value),
    maxBytes: 1024 * 1024,
    ...(declaredMediaType ? { declaredMediaType } : {}),
  });
  return store.attachments.markAttachmentReady(id, {
    sha256: imported.sha256,
    sizeBytes: imported.sizeBytes,
    mediaType: imported.mediaType,
    updatedAt: 2,
  });
}

function content(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

describe("AttachmentIntegrityService", () => {
  it("reports missing, corrupt, and orphan blobs without changing storage", async () => {
    const { root, store, blobs } = fixture();
    try {
      const corrupt = await importReadyAttachment(
        store,
        blobs,
        "att-corrupt",
        "corrupt.txt",
        "private content",
      );
      const corruptPath = await blobs.resolveReadOnlyPath(
        corrupt.sha256!,
        corrupt.sizeBytes!,
      );
      truncateSync(corruptPath, 3);

      store.attachments.createImportingAttachment({
        id: "att-missing",
        displayName: "missing.txt",
        stagingName: "missing.part",
        createdAt: 1,
      });
      store.attachments.markAttachmentReady("att-missing", {
        sha256: "f".repeat(64),
        sizeBytes: 7,
        mediaType: "text/plain",
        updatedAt: 2,
      });
      const orphan = await blobs.import({
        uploadId: "orphan",
        content: content("orphan bytes"),
        maxBytes: 100,
      });

      const service = new AttachmentIntegrityService({ store, attachments: store.attachments, blobs, now: () => 10_000 });
      const before = await blobs.listBlobs();
      const report = await service.scan({ gracePeriodMs: 1_000 });

      expect(report.issues.map((issue) => issue.code).sort()).toEqual([
        "missing_blob",
        "orphan_blob",
        "size_mismatch",
      ]);
      expect(report.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "orphan_blob", sha256: orphan.sha256 }),
      ]));
      expect(await blobs.listBlobs()).toEqual(before);
      expect(store.attachments.getAttachment("att-missing")).toBeDefined();
      expect(report).not.toHaveProperty("root", root);
    } finally {
      store.close();
    }
  });

  it("keeps a shared blob until the last deleted asset becomes collectible", async () => {
    const { store, blobs } = fixture();
    try {
      const first = await importReadyAttachment(store, blobs, "att-a", "a.txt", "same");
      const second = await importReadyAttachment(store, blobs, "att-b", "b.txt", "same");
      expect(first.sha256).toBe(second.sha256);
      store.attachments.softDeleteAttachment(first.id, 100);
      const service = new AttachmentIntegrityService({ store, attachments: store.attachments, blobs, now: () => 1_000 });

      const firstGc = await service.gc({ gracePeriodMs: 100 });

      expect(firstGc).toMatchObject({ deletedAssets: 1, deletedBlobs: 0, releasedBytes: 0 });
      expect(store.attachments.getAttachment(first.id, { includeDeleted: true })).toBeUndefined();
      expect(await blobs.inspectBlob(first.sha256!)).toBeDefined();

      store.attachments.softDeleteAttachment(second.id, 200);
      const secondGc = await service.gc({ gracePeriodMs: 100 });
      expect(secondGc).toMatchObject({ deletedAssets: 1, deletedBlobs: 1, releasedBytes: 4 });
      expect(secondGc).toMatchObject({
        scannedAssets: 1,
        expiredLeases: 0,
        errors: [],
      });
      expect(store.latestRetentionAudit("attachment_gc")).toMatchObject({
        policy: "attachment_gc",
        result: { deletedAssets: 1, deletedBlobs: 1, releasedBytes: 4 },
      });
      await expect(service.scan({ gracePeriodMs: 100 })).resolves.toMatchObject({
        latestGcAudit: {
          policy: "attachment_gc",
          result: { deletedAssets: 1, deletedBlobs: 1 },
        },
      });
      expect(await blobs.inspectBlob(first.sha256!)).toBeUndefined();
      await expect(service.gc({ gracePeriodMs: 100 })).resolves.toMatchObject({
        deletedAssets: 0,
        deletedBlobs: 0,
        releasedBytes: 0,
      });
    } finally {
      store.close();
    }
  });

  it("does not collect a deleted asset while its run lease is active", async () => {
    const { store, blobs } = fixture();
    try {
      const asset = await importReadyAttachment(
        store,
        blobs,
        "att-leased",
        "leased.txt",
        "lease",
      );
      store.attachments.acquireAttachmentLeases({
        assetIds: [asset.id],
        ownerKind: "session_run",
        ownerId: "run-1",
        timestamp: 100,
        expiresAt: 500,
      });
      store.attachments.softDeleteAttachment(asset.id, 100);
      const service = new AttachmentIntegrityService({ store, attachments: store.attachments, blobs, now: () => 300 });

      await expect(service.gc({ gracePeriodMs: 100 })).resolves.toMatchObject({
        deletedAssets: 0,
        deletedBlobs: 0,
      });
      expect(await blobs.inspectBlob(asset.sha256!)).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("does not collect a deleted asset referenced by an assistant attachment part", async () => {
    const { store, blobs } = fixture();
    try {
      const asset = await importReadyAttachment(
        store,
        blobs,
        "att-generated",
        "generated.png",
        "generated image",
        "image/png",
      );
      store.sessions.create({ id: "s-generated", cwd: process.cwd(), model: "m" });
      const message = store.conversations.createMessage({ sessionId: "s-generated", role: "assistant" });
      store.conversations.upsertMessagePart({
        sessionId: "s-generated",
        messageId: message.id,
        type: "attachment",
        status: "completed",
        assetId: asset.id,
        intent: "tool_resource",
        displayName: asset.displayName,
        mediaType: asset.mediaType,
        sizeBytes: asset.sizeBytes,
      });
      store.attachments.softDeleteAttachment(asset.id, 100);
      const service = new AttachmentIntegrityService({ store, attachments: store.attachments, blobs, now: () => 1_000 });

      await expect(service.gc({ gracePeriodMs: 100 })).resolves.toMatchObject({
        deletedAssets: 0,
        deletedBlobs: 0,
        skipped: { referenced: 1 },
      });
      expect(await blobs.inspectBlob(asset.sha256!)).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("audits a blob deletion failure, keeps the tombstone, and retries later", async () => {
    const { store, blobs } = fixture();
    try {
      const asset = await importReadyAttachment(
        store,
        blobs,
        "att-retry",
        "retry.txt",
        "retry",
      );
      store.attachments.softDeleteAttachment(asset.id, 100);
      const service = new AttachmentIntegrityService({ store, attachments: store.attachments, blobs, now: () => 1_000 });
      const originalDelete = blobs.deleteBlob.bind(blobs);
      vi.spyOn(blobs, "deleteBlob").mockRejectedValueOnce(new Error("locked"));

      await expect(service.gc({ gracePeriodMs: 100 })).resolves.toMatchObject({
        deletedAssets: 0,
        errors: [{ assetId: asset.id, code: "blob_delete_failed" }],
      });
      expect(store.attachments.getAttachment(asset.id, { includeDeleted: true })).toBeDefined();
      expect(store.latestRetentionAudit("attachment_gc")).toMatchObject({
        result: { errors: [{ assetId: asset.id, code: "blob_delete_failed" }] },
      });

      vi.mocked(blobs.deleteBlob).mockImplementation(originalDelete);
      await expect(service.gc({ gracePeriodMs: 100 })).resolves.toMatchObject({
        deletedAssets: 1,
        deletedBlobs: 1,
        errors: [],
      });
    } finally {
      store.close();
    }
  });
});
