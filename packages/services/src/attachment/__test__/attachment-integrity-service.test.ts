import { mkdtempSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "../../session-runtime/store.js";
import { AttachmentApplicationService } from "../attachment-application-service.js";
import { AttachmentBlobStore } from "../attachment-blob-store.js";
import { AttachmentIntegrityService } from "../attachment-integrity-service.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function fixture(ids: string[]) {
  const root = mkdtempSync(join(tmpdir(), "oh-attachment-integrity-"));
  roots.push(root);
  const store = new SessionStore({ path: join(root, "sessions.db") });
  const blobs = new AttachmentBlobStore({ root: join(root, "attachments") });
  let index = 0;
  const attachments = new AttachmentApplicationService({
    store: store.attachments,
    blobs,
    id: () => ids[index++]!,
  });
  return { root, store, blobs, attachments };
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
    const { root, store, blobs, attachments } = fixture(["att-corrupt"]);
    try {
      const corrupt = await attachments.import({
        displayName: "corrupt.txt",
        content: content("private content"),
      });
      const corruptPath = await blobs.resolveReadOnlyPath(
        corrupt.sha256!,
        corrupt.sizeBytes!,
      );
      truncateSync(corruptPath, 3);

      store.createImportingAttachment({
        id: "att-missing",
        displayName: "missing.txt",
        stagingName: "missing.part",
        createdAt: 1,
      });
      store.markAttachmentReady("att-missing", {
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
      expect(store.getAttachment("att-missing")).toBeDefined();
      expect(report).not.toHaveProperty("root", root);
    } finally {
      store.close();
    }
  });

  it("keeps a shared blob until the last deleted asset becomes collectible", async () => {
    const { store, blobs, attachments } = fixture(["att-a", "att-b"]);
    try {
      const first = await attachments.import({ displayName: "a.txt", content: content("same") });
      const second = await attachments.import({ displayName: "b.txt", content: content("same") });
      expect(first.sha256).toBe(second.sha256);
      store.softDeleteAttachment(first.id, 100);
      const service = new AttachmentIntegrityService({ store, attachments: store.attachments, blobs, now: () => 1_000 });

      const firstGc = await service.gc({ gracePeriodMs: 100 });

      expect(firstGc).toMatchObject({ deletedAssets: 1, deletedBlobs: 0, releasedBytes: 0 });
      expect(store.getAttachment(first.id, { includeDeleted: true })).toBeUndefined();
      expect(await blobs.inspectBlob(first.sha256!)).toBeDefined();

      store.softDeleteAttachment(second.id, 200);
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
    const { store, blobs, attachments } = fixture(["att-leased"]);
    try {
      const asset = await attachments.import({ displayName: "leased.txt", content: content("lease") });
      store.acquireAttachmentLeases({
        assetIds: [asset.id],
        ownerKind: "session_run",
        ownerId: "run-1",
        timestamp: 100,
        expiresAt: 500,
      });
      store.softDeleteAttachment(asset.id, 100);
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
    const { store, blobs, attachments } = fixture(["att-generated"]);
    try {
      const asset = await attachments.import({
        displayName: "generated.png",
        declaredMediaType: "image/png",
        content: content("generated image"),
      });
      store.createSession({ id: "s-generated", cwd: process.cwd(), model: "m" });
      const message = store.createMessage({ sessionId: "s-generated", role: "assistant" });
      store.upsertMessagePart({
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
      store.softDeleteAttachment(asset.id, 100);
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
    const { store, blobs, attachments } = fixture(["att-retry"]);
    try {
      const asset = await attachments.import({ displayName: "retry.txt", content: content("retry") });
      store.softDeleteAttachment(asset.id, 100);
      const service = new AttachmentIntegrityService({ store, attachments: store.attachments, blobs, now: () => 1_000 });
      const originalDelete = blobs.deleteBlob.bind(blobs);
      vi.spyOn(blobs, "deleteBlob").mockRejectedValueOnce(new Error("locked"));

      await expect(service.gc({ gracePeriodMs: 100 })).resolves.toMatchObject({
        deletedAssets: 0,
        errors: [{ assetId: asset.id, code: "blob_delete_failed" }],
      });
      expect(store.getAttachment(asset.id, { includeDeleted: true })).toBeDefined();
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
