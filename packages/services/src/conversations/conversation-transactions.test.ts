import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SessionStore } from "../session-runtime/store.js";
import {
  ConversationTransactions,
  type ConversationTransactionTestHooks,
} from "./conversation-transactions.js";

function createReadyAttachment(
  store: SessionStore,
  id: string,
  sizeBytes: number,
  mime = "text/plain",
) {
  store.createImportingAttachment({
    id,
    displayName: `${id}.txt`,
    declaredMediaType: mime,
    stagingName: `${id}.part`,
    createdAt: 10,
  });
  store.markAttachmentReady(id, {
    sha256: "a".repeat(64),
    sizeBytes,
    mediaType: mime,
    updatedAt: 11,
  });
}

describe("ConversationTransactions.admitPrompt", () => {
  describe("admission matrix", () => {
    it("admits plain text prompt and updates placeholder title on first prompt", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-admit-matrix-"));
      const store = new SessionStore({ path: join(dir, "store.db") });
      try {
        const tx = new ConversationTransactions({
          storage: (store as any).storage,
          conversations: store.conversations,
          attachments: store.attachments,
          save: () => (store as any).save(),
        });

        store.createSession({ id: "s1", cwd: dir, model: "m", title: "" });
        const input = tx.admitPrompt({
          sessionId: "s1",
          content: "Hello world",
        });

        expect(input.seq).toBe(1);
        expect(input.content).toBe("Hello world");
        expect(input.delivery).toBe("queue");
        expect(input.attachments).toEqual([]);
        expect(store.getSession("s1")!.title).toBe("Hello world");

        const events = store.listEvents({ sessionId: "s1" });
        expect(events.some((e) => e.type === "session.input.admitted")).toBe(true);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("admits structured items with skills and text", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-admit-struct-"));
      const store = new SessionStore({ path: join(dir, "store.db") });
      try {
        const tx = new ConversationTransactions({
          storage: (store as any).storage,
          conversations: store.conversations,
          attachments: store.attachments,
          save: () => (store as any).save(),
        });

        store.createSession({ id: "s1", cwd: dir, model: "m" });
        const input = tx.admitPrompt({
          sessionId: "s1",
          items: [
            { type: "skill", name: "review", path: "/repo/review/SKILL.md" },
            { type: "text", text: " please review" },
          ],
        });

        expect(input.content).toBe("$review please review");
        expect(input.items).toHaveLength(2);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rejects empty text and empty items when attachments are empty", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-admit-empty-"));
      const store = new SessionStore({ path: join(dir, "store.db") });
      try {
        const tx = new ConversationTransactions({
          storage: (store as any).storage,
          conversations: store.conversations,
          attachments: store.attachments,
          save: () => (store as any).save(),
        });

        store.createSession({ id: "s1", cwd: dir, model: "m" });
        expect(() =>
          tx.admitPrompt({ sessionId: "s1", content: "" }),
        ).toThrow(/prompt_content_required/);

        expect(() =>
          tx.admitPrompt({ sessionId: "s1", items: [] }),
        ).toThrow(/prompt_content_required/);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("handles idempotency: returns same record if same content, throws conflict if different content", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-admit-idemp-"));
      const store = new SessionStore({ path: join(dir, "store.db") });
      try {
        const tx = new ConversationTransactions({
          storage: (store as any).storage,
          conversations: store.conversations,
          attachments: store.attachments,
          save: () => (store as any).save(),
        });

        store.createSession({ id: "s1", cwd: dir, model: "m" });
        const first = tx.admitPrompt({
          id: "input-1",
          sessionId: "s1",
          content: "same content",
          metadata: { traceId: "trace-1", user: "alice" },
        });

        // Same ID and content, different traceId (trace metadata should be ignored in idempotency comparison)
        const second = tx.admitPrompt({
          id: "input-1",
          sessionId: "s1",
          content: "same content",
          metadata: { traceId: "trace-2", user: "alice" },
        });

        expect(second.id).toBe(first.id);
        expect(second.seq).toBe(first.seq);

        // Conflict: same ID, different content
        expect(() =>
          tx.admitPrompt({
            id: "input-1",
            sessionId: "s1",
            content: "different content",
          }),
        ).toThrow(/prompt_id_conflict/);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("steer delivery: preserved if no attachments, downgraded to queue if attachments present", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-admit-steer-"));
      const store = new SessionStore({ path: join(dir, "store.db") });
      try {
        const tx = new ConversationTransactions({
          storage: (store as any).storage,
          conversations: store.conversations,
          attachments: store.attachments,
          save: () => (store as any).save(),
        });

        store.createSession({ id: "s1", cwd: dir, model: "m" });
        createReadyAttachment(store, "att-1", 10);

        const steerNoAtt = tx.admitPrompt({
          sessionId: "s1",
          content: "no att",
          delivery: "steer",
        });
        expect(steerNoAtt.delivery).toBe("steer");

        const steerWithAtt = tx.admitPrompt({
          sessionId: "s1",
          content: "with att",
          delivery: "steer",
          attachments: [{ assetId: "att-1" }],
        });
        expect(steerWithAtt.delivery).toBe("queue");
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("validates attachment errors: not found, deleted, not ready, too large, count exceeded, prompt bytes, session bytes", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-admit-att-err-"));
      const store = new SessionStore({
        path: join(dir, "store.db"),
        attachmentLimits: {
          maxFilesPerPrompt: 2,
          maxBytesPerFile: 50,
          maxBytesPerPrompt: 80,
          maxSessionReferencedBytes: 100,
          resumableThresholdBytes: 40,
        },
      });
      try {
        const tx = new ConversationTransactions({
          storage: (store as any).storage,
          conversations: store.conversations,
          attachments: store.attachments,
          attachmentLimits: (store as any).attachmentLimits,
          save: () => (store as any).save(),
        });

        store.createSession({ id: "s1", cwd: dir, model: "m" });
        createReadyAttachment(store, "ready-1", 30);
        createReadyAttachment(store, "ready-2", 40);
        createReadyAttachment(store, "ready-3", 20);
        createReadyAttachment(store, "oversized", 60);

        store.createImportingAttachment({
          id: "importing",
          displayName: "imp.txt",
          declaredMediaType: "text/plain",
          stagingName: "imp.part",
          createdAt: 10,
        });

        store.createImportingAttachment({
          id: "deleted-att",
          displayName: "del.txt",
          declaredMediaType: "text/plain",
          stagingName: "del.part",
          createdAt: 10,
        });
        store.markAttachmentReady("deleted-att", {
          sha256: "b".repeat(64),
          sizeBytes: 10,
          mediaType: "text/plain",
          updatedAt: 11,
        });
        store.softDeleteAttachment("deleted-att");

        // 1. Not found
        expect(() =>
          tx.admitPrompt({
            sessionId: "s1",
            content: "test",
            attachments: [{ assetId: "missing-id" }],
          }),
        ).toThrow(/attachment_not_found/);

        // 2. Deleted
        expect(() =>
          tx.admitPrompt({
            sessionId: "s1",
            content: "test",
            attachments: [{ assetId: "deleted-att" }],
          }),
        ).toThrow(/attachment_not_found/);

        // 3. Not ready
        expect(() =>
          tx.admitPrompt({
            sessionId: "s1",
            content: "test",
            attachments: [{ assetId: "importing" }],
          }),
        ).toThrow(/attachment_not_ready/);

        // 4. Too large per file
        expect(() =>
          tx.admitPrompt({
            sessionId: "s1",
            content: "test",
            attachments: [{ assetId: "oversized" }],
          }),
        ).toThrow(/attachment_too_large/);

        // 5. Count exceeded (limit is 2)
        expect(() =>
          tx.admitPrompt({
            sessionId: "s1",
            content: "test",
            attachments: [
              { assetId: "ready-1" },
              { assetId: "ready-2" },
              { assetId: "ready-3" },
            ],
          }),
        ).toThrow(/attachment_count_exceeded/);

        // 6. Prompt bytes exceeded
        expect(() =>
          tx.admitPrompt(
            {
              sessionId: "s1",
              content: "test",
              attachments: [{ assetId: "ready-1" }, { assetId: "ready-2" }],
            },
            { attachmentLimits: { maxBytesPerPrompt: 65 } },
          ),
        ).toThrow(/attachment_prompt_size_exceeded/);

        // 7. Session bytes exceeded: first prompt uses ready-1 (30) + ready-2 (40) = 70.
        tx.admitPrompt({
          sessionId: "s1",
          content: "first",
          attachments: [{ assetId: "ready-1" }, { assetId: "ready-2" }],
        });

        // Second prompt references ready-3 (20): unique session bytes = 70 + 20 = 90 <= 100.
        tx.admitPrompt({
          sessionId: "s1",
          content: "second",
          attachments: [{ assetId: "ready-3" }],
        });

        // Third prompt references ready-1 again: unique bytes still 90 <= 100, succeeds!
        expect(
          tx.admitPrompt({
            sessionId: "s1",
            content: "third",
            attachments: [{ assetId: "ready-1" }],
          }),
        ).toMatchObject({ content: "third" });

        // But referencing a new 20 byte attachment with maxSessionReferencedBytes = 95 would exceed:
        createReadyAttachment(store, "ready-4", 20);
        expect(() =>
          tx.admitPrompt(
            {
              sessionId: "s1",
              content: "fourth",
              attachments: [{ assetId: "ready-4" }],
            },
            { attachmentLimits: { maxSessionReferencedBytes: 95 } },
          ),
        ).toThrow(/attachment_session_size_exceeded/);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("preserves attachment reference positions, display names, and metadata", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-admit-pos-"));
      const store = new SessionStore({ path: join(dir, "store.db") });
      try {
        const tx = new ConversationTransactions({
          storage: (store as any).storage,
          conversations: store.conversations,
          attachments: store.attachments,
          save: () => (store as any).save(),
        });

        store.createSession({ id: "s1", cwd: dir, model: "m" });
        createReadyAttachment(store, "att-b", 20);
        createReadyAttachment(store, "att-a", 10);

        const input = tx.admitPrompt({
          sessionId: "s1",
          content: "ordered attachments",
          attachments: [
            { assetId: "att-b", intent: "ocr", displayName: "Custom B" },
            { assetId: "att-a", intent: "auto" },
          ],
        });

        expect(input.attachments).toHaveLength(2);
        expect(input.attachments[0]).toMatchObject({
          assetId: "att-b",
          seq: 0,
          intent: "ocr",
          displayName: "Custom B",
          metadata: { requestedDisplayName: "Custom B" },
          sizeBytes: 20,
        });
        expect(input.attachments[1]).toMatchObject({
          assetId: "att-a",
          seq: 1,
          intent: "auto",
          displayName: "att-a.txt",
          metadata: {},
          sizeBytes: 10,
        });
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("failure injection & rollback", () => {
    it.each([
      "afterInputWrite",
      "duringAttachmentReference",
      "afterTitleUpdate",
      "afterEventAllocation",
    ] as const)(
      "rolls back all changes when error thrown at %s",
      (failurePoint) => {
        const dir = mkdtempSync(join(tmpdir(), `ohs-admit-fail-${failurePoint}-`));
        const dbPath = join(dir, "store.db");
        let store = new SessionStore({ path: dbPath });

        try {
          store.createSession({
            id: "s1",
            cwd: dir,
            model: "m",
            title: "Original Title",
          });
          createReadyAttachment(store, "att-1", 10);
          createReadyAttachment(store, "att-2", 20);

          const initialSession = store.getSession("s1")!;
          const initialEvents = store.listEvents({ sessionId: "s1" });
          const initialInputs = store.listInputs("s1");

          const testHooks: ConversationTransactionTestHooks = {
            [failurePoint]: () => {
              throw new Error(`Injected failure at ${failurePoint}`);
            },
          };

          const tx = new ConversationTransactions({
            storage: (store as any).storage,
            conversations: store.conversations,
            attachments: store.attachments,
            save: () => (store as any).save(),
            testHooks,
          });

          expect(() =>
            tx.admitPrompt({
              id: "failed-input",
              sessionId: "s1",
              content: "This prompt should rollback",
              attachments: [{ assetId: "att-1" }, { assetId: "att-2" }],
            }),
          ).toThrow(`Injected failure at ${failurePoint}`);

          // Assert in-memory state rolled back
          expect(store.listInputs("s1")).toEqual(initialInputs);
          expect(store.getInput("failed-input")).toBeUndefined();
          expect((store as any).storage.state.inputAttachments).toEqual({});
          expect(store.getSession("s1")!.title).toBe(initialSession.title);
          expect(store.getSession("s1")!.updatedAt).toBe(initialSession.updatedAt);
          expect(store.listEvents({ sessionId: "s1" })).toEqual(initialEvents);

          // Assert SQLite disk state rolled back
          store.close();
          store = new SessionStore({ path: dbPath });

          expect(store.listInputs("s1")).toEqual(initialInputs);
          expect(store.getInput("failed-input")).toBeUndefined();
          expect(store.getSession("s1")!.title).toBe(initialSession.title);
          expect(store.getSession("s1")!.updatedAt).toBe(initialSession.updatedAt);
          expect(store.listEvents({ sessionId: "s1" })).toEqual(initialEvents);
        } finally {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  });
});
