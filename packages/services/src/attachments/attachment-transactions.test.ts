import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ApplicationOwnerConflictError,
  SessionStore,
} from "../session-runtime/store.js";
import { AttachmentRepository } from "./attachment-repository.js";

function withStore(test: (store: SessionStore, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "ohs-attachments-"));
  const path = join(directory, "sessions.db");
  const store = new SessionStore({ path });
  try {
    test(store, path);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const readyInput = {
  sha256: "a".repeat(64),
  sizeBytes: 12,
  mediaType: "text/plain",
  updatedAt: 20,
};
const representationInput = {
  id: "rep",
  assetId: "asset",
  kind: "ocr_text" as const,
  processor: "ocr",
  processorVersion: "1",
  cacheKey: "cache",
  mediaType: "text/plain",
  createdAt: 30,
};

function ready(store: SessionStore, id = "asset", createdAt = 10) {
  store.attachments.createImportingAttachment({
    id,
    displayName: `${id}.txt`,
    stagingName: `${id}.part`,
    createdAt,
  });
  return store.attachments.markAttachmentReady(id, readyInput);
}

describe("AttachmentTransactions", () => {
  it("keeps repository conditional updates from overwriting terminal asset and representation rows", () => {
    withStore((store) => {
      const repository = new AttachmentRepository((store as any).storage);
      const asset = ready(store);
      expect(
        repository.markReady("asset", { ...readyInput, sizeBytes: 99 }, 30),
      ).toBe(false);
      expect(repository.failImport("asset", "late", 30)).toBe(false);
      expect(repository.getAttachment("asset")).toEqual(asset);
      expect(repository.softDelete("asset", 40)).toBe(true);
      expect(repository.softDelete("asset", 50)).toBe(false);
      expect(
        repository.getAttachment("asset", { includeDeleted: true })?.deletedAt,
      ).toBe(40);
      repository.createAttachmentRepresentation(representationInput);
      expect(
        repository.completeRepresentation(
          "rep",
          { text: "first", metadata: { page: 1 } },
          50,
        ),
      ).toBe(true);
      expect(
        repository.completeRepresentation(
          "rep",
          { text: "late", metadata: {} },
          60,
        ),
      ).toBe(false);
      expect(repository.failRepresentation("rep", "late", 60)).toBe(false);
      expect(repository.getAttachmentRepresentation("rep")).toMatchObject({
        status: "completed",
        text: "first",
        metadata: { page: 1 },
        updatedAt: 50,
      });
    });
  });

  it("roundtrips ordered assets, staging records, representations and compatibility reads on disk", () => {
    withStore((store, path) => {
      const second = ready(store, "b", 10);
      const first = ready(store, "a", 10);
      store.attachments.createImportingAttachment({
        id: "pending",
        displayName: "pending.txt",
        declaredMediaType: "text/plain",
        stagingName: "pending.part",
        createdAt: 11,
      });
      expect(
        store.attachments.listAttachments().map((asset) => asset.id),
      ).toEqual(["a", "b", "pending"]);
      expect(
        store.attachments.findReadyAttachmentByHash(readyInput.sha256),
      ).toEqual(first);
      expect(store.attachments.listImportingAttachments()).toEqual([
        {
          id: "pending",
          displayName: "pending.txt",
          declaredMediaType: "text/plain",
          stagingName: "pending.part",
          status: "importing",
          createdAt: 11,
          updatedAt: 11,
        },
      ]);
      store.attachments.createAttachmentRepresentation({
        ...representationInput,
        assetId: "a",
      });
      expect(
        store.attachments.findCompletedAttachmentRepresentation(
          "a",
          "ocr_text",
          "cache",
        ),
      ).toBeUndefined();
      const completed = store.attachments.completeAttachmentRepresentation("rep", {
        text: "你好",
        metadata: { pages: [1, 2] },
        updatedAt: 40,
      });
      expect(completed).toMatchObject({
        status: "completed",
        text: "你好",
        metadata: { pages: [1, 2] },
        createdAt: 30,
        updatedAt: 40,
      });
      store.attachments.softDeleteAttachment("b", 50);
      expect(store.attachments.getAttachment("b")).toBeUndefined();
      expect(
        store.attachments.listAttachments({ includeDeleted: true }),
      ).toHaveLength(3);
      store.close();
      const reopened = new SessionStore({ path });
      try {
        expect(reopened.attachments.getAttachment("a")).toEqual(first);
        expect(
          reopened.attachments.getAttachment("b", { includeDeleted: true }),
        ).toEqual({
          ...second,
          status: "deleted",
          updatedAt: 50,
          deletedAt: 50,
        });
        expect(reopened.attachments.listAttachmentRepresentations("a")).toEqual(
          [completed],
        );
        expect(
          reopened.attachments.findCompletedAttachmentRepresentation(
            "a",
            "ocr_text",
            "cache",
          ),
        ).toEqual(completed);
      } finally {
        reopened.close();
      }
    });
  });

  it("rejects invalid and repeated transitions without changing stored rows", () => {
    withStore((store) => {
      const asset = ready(store);
      expect(() =>
        store.attachments.markAttachmentReady("asset", readyInput),
      ).toThrow("expected importing status, received ready");
      expect(() =>
        store.attachments.failAttachmentImport("asset", "broken", 30),
      ).toThrow("expected importing status, received ready");
      expect(() =>
        store.attachments.softDeleteAttachment("asset", -1),
      ).toThrow();
      expect(store.attachments.getAttachment("asset")).toEqual(asset);
      store.attachments.createAttachmentRepresentation(representationInput);
      const failed = store.attachments.failAttachmentRepresentation(
        "rep",
        "broken",
        40,
      );
      expect(() =>
        store.attachments.completeAttachmentRepresentation("rep", {
          text: "late",
          metadata: {},
        }),
      ).toThrow("is not running");
      expect(() =>
        store.attachments.failAttachmentRepresentation("rep", "late"),
      ).toThrow("is not running");
      expect(store.attachments.getAttachmentRepresentation("rep")).toEqual(failed);
    });
  });

  it("rolls back a batch after a later lease insert fails and preserves an existing lease", () => {
    withStore((store) => {
      ready(store, "a");
      ready(store, "b");
      const input = {
        assetIds: ["a"],
        ownerKind: "backup" as const,
        ownerId: "backup",
        timestamp: 100,
        expiresAt: 200,
      };
      const original = store.attachments.acquireAttachmentLeases(input);
      (store as any).storage.database.connection.exec(
        `CREATE TRIGGER fail_second_lease BEFORE INSERT ON attachment_lease WHEN NEW.asset_id = 'b' BEGIN SELECT RAISE(ABORT, 'lease insert failed'); END;`,
      );
      expect(() =>
        store.attachments.acquireAttachmentLeases({
          ...input,
          assetIds: ["a", "b"],
          timestamp: 110,
          expiresAt: 300,
        }),
      ).toThrow("lease insert failed");
      expect(store.attachments.listAttachmentLeases()).toEqual(original);
      expect(() =>
        store.attachments.acquireAttachmentLeases({
          ...input,
          assetIds: ["a", "missing"],
        }),
      ).toThrow("Attachment is not ready: missing");
      expect(store.attachments.listAttachmentLeases()).toEqual(original);
    });
  });

  it("deduplicates leases and respects expiry, renewal, and idempotent release boundaries", () => {
    withStore((store) => {
      ready(store);
      const input = {
        assetIds: ["asset", "asset"],
        ownerKind: "backup" as const,
        ownerId: "backup",
        timestamp: 100,
        expiresAt: 200,
      };
      const leases = store.attachments.acquireAttachmentLeases(input);
      expect(leases).toHaveLength(1);
      expect(leases[0]).toMatchObject({
        assetId: "asset",
        ownerKind: "backup",
        ownerId: "backup",
        createdAt: 100,
        renewedAt: 100,
        expiresAt: 200,
      });
      expect(store.attachments.listActiveAttachmentLeases(199)).toEqual(leases);
      expect(store.attachments.listActiveAttachmentLeases(200)).toEqual([]);
      expect(
        store.attachments.renewAttachmentLeases({
          ...input,
          timestamp: 200,
          expiresAt: 300,
        }),
      ).toBe(0);
      expect(store.attachments.deleteExpiredAttachmentLeases(200)).toBe(1);
      expect(() =>
        store.attachments.acquireAttachmentLeases({ ...input, expiresAt: 100 }),
      ).toThrow("Attachment lease expiry must be after its timestamp");
      store.attachments.acquireAttachmentLeases(input);
      expect(
        store.attachments.releaseAttachmentLeases("backup", "backup"),
      ).toBe(1);
      expect(
        store.attachments.releaseAttachmentLeases("backup", "backup"),
      ).toBe(0);
    });
  });

  it("uses unflushed input and message references to protect deletion and purge inside a transaction", () => {
    withStore((store) => {
      ready(store, "input-asset");
      ready(store, "part-asset");
      store.sessions.create({ id: "s", cwd: process.cwd(), model: "m" });
      store.transaction(() => {
        store.conversationTransactions.admitPrompt({
          id: "input",
          sessionId: "s",
          content: "read",
          attachments: [{ assetId: "input-asset" }],
        });
        store.conversations.createMessage({ id: "message", sessionId: "s", role: "user" });
        store.conversations.upsertMessagePart({
          id: "part",
          messageId: "message",
          sessionId: "s",
          type: "attachment",
          assetId: "part-asset",
          attachmentIntent: "auto",
          displayName: "part.txt",
          mediaType: "text/plain",
          sizeBytes: 12,
          status: "completed",
        });
        for (const assetId of ["input-asset", "part-asset"]) {
          expect(store.attachments.countAttachmentReferences(assetId)).toBe(1);
          expect(() =>
            store.attachments.softDeleteUnreferencedAttachment(assetId, 50),
          ).toThrow("attachment_in_use");
          store.attachments.softDeleteAttachment(assetId, 50);
          expect(
            store.attachments.purgeDeletedAttachment(assetId, 60),
          ).toBeUndefined();
          expect(
            store.attachments.getAttachment(assetId, { includeDeleted: true })?.status,
          ).toBe("deleted");
        }
      });
    });
  });

  it("purges only deleted unreferenced assets after their leases expire and rolls back with the outer transaction", () => {
    withStore((store) => {
      ready(store);
      expect(
        store.attachments.purgeDeletedAttachment("asset", 100),
      ).toBeUndefined();
      store.attachments.createAttachmentRepresentation(representationInput);
      store.attachments.acquireAttachmentLeases({
        assetIds: ["asset"],
        ownerKind: "backup",
        ownerId: "b",
        timestamp: 100,
        expiresAt: 200,
      });
      const deleted = store.attachments.softDeleteUnreferencedAttachment(
        "asset",
        110,
      );
      expect(
        store.attachments.purgeDeletedAttachment("asset", 199),
      ).toBeUndefined();
      expect(() =>
        store.transaction(() => {
          expect(
            store.attachments.purgeDeletedAttachment("asset", 200),
          ).toEqual(deleted);
          expect(
            store.attachments.getAttachmentRepresentation("rep"),
          ).toBeUndefined();
          throw new Error("outer rollback");
        }),
      ).toThrow("outer rollback");
      expect(
        store.attachments.getAttachment("asset", { includeDeleted: true }),
      ).toEqual(deleted);
      expect(store.attachments.listAttachmentLeases()).toHaveLength(1);
      expect(
        store.attachments.getAttachmentRepresentation("rep"),
      ).toBeDefined();
      expect(store.attachments.purgeDeletedAttachment("asset", 200)).toEqual(deleted);
      expect(store.attachments.listAttachmentLeases()).toEqual([]);
    });
  });

  it("fences every attachment write after owner takeover, including no-op batches", () => {
    withStore((store, path) => {
      store.acquireApplicationOwner({
        ownerId: "first",
        pid: 1,
        staleAfterMs: 100,
        now: 1000,
      });
      ready(store);
      store.attachments.createImportingAttachment({
        id: "pending",
        displayName: "p",
        stagingName: "p.part",
        createdAt: 10,
      });
      store.attachments.createAttachmentRepresentation(representationInput);
      const second = new SessionStore({ path });
      try {
        second.acquireApplicationOwner({
          ownerId: "second",
          pid: 2,
          staleAfterMs: 100,
          now: 1101,
        });
        for (const api of [store.attachments]) {
          const writes = [
            () =>
              api.createImportingAttachment({
                id: "new",
                displayName: "n",
                stagingName: "n.part",
              }),
            () => api.markAttachmentReady("pending", readyInput),
            () => api.failAttachmentImport("pending", "broken"),
            () => api.softDeleteAttachment("asset"),
            () => api.softDeleteUnreferencedAttachment("asset"),
            () => api.purgeDeletedAttachment("asset"),
            () =>
              api.createAttachmentRepresentation({
                ...representationInput,
                id: "new-rep",
              }),
            () =>
              api.completeAttachmentRepresentation("rep", {
                text: "text",
                metadata: {},
              }),
            () => api.failAttachmentRepresentation("rep", "broken"),
            () =>
              api.acquireAttachmentLeases({
                assetIds: [],
                ownerKind: "backup",
                ownerId: "b",
                timestamp: 100,
                expiresAt: 200,
              }),
            () =>
              api.renewAttachmentLeases({
                ownerKind: "backup",
                ownerId: "b",
                timestamp: 100,
                expiresAt: 200,
              }),
            () => api.releaseAttachmentLeases("backup", "b"),
            () => api.deleteExpiredAttachmentLeases(200),
          ];
          for (const write of writes)
            expect(write).toThrow(ApplicationOwnerConflictError);
        }
        expect(store.attachments.getAttachment("pending")?.status).toBe("importing");
        expect(store.attachments.getAttachment("asset")?.status).toBe("ready");
        expect(store.attachments.getAttachment("new")).toBeUndefined();
        expect(store.attachments.getAttachmentRepresentation("rep")?.status).toBe(
          "running",
        );
        expect(store.attachments.getAttachmentRepresentation("new-rep")).toBeUndefined();
        expect(store.attachments.listAttachmentLeases()).toEqual([]);
      } finally {
        second.close();
      }
    });
  });
});
