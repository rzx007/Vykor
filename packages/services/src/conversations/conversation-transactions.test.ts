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
  store.attachments.createImportingAttachment({
    id,
    displayName: `${id}.txt`,
    declaredMediaType: mime,
    stagingName: `${id}.part`,
    createdAt: 10,
  });
  store.attachments.markAttachmentReady(id, {
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

        store.sessions.create({ id: "s1", cwd: dir, model: "m", title: "" });
        const input = tx.admitPrompt({
          sessionId: "s1",
          content: "Hello world",
        });

        expect(input.seq).toBe(1);
        expect(input.content).toBe("Hello world");
        expect(input.delivery).toBe("queue");
        expect(input.attachments).toEqual([]);
        expect(store.sessions.get("s1")!.title).toBe("Hello world");

        const events = store.conversations.listEvents({ sessionId: "s1" });
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

        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
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

        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
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

        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
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

        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
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

        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
        createReadyAttachment(store, "ready-1", 30);
        createReadyAttachment(store, "ready-2", 40);
        createReadyAttachment(store, "ready-3", 20);
        createReadyAttachment(store, "oversized", 60);

        store.attachments.createImportingAttachment({
          id: "importing",
          displayName: "imp.txt",
          declaredMediaType: "text/plain",
          stagingName: "imp.part",
          createdAt: 10,
        });

        store.attachments.createImportingAttachment({
          id: "deleted-att",
          displayName: "del.txt",
          declaredMediaType: "text/plain",
          stagingName: "del.part",
          createdAt: 10,
        });
        store.attachments.markAttachmentReady("deleted-att", {
          sha256: "b".repeat(64),
          sizeBytes: 10,
          mediaType: "text/plain",
          updatedAt: 11,
        });
        store.attachments.softDeleteAttachment("deleted-att");

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

        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
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
          store.sessions.create({
            id: "s1",
            cwd: dir,
            model: "m",
            title: "Original Title",
          });
          createReadyAttachment(store, "att-1", 10);
          createReadyAttachment(store, "att-2", 20);

          const initialSession = store.sessions.get("s1")!;
          const initialEvents = store.conversations.listEvents({ sessionId: "s1" });
          const initialInputs = store.conversations.listInputs("s1");

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
          expect(store.conversations.listInputs("s1")).toEqual(initialInputs);
          expect(store.conversations.getInput("failed-input")).toBeUndefined();
          expect((store as any).storage.state.inputAttachments).toEqual({});
          expect(store.sessions.get("s1")!.title).toBe(initialSession.title);
          expect(store.sessions.get("s1")!.updatedAt).toBe(initialSession.updatedAt);
          expect(store.conversations.listEvents({ sessionId: "s1" })).toEqual(initialEvents);

          // Assert SQLite disk state rolled back
          store.close();
          store = new SessionStore({ path: dbPath });

          expect(store.conversations.listInputs("s1")).toEqual(initialInputs);
          expect(store.conversations.getInput("failed-input")).toBeUndefined();
          expect(store.sessions.get("s1")!.title).toBe(initialSession.title);
          expect(store.sessions.get("s1")!.updatedAt).toBe(initialSession.updatedAt);
          expect(store.conversations.listEvents({ sessionId: "s1" })).toEqual(initialEvents);
        } finally {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  });

  describe("admitPromptWithRun", () => {
    it("admits queued prompt and creates owning root run atomically", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-admit-run-"));
      const store = new SessionStore({ path: join(dir, "store.db") });
      try {
        const tx = new ConversationTransactions({
          storage: (store as any).storage,
          conversations: store.conversations,
          runs: store.runs,
          attachments: store.attachments,
          save: () => (store as any).save(),
        });

        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
        const result = tx.admitPromptWithRun({
          prompt: { sessionId: "s1", content: "Run this task" },
          run: { metadata: { source: "test" } },
        });

        expect(result.input.content).toBe("Run this task");
        expect(result.run.sessionId).toBe("s1");
        expect(result.run.inputId).toBe(result.input.id);
        expect(result.run.metadata).toEqual({ source: "test" });
        expect(result.run.status).toBe("pending");

        // Verify owning run query
        expect(store.runs.findOwningRunByInput(result.input.id)?.id).toBe(result.run.id);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns existing input and owning run on retry with same content", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-admit-run-retry-"));
      const store = new SessionStore({ path: join(dir, "store.db") });
      try {
        const tx = new ConversationTransactions({
          storage: (store as any).storage,
          conversations: store.conversations,
          runs: store.runs,
          attachments: store.attachments,
          save: () => (store as any).save(),
        });

        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
        const first = tx.admitPromptWithRun({
          prompt: { id: "input-retry", sessionId: "s1", content: "Retry prompt" },
        });

        const second = tx.admitPromptWithRun({
          prompt: { id: "input-retry", sessionId: "s1", content: "Retry prompt" },
        });

        expect(second.input.id).toBe(first.input.id);
        expect(second.run.id).toBe(first.run.id);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("throws if delivery is steer", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-admit-run-steer-"));
      const store = new SessionStore({ path: join(dir, "store.db") });
      try {
        const tx = new ConversationTransactions({
          storage: (store as any).storage,
          conversations: store.conversations,
          runs: store.runs,
          attachments: store.attachments,
          save: () => (store as any).save(),
        });

        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
        expect(() =>
          tx.admitPromptWithRun({
            prompt: { sessionId: "s1", content: "steer", delivery: "steer" },
          }),
        ).toThrow("Steered prompts cannot create their owning run during admission");
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rolls back input if run creation fails", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-admit-run-fail-"));
      const dbPath = join(dir, "store.db");
      let store = new SessionStore({ path: dbPath });
      try {
        store.sessions.create({ id: "s1", cwd: dir, model: "m" });

        const tx = new ConversationTransactions({
          storage: (store as any).storage,
          conversations: store.conversations,
          runs: store.runs,
          attachments: store.attachments,
          save: () => (store as any).save(),
          testHooks: {
            beforeRunCreation: () => {
              throw new Error("Simulated failure during run creation");
            },
          },
        });

        expect(() =>
          tx.admitPromptWithRun({
            prompt: { id: "should-rollback", sessionId: "s1", content: "Rollback prompt" },
          }),
        ).toThrow("Simulated failure during run creation");

        expect(store.conversations.getInput("should-rollback")).toBeUndefined();
        expect(store.conversations.listInputs("s1")).toEqual([]);
        expect(store.runs.listRuns("s1")).toEqual([]);

        // Reopen store from SQLite
        store.close();
        store = new SessionStore({ path: dbPath });
        expect(store.conversations.getInput("should-rollback")).toBeUndefined();
        expect(store.conversations.listInputs("s1")).toEqual([]);
        expect(store.runs.listRuns("s1")).toEqual([]);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not create a run if input id exists with different content", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-admit-run-conflict-"));
      const store = new SessionStore({ path: join(dir, "store.db") });
      try {
        const tx = new ConversationTransactions({
          storage: (store as any).storage,
          conversations: store.conversations,
          runs: store.runs,
          attachments: store.attachments,
          save: () => (store as any).save(),
        });

        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
        tx.admitPrompt({ id: "input-1", sessionId: "s1", content: "Original" });

        expect(() =>
          tx.admitPromptWithRun({
            prompt: { id: "input-1", sessionId: "s1", content: "Conflict" },
          }),
        ).toThrow(/prompt_id_conflict/);

        expect(store.runs.listRuns("s1")).toHaveLength(0);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("createReplayRun", () => {
    it("creates replay run for existing input with metadata", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-replay-run-"));
      const store = new SessionStore({ path: join(dir, "store.db") });
      try {
        const tx = new ConversationTransactions({
          storage: (store as any).storage,
          conversations: store.conversations,
          runs: store.runs,
          attachments: store.attachments,
          save: () => (store as any).save(),
        });

        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
        const input = tx.admitPrompt({ sessionId: "s1", content: "Source prompt" });

        const replayRun = tx.createReplayRun(input.id, {
          id: "replay-1",
          metadata: { replay: true },
        });

        expect(replayRun.id).toBe("replay-1");
        expect(replayRun.sessionId).toBe("s1");
        expect(replayRun.inputId).toBe(input.id);
        expect(replayRun.metadata).toEqual({ replay: true });
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("throws if source input does not exist", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-replay-missing-"));
      const store = new SessionStore({ path: join(dir, "store.db") });
      try {
        const tx = new ConversationTransactions({
          storage: (store as any).storage,
          conversations: store.conversations,
          runs: store.runs,
          attachments: store.attachments,
          save: () => (store as any).save(),
        });

        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
        expect(() => tx.createReplayRun("non-existent")).toThrow(
          "Session input not found: non-existent",
        );
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("supports explicit id idempotency and throws on explicit id conflict", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-replay-idemp-"));
      const store = new SessionStore({ path: join(dir, "store.db") });
      try {
        const tx = new ConversationTransactions({
          storage: (store as any).storage,
          conversations: store.conversations,
          runs: store.runs,
          attachments: store.attachments,
          save: () => (store as any).save(),
        });

        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
        store.sessions.create({ id: "s2", cwd: dir, model: "m" });
        const input1 = tx.admitPrompt({ sessionId: "s1", content: "Prompt 1" });
        const input2 = tx.admitPrompt({ sessionId: "s2", content: "Prompt 2" });

        const first = tx.createReplayRun(input1.id, { id: "replay-id" });
        const retried = tx.createReplayRun(input1.id, { id: "replay-id" });
        expect(retried.id).toBe(first.id);

        // Conflict: same run id used for a different session / input
        expect(() =>
          tx.createReplayRun(input2.id, { id: "replay-id" }),
        ).toThrow("Replay run id is already used: replay-id");
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("transcript replacement and prompt edit", () => {
    function createTransactions(store: SessionStore, hooks?: ConversationTransactionTestHooks) {
      return new ConversationTransactions({
        storage: (store as any).storage,
        conversations: store.conversations,
        sessions: store.sessions,
        runs: store.runs,
        permissions: store.permissions,
        attachments: store.attachments,
        save: () => (store as any).save(),
        notifySessionTask: (taskId) => (store as any).notifySessionTask(taskId),
        testHooks: hooks,
      });
    }

    it("replaces every message and part, preserves all part fields, and survives reopen", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-replace-transcript-"));
      const dbPath = join(dir, "store.db");
      let store = new SessionStore({ path: dbPath });
      try {
        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
        const oldMessage = store.conversations.createMessage({ id: "old-message", sessionId: "s1", role: "user" });
        store.conversations.upsertMessagePart({
          id: "old-part",
          sessionId: "s1",
          messageId: oldMessage.id,
          type: "text",
          status: "completed",
          text: "old",
        });
        const previousUpdatedAt = store.sessions.get("s1")!.updatedAt;

        let observedDeletedMessages = false;
        let observedDeletedParts = false;
        const result = createTransactions(store, {
          afterTranscriptReplacement: () => {
            const mutations = (store as any).storage.mutations;
            observedDeletedMessages = mutations.deletedMessages.has("old-message");
            observedDeletedParts = mutations.deletedParts.has("old-part");
          },
        }).replaceTranscript({
          sessionId: "s1",
          messages: [{
            role: "assistant",
            metadata: { summary: true },
            parts: [{
              type: "tool",
              status: "failed",
              text: "replacement",
              toolUseId: "tool-use",
              toolName: "reader",
              input: { path: "README.md" },
              output: { code: 1 },
              isError: true,
              assetId: "asset-1",
              intent: "ocr",
              displayName: "readme.txt",
              mediaType: "text/plain",
              sizeBytes: 12,
              kind: "document_extract",
              representationId: "representation-1",
              processor: "text-extractor",
              transformationError: "partial",
              metadata: { source: "test" },
            }],
          }],
        });

        expect(result.messages).toEqual([
          expect.objectContaining({ sessionId: "s1", seq: 1, role: "assistant", metadata: { summary: true } }),
        ]);
        expect(result.parts).toEqual([
          expect.objectContaining({
            sessionId: "s1",
            messageId: result.messages[0]!.id,
            seq: 1,
            type: "tool",
            status: "failed",
            text: "replacement",
            toolUseId: "tool-use",
            toolName: "reader",
            input: { path: "README.md" },
            output: { code: 1 },
            isError: true,
            assetId: "asset-1",
            intent: "ocr",
            displayName: "readme.txt",
            mediaType: "text/plain",
            sizeBytes: 12,
            kind: "document_extract",
            representationId: "representation-1",
            processor: "text-extractor",
            transformationError: "partial",
            metadata: { source: "test" },
          }),
        ]);
        expect(observedDeletedMessages).toBe(true);
        expect(observedDeletedParts).toBe(true);
        expect(store.sessions.get("s1")!.updatedAt).toBeGreaterThanOrEqual(previousUpdatedAt);
        expect(
          store.conversations.listEvents({ sessionId: "s1" })
            .filter(({ type }) => type === "session.transcript.replaced"),
        ).toHaveLength(1);

        store.close();
        store = new SessionStore({ path: dbPath });
        expect(store.conversations.listMessages("s1")).toEqual(result.messages);
        expect(store.conversations.listMessageParts("s1")).toEqual(result.parts);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rolls back transcript replacement after an injected failure", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-replace-transcript-fail-"));
      const dbPath = join(dir, "store.db");
      let store = new SessionStore({ path: dbPath });
      try {
        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
        const message = store.conversations.createMessage({ id: "old-message", sessionId: "s1", role: "user" });
        store.conversations.upsertMessagePart({ id: "old-part", sessionId: "s1", messageId: message.id, type: "text", text: "old" });
        const storage = (store as any).storage;
        storage.deltaCheckpoint.markDirty("old-part", 3);

        const tx = createTransactions(store, {
          afterTranscriptReplacement: () => { throw new Error("injected transcript failure"); },
        });
        expect(() => tx.replaceTranscript({ sessionId: "s1", messages: [] }))
          .toThrow("injected transcript failure");
        expect(store.conversations.listMessages("s1").map(({ id }) => id)).toEqual(["old-message"]);
        expect(store.conversations.listMessageParts("s1").map(({ id }) => id)).toEqual(["old-part"]);
        expect(storage.mutations.messages.size).toBe(0);
        expect(storage.mutations.parts.size).toBe(0);
        expect(storage.mutations.deletedMessages.size).toBe(0);
        expect(storage.mutations.deletedParts.size).toBe(0);
        expect(storage.deltaCheckpoint.dirtyPartIds()).toEqual(["old-part"]);

        store.sessions.update("s1", { title: "unrelated save" });
        expect(store.conversations.listMessages("s1").map(({ id }) => id)).toEqual(["old-message"]);
        expect(store.conversations.listMessageParts("s1").map(({ id }) => id)).toEqual(["old-part"]);

        store.close();
        store = new SessionStore({ path: dbPath });
        expect(store.conversations.listMessages("s1").map(({ id }) => id)).toEqual(["old-message"]);
        expect(store.conversations.listMessageParts("s1").map(({ id }) => id)).toEqual(["old-part"]);
        expect(store.sessions.get("s1")!.title).toBe("unrelated save");
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each([false, true])("replaces transcript and admits a prompt with createRun=%s", (createRun) => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-replace-and-admit-"));
      const store = new SessionStore({ path: join(dir, "store.db") });
      try {
        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
        store.conversations.createMessage({ id: "old-message", sessionId: "s1", role: "user" });
        const result = createTransactions(store).replaceTranscriptAndAdmitPrompt({
          transcript: { sessionId: "s1", messages: [{ role: "assistant", parts: [{ type: "text", text: "summary" }] }] },
          admission: { prompt: { id: "replacement-input", sessionId: "s1", content: "continue" }, run: { id: "replacement-run" } },
          createRun,
        });

        expect(result.transcript.messages).toHaveLength(1);
        expect(result.input.id).toBe("replacement-input");
        expect(result.run?.id).toBe(createRun ? "replacement-run" : undefined);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rolls back replacement and admission when run creation fails", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-replace-admit-fail-"));
      const dbPath = join(dir, "store.db");
      let store = new SessionStore({ path: dbPath });
      try {
        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
        store.conversations.createMessage({ id: "old-message", sessionId: "s1", role: "user" });
        const tx = createTransactions(store, {
          beforeRunCreation: () => { throw new Error("injected run failure"); },
        });

        expect(() => tx.replaceTranscriptAndAdmitPrompt({
          transcript: { sessionId: "s1", messages: [] },
          admission: { prompt: { id: "replacement-input", sessionId: "s1", content: "continue" } },
          createRun: true,
        })).toThrow("injected run failure");
        expect(store.conversations.listMessages("s1").map(({ id }) => id)).toEqual(["old-message"]);
        expect(store.conversations.getInput("replacement-input")).toBeUndefined();

        store.close();
        store = new SessionStore({ path: dbPath });
        expect(store.conversations.listMessages("s1").map(({ id }) => id)).toEqual(["old-message"]);
        expect(store.conversations.getInput("replacement-input")).toBeUndefined();
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("edits the latest prompt by removing its dependent graph and keeping earlier history", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-edit-latest-"));
      const store = new SessionStore({ path: join(dir, "store.db") });
      try {
        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
        createReadyAttachment(store, "asset-old", 10);
        const keepInput = store.conversationTransactions.admitPrompt({ id: "keep-input", sessionId: "s1", content: "keep" });
        const keepMessage = store.conversations.createMessage({ id: "keep-message", sessionId: "s1", role: "user", inputId: keepInput.id });
        const oldInput = store.conversationTransactions.admitPrompt({ id: "old-input", sessionId: "s1", content: "old", attachments: [{ assetId: "asset-old" }] });
        const oldRun = store.runs.createRun({ id: "old-run", sessionId: "s1", inputId: oldInput.id });
        store.runs.createRunAttempt({ id: "old-attempt", runId: oldRun.id });
        const oldMessage = store.conversations.createMessage({ id: "old-message", sessionId: "s1", role: "user", inputId: oldInput.id, runId: oldRun.id });
        store.conversations.upsertMessagePart({ id: "old-part", sessionId: "s1", messageId: oldMessage.id, type: "text", text: "old" });

        const result = createTransactions(store).replaceLatestPromptWithAdmission({
          sessionId: "s1",
          sourceMessageId: oldMessage.id,
          admission: { prompt: { id: "new-input", sessionId: "s1", content: "new" } },
          createRun: false,
        });

        expect(result.transcript.messages.map(({ id }) => id)).toEqual([keepMessage.id]);
        expect(store.conversations.getInput("keep-input")).toBeDefined();
        expect(store.conversations.getInput("old-input")).toBeUndefined();
        expect(store.runs.getRun("old-run")).toBeUndefined();
        expect(store.runs.getRunAttempt("old-attempt")).toBeUndefined();
        expect(store.conversations.listInputAttachments("old-input")).toEqual([]);
        expect(store.conversations.listMessageParts("s1")).toEqual([]);
        expect(result.input.id).toBe("new-input");
        expect(
          store.conversations.listEvents({ sessionId: "s1" })
            .filter(({ type }) => type === "session.transcript.replaced"),
        ).toHaveLength(1);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("edits the latest prompt and creates its owning run", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-edit-latest-run-"));
      const store = new SessionStore({ path: join(dir, "store.db") });
      try {
        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
        const sourceInput = store.conversationTransactions.admitPrompt({ id: "source-input", sessionId: "s1", content: "source" });
        const sourceMessage = store.conversations.createMessage({ id: "source-message", sessionId: "s1", role: "user", inputId: sourceInput.id });

        const result = createTransactions(store).replaceLatestPromptWithAdmission({
          sessionId: "s1",
          sourceMessageId: sourceMessage.id,
          admission: {
            prompt: { id: "replacement-input", sessionId: "s1", content: "replacement" },
            run: { id: "replacement-run" },
          },
          createRun: true,
        });

        expect(result.input.id).toBe("replacement-input");
        expect(result.run).toEqual(expect.objectContaining({
          id: "replacement-run",
          sessionId: "s1",
          inputId: "replacement-input",
        }));
        expect(store.runs.findOwningRunByInput("replacement-input")?.id).toBe("replacement-run");
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("restores the entire removed graph when edited prompt run creation fails", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-edit-latest-run-fail-"));
      const dbPath = join(dir, "store.db");
      let store = new SessionStore({ path: dbPath });
      try {
        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
        createReadyAttachment(store, "source-asset", 10);
        const sourceInput = store.conversationTransactions.admitPrompt({
          id: "source-input",
          sessionId: "s1",
          content: "source",
          attachments: [{ assetId: "source-asset" }],
        });
        const sourceRun = store.runs.createRun({ id: "source-run", sessionId: "s1", inputId: sourceInput.id });
        const sourceAttempt = store.runs.createRunAttempt({ id: "source-attempt", runId: sourceRun.id });
        const sourceMessage = store.conversations.createMessage({
          id: "source-message",
          sessionId: "s1",
          role: "user",
          inputId: sourceInput.id,
          runId: sourceRun.id,
        });
        store.conversations.upsertMessagePart({
          id: "source-part",
          sessionId: "s1",
          messageId: sourceMessage.id,
          type: "text",
          text: "source",
        });
        const sourceReferences = store.conversations.listInputAttachments(sourceInput.id);
        const sourceMessages = store.conversations.listMessages("s1");
        const sourceParts = store.conversations.listMessageParts("s1");
        const tx = createTransactions(store, {
          beforeRunCreation: () => { throw new Error("injected edit run failure"); },
        });

        expect(() => tx.replaceLatestPromptWithAdmission({
          sessionId: "s1",
          sourceMessageId: sourceMessage.id,
          admission: {
            prompt: { id: "replacement-input", sessionId: "s1", content: "replacement" },
            run: { id: "replacement-run" },
          },
          createRun: true,
        })).toThrow("injected edit run failure");

        expect(store.conversations.getInput(sourceInput.id)).toEqual(sourceInput);
        expect(store.conversations.listInputAttachments(sourceInput.id)).toEqual(sourceReferences);
        expect(store.runs.getRun(sourceRun.id)).toEqual(sourceRun);
        expect(store.runs.getRunAttempt(sourceAttempt.id)).toEqual(sourceAttempt);
        expect(store.conversations.listMessages("s1")).toEqual(sourceMessages);
        expect(store.conversations.listMessageParts("s1")).toEqual(sourceParts);
        expect(store.conversations.getInput("replacement-input")).toBeUndefined();
        expect(store.runs.getRun("replacement-run")).toBeUndefined();

        store.close();
        store = new SessionStore({ path: dbPath });
        expect(store.conversations.getInput(sourceInput.id)).toEqual(sourceInput);
        expect(store.conversations.listInputAttachments(sourceInput.id)).toEqual(sourceReferences);
        expect(store.runs.getRun(sourceRun.id)).toEqual(sourceRun);
        expect(store.runs.getRunAttempt(sourceAttempt.id)).toEqual(sourceAttempt);
        expect(store.conversations.listMessages("s1")).toEqual(sourceMessages);
        expect(store.conversations.listMessageParts("s1")).toEqual(sourceParts);
        expect(store.conversations.getInput("replacement-input")).toBeUndefined();
        expect(store.runs.getRun("replacement-run")).toBeUndefined();
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("validates edit source ownership and rolls back deletion when admission fails", () => {
      const dir = mkdtempSync(join(tmpdir(), "ohs-edit-latest-fail-"));
      const store = new SessionStore({ path: join(dir, "store.db") });
      try {
        store.sessions.create({ id: "s1", cwd: dir, model: "m" });
        store.sessions.create({ id: "s2", cwd: dir, model: "m" });
        const sourceInput = store.conversationTransactions.admitPrompt({ id: "source-input", sessionId: "s1", content: "source" });
        const sourceMessage = store.conversations.createMessage({ id: "source-message", sessionId: "s1", role: "user", inputId: sourceInput.id });
        const otherMessage = store.conversations.createMessage({ id: "other-message", sessionId: "s2", role: "user" });
        const tx = createTransactions(store);

        expect(() => tx.replaceLatestPromptWithAdmission({
          sessionId: "s1",
          sourceMessageId: otherMessage.id,
          admission: { prompt: { sessionId: "s1", content: "new" } },
          createRun: false,
        })).toThrow("The edit source must be a user message in the session");

        expect(() => tx.replaceLatestPromptWithAdmission({
          sessionId: "s1",
          sourceMessageId: sourceMessage.id,
          admission: { prompt: { sessionId: "s1", content: "new", attachments: [{ assetId: "missing" }] } },
          createRun: false,
        })).toThrow(/missing/i);
        expect(store.conversations.getInput("source-input")).toBeDefined();
        expect(store.conversations.listMessages("s1").map(({ id }) => id)).toEqual(["source-message"]);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    describe("forkSessionWithHistory", () => {
      function seedForkSource(store: SessionStore, dir: string) {
        store.sessions.create({ id: "source", cwd: dir, model: "model-a", title: "source" });
        createReadyAttachment(store, "asset-a", 10);
        createReadyAttachment(store, "asset-b", 20);
        const input = store.conversationTransactions.admitPrompt({
          id: "source-input",
          sessionId: "source",
          content: "source prompt",
          attachments: [
            { assetId: "asset-b", intent: "ocr", displayName: "B" },
            { assetId: "asset-a", intent: "vision", displayName: "A" },
          ],
          metadata: { input: true },
        });
        const run = store.runs.createRun({ id: "source-run", sessionId: "source", inputId: input.id });
        const first = store.conversations.createMessage({
          id: "first-message",
          sessionId: "source",
          role: "user",
          inputId: input.id,
          runId: run.id,
          metadata: { order: 1 },
        });
        store.conversations.upsertMessagePart({
          id: "first-part",
          sessionId: "source",
          messageId: first.id,
          type: "tool",
          status: "failed",
          text: "full fields",
          toolUseId: "tool-use",
          toolName: "reader",
          input: { path: "x" },
          output: { code: 1 },
          isError: true,
          assetId: "asset-b",
          intent: "ocr",
          displayName: "B",
          mediaType: "text/plain",
          sizeBytes: 20,
          kind: "document_extract",
          representationId: "representation",
          processor: "extractor",
          transformationError: "partial",
          metadata: { inputAttachmentId: input.attachments[0]!.id, extra: true },
        });
        const second = store.conversations.createMessage({
          id: "second-message",
          sessionId: "source",
          role: "assistant",
          inputId: input.id,
          runId: run.id,
          metadata: { order: 2 },
        });
        store.conversations.upsertMessagePart({ id: "second-part", sessionId: "source", messageId: second.id, type: "text", text: "second" });
        const third = store.conversations.createMessage({ id: "third-message", sessionId: "source", role: "system", metadata: { order: 3 } });
        return { input, first, second, third };
      }

      it("copies complete history with deduplicated inputs, attachment positions, all part fields, and requested session fields", () => {
        const dir = mkdtempSync(join(tmpdir(), "ohs-fork-full-"));
        const store = new SessionStore({ path: join(dir, "store.db") });
        try {
          const source = seedForkSource(store, dir);
          const child = createTransactions(store).forkSessionWithHistory({
            sourceSessionId: "source",
            session: { id: "child", cwd: dir, model: "model-b", agent: "agent-b", title: "child title", metadata: { child: true } },
          });

          expect(child).toEqual(expect.objectContaining({
            id: "child",
            parentId: "source",
            cwd: store.sessions.get("source")!.cwd,
            model: "model-b",
            agent: "agent-b",
            title: "child title",
            metadata: { child: true },
          }));
          const inputs = store.conversations.listInputs("child");
          expect(inputs).toHaveLength(1);
          expect(inputs[0]!.attachments.map(({ assetId, seq, displayName }) => ({ assetId, seq, displayName }))).toEqual([
            { assetId: "asset-b", seq: 0, displayName: "B" },
            { assetId: "asset-a", seq: 1, displayName: "A" },
          ]);
          const messages = store.conversations.listMessages("child");
          expect(messages).toHaveLength(3);
          expect(messages.slice(0, 2).map(({ inputId }) => inputId)).toEqual([inputs[0]!.id, inputs[0]!.id]);
          expect(messages.every(({ runId }) => runId === undefined)).toBe(true);
          expect(store.runs.listRuns("child")).toEqual([]);
          const part = store.conversations.listMessageParts("child")[0]!;
          expect(part).toEqual(expect.objectContaining({
            type: "tool", status: "failed", text: "full fields", toolUseId: "tool-use", toolName: "reader",
            input: { path: "x" }, output: { code: 1 }, isError: true, assetId: "asset-b", intent: "ocr",
            displayName: "B", mediaType: "text/plain", sizeBytes: 20, kind: "document_extract",
            representationId: "representation", processor: "extractor", transformationError: "partial",
            metadata: { inputAttachmentId: inputs[0]!.attachments[0]!.id, extra: true },
          }));
          expect(part.metadata.inputAttachmentId).not.toBe(source.input.attachments[0]!.id);
        } finally {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it("honors before and after boundaries and rejects unknown fork points", () => {
        const dir = mkdtempSync(join(tmpdir(), "ohs-fork-boundary-"));
        const store = new SessionStore({ path: join(dir, "store.db") });
        try {
          const source = seedForkSource(store, dir);
          const tx = createTransactions(store);
          tx.forkSessionWithHistory({ sourceSessionId: "source", beforeMessageId: source.second.id, session: { id: "before", cwd: dir, model: "m" } });
          tx.forkSessionWithHistory({ sourceSessionId: "source", afterMessageId: source.second.id, session: { id: "after", cwd: dir, model: "m" } });
          expect(store.conversations.listMessages("before").map(({ metadata }) => metadata.order)).toEqual([1]);
          expect(store.conversations.listMessages("after").map(({ metadata }) => metadata.order)).toEqual([1, 2]);
          expect(() => tx.forkSessionWithHistory({ sourceSessionId: "source", beforeMessageId: "missing", session: { id: "bad-before", cwd: dir, model: "m" } })).toThrow("Fork point not found");
          expect(() => tx.forkSessionWithHistory({ sourceSessionId: "source", afterMessageId: "missing", session: { id: "bad-after", cwd: dir, model: "m" } })).toThrow("Fork point not found");
          expect(store.sessions.get("bad-before")).toBeUndefined();
          expect(store.sessions.get("bad-after")).toBeUndefined();
        } finally {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it.each([
        "afterForkSessionCreated",
        "afterForkInputsCopied",
        "afterForkMessagesCopied",
        "afterForkPartsCopied",
      ] as const)("rolls back memory and disk when %s fails", (failurePoint) => {
        const dir = mkdtempSync(join(tmpdir(), `ohs-fork-fail-${failurePoint}-`));
        const dbPath = join(dir, "store.db");
        let store = new SessionStore({ path: dbPath });
        try {
          seedForkSource(store, dir);
          const before = {
            sessions: Object.keys((store as any).storage.state.sessions),
            inputs: Object.keys((store as any).storage.state.inputs),
            references: Object.keys((store as any).storage.state.inputAttachments),
            messages: Object.keys((store as any).storage.state.messages),
            parts: Object.keys((store as any).storage.state.parts),
          };
          const tx = createTransactions(store, {
            [failurePoint]: () => { throw new Error(`injected ${failurePoint}`); },
          });
          expect(() => tx.forkSessionWithHistory({
            sourceSessionId: "source",
            session: { id: "failed-child", cwd: dir, model: "m" },
          })).toThrow(`injected ${failurePoint}`);
          expect(store.sessions.get("failed-child")).toBeUndefined();
          expect({
            sessions: Object.keys((store as any).storage.state.sessions),
            inputs: Object.keys((store as any).storage.state.inputs),
            references: Object.keys((store as any).storage.state.inputAttachments),
            messages: Object.keys((store as any).storage.state.messages),
            parts: Object.keys((store as any).storage.state.parts),
          }).toEqual(before);

          store.close();
          store = new SessionStore({ path: dbPath });
          expect(store.sessions.get("failed-child")).toBeUndefined();
          expect({
            sessions: Object.keys((store as any).storage.state.sessions),
            inputs: Object.keys((store as any).storage.state.inputs),
            references: Object.keys((store as any).storage.state.inputAttachments),
            messages: Object.keys((store as any).storage.state.messages),
            parts: Object.keys((store as any).storage.state.parts),
          }).toEqual(before);
        } finally {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });

    describe("deleteSessionTree", () => {
      it("writes one durable global deletion event for the removed session tree", () => {
        const dir = mkdtempSync(join(tmpdir(), "ohs-delete-event-"));
        const sessionStore = new SessionStore({ path: join(dir, "store.db") });
        try {
          sessionStore.sessions.create({ id: "root", cwd: dir, model: "m" });
          sessionStore.sessions.create({ id: "child", parentId: "root", cwd: dir, model: "m" });
          const cursor = sessionStore.conversations.latestEventSeq();

          expect(createTransactions(sessionStore).deleteSessionTree("root")).toEqual(["root", "child"]);
          expect(sessionStore.conversations.listEvents({ afterSeq: cursor })).toMatchObject([
            { type: "session.deleted", payload: { sessionIds: ["root", "child"] } },
          ]);
        } finally {
          sessionStore.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });
      function seedDeleteFixture(store: SessionStore, dir: string) {
        createReadyAttachment(store, "tree-asset", 10);
        const ids = ["root", "child", "grandchild", "outside"];
        store.sessions.create({ id: "root", cwd: dir, model: "m" });
        store.sessions.create({ id: "child", parentId: "root", cwd: dir, model: "m" });
        store.sessions.create({ id: "grandchild", parentId: "child", cwd: dir, model: "m" });
        store.sessions.create({ id: "outside", cwd: dir, model: "m" });
        for (const id of ids) {
          const input = store.conversationTransactions.admitPrompt({
            id: `${id}-input`, sessionId: id, content: id,
            attachments: [{ assetId: "tree-asset" }],
          });
          const run = store.runs.createRun({ id: `${id}-run`, sessionId: id, inputId: input.id });
          store.runs.createRunAttempt({ id: `${id}-attempt`, runId: run.id });
          const message = store.conversations.createMessage({
            id: `${id}-message`, sessionId: id, role: "assistant", runId: run.id, inputId: input.id,
          });
          store.conversations.upsertMessagePart({
            id: `${id}-part`, sessionId: id, messageId: message.id, type: "text", text: id,
          });
          store.createSessionTask({
            id: `${id}-task`, sessionId: id, runId: run.id, type: "process",
            description: id, cwd: dir,
          });
          store.permissions.create({
            id: `${id}-permission`, sessionId: id, runId: run.id, toolName: "Write", payload: {},
          });
        }
      }

      function entityIds(store: SessionStore) {
        const state = (store as any).storage.state;
        return {
          sessions: Object.keys(state.sessions).sort(),
          inputs: Object.keys(state.inputs).sort(),
          references: Object.keys(state.inputAttachments).sort(),
          messages: Object.keys(state.messages).sort(),
          parts: Object.keys(state.parts).sort(),
          runs: Object.keys(state.runs).sort(),
          attempts: Object.keys(state.attempts).sort(),
          tasks: Object.keys(state.tasks).sort(),
          permissions: Object.keys(state.permissions).sort(),
          events: state.events.map(({ id }: { id: string }) => id).sort(),
        };
      }

      it("invalidates scheduled links to every deleted session in the same transaction", () => {
        const dir = mkdtempSync(join(tmpdir(), "ohs-delete-scheduled-links-"));
        const store = new SessionStore({ path: join(dir, "store.db") });
        try {
          store.sessions.create({ id: "root", cwd: dir, model: "m" });
          store.sessions.create({
            id: "child",
            parentId: "root",
            cwd: dir,
            model: "m",
          });
          store.sessions.create({ id: "outside", cwd: dir, model: "m" });
          store.schedules.createTask({
            id: "chat-task",
            name: "Chat task",
            prompt: "work",
            recurrence: "RRULE:FREQ=DAILY",
            recurrenceFormat: "rrule",
            timezone: "UTC",
            destination: "chat",
            sessionId: "child",
            nextRunAt: 100,
          });
          store.schedules.createTask({
            id: "standalone-task",
            name: "Standalone task",
            prompt: "work",
            recurrence: "RRULE:FREQ=DAILY",
            recurrenceFormat: "rrule",
            timezone: "UTC",
            destination: "standalone",
            projectPaths: [],
            createdFromSessionId: "root",
            nextRunAt: 100,
          });
          const deletedRun = store.schedules.createRun({
            id: "deleted-run",
            taskId: "standalone-task",
            cause: "manual",
            scheduledFor: 1,
          });
          const outsideRun = store.schedules.createRun({
            id: "outside-run",
            taskId: "standalone-task",
            cause: "manual",
            scheduledFor: 2,
          });
          store.schedules.updateRun(deletedRun.id, { sessionId: "root" });
          store.schedules.updateRun(outsideRun.id, { sessionId: "outside" });

          createTransactions(store).deleteSessionTree("root");

          expect(store.schedules.getTask("chat-task")).toMatchObject({
            status: "paused",
          });
          expect(
            store.schedules.getTask("chat-task")?.sessionId,
          ).toBeUndefined();
          expect(
            store.schedules.getTask("chat-task")?.nextRunAt,
          ).toBeUndefined();
          expect(
            store.schedules.getTask("standalone-task")?.createdFromSessionId,
          ).toBeUndefined();
          expect(
            store.schedules.getRun("deleted-run")?.sessionId,
          ).toBeUndefined();
          expect(store.schedules.getRun("outside-run")?.sessionId).toBe(
            "outside",
          );
        } finally {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it("deletes a three-level tree in DFS order while preserving outside state and pending mutation", () => {
        const dir = mkdtempSync(join(tmpdir(), "ohs-delete-tree-"));
        const dbPath = join(dir, "store.db");
        let store = new SessionStore({ path: dbPath });
        try {
          seedDeleteFixture(store, dir);
          const storage = (store as any).storage;
          storage.state.messages["outside-message"].metadata = { pending: true };
          storage.mutations.messages.add("outside-message");
          storage.deltaCheckpoint.markDirty("root-part", 4);
          storage.deltaCheckpoint.markDirty("outside-part", 7);
          let dirtyDuringCleanup: string[] = [];
          const tx = createTransactions(store, {
            afterDeleteMemory: () => { dirtyDuringCleanup = storage.deltaCheckpoint.dirtyPartIds(); },
          });

          expect(tx.deleteSessionTree("root")).toEqual(["root", "child", "grandchild"]);
          expect(dirtyDuringCleanup).toEqual(["outside-part"]);
          expect(entityIds(store)).toEqual({
            sessions: ["outside"], inputs: ["outside-input"],
            references: [expect.stringMatching(/.+/)], messages: ["outside-message"],
            parts: ["outside-part"], runs: ["outside-run"], attempts: ["outside-attempt"],
            tasks: ["outside-task"], permissions: ["outside-permission"],
            events: expect.any(Array),
          });
          expect(store.conversations.listEvents().some(({ sessionId }) => sessionId === "outside")).toBe(true);
          expect(store.conversations.listEvents().some(({ sessionId }) => ["root", "child", "grandchild"].includes(sessionId ?? ""))).toBe(false);
          expect(store.conversationTransactions.getSessionState("outside").messages[0]!.metadata).toEqual({ pending: true });

          store.close();
          store = new SessionStore({ path: dbPath });
          expect(store.sessions.get("root")).toBeUndefined();
          expect(store.sessions.get("child")).toBeUndefined();
          expect(store.sessions.get("grandchild")).toBeUndefined();
          expect(store.conversationTransactions.getSessionState("outside").messages[0]!.metadata).toEqual({ pending: true });
        } finally {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it.each(["sql", "memory"] as const)("rolls back all state and disk on %s failure", (kind) => {
        const dir = mkdtempSync(join(tmpdir(), `ohs-delete-tree-${kind}-`));
        const dbPath = join(dir, "store.db");
        let store = new SessionStore({ path: dbPath });
        try {
          seedDeleteFixture(store, dir);
          const storage = (store as any).storage;
          storage.deltaCheckpoint.markDirty("root-part", 4);
          const before = entityIds(store);
          if (kind === "sql") {
            storage.database.connection.exec(`
              CREATE TRIGGER fail_tree_message_delete BEFORE DELETE ON session_message
              WHEN OLD.session_id = 'root' BEGIN SELECT RAISE(ABORT, 'injected delete sql failure'); END;
            `);
          }
          const tx = createTransactions(store, kind === "memory" ? {
            duringDeleteMemory: () => { throw new Error("injected delete memory failure"); },
          } : undefined);
          expect(() => tx.deleteSessionTree("root")).toThrow(`injected delete ${kind} failure`);
          expect(entityIds(store)).toEqual(before);
          expect(storage.deltaCheckpoint.dirtyPartIds()).toEqual(["root-part"]);

          store.close();
          store = new SessionStore({ path: dbPath });
          expect(entityIds(store)).toEqual(before);
        } finally {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it("rejects deletion from inside another store transaction", () => {
        const dir = mkdtempSync(join(tmpdir(), "ohs-delete-tree-nested-"));
        const store = new SessionStore({ path: join(dir, "store.db") });
        try {
          store.sessions.create({ id: "root", cwd: dir, model: "m" });
          const tx = createTransactions(store);
          expect(() => store.transaction(() => tx.deleteSessionTree("root")))
            .toThrow("deleteSessionTree cannot be called inside a store transaction");
          expect(store.sessions.get("root")).toBeDefined();
        } finally {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });

    describe("recovery transactions", () => {
      it("settles only active attempts and interrupts only active tasks with defaults", () => {
        const dir = mkdtempSync(join(tmpdir(), "ohs-recovery-attempt-task-"));
        const store = new SessionStore({ path: join(dir, "store.db") });
        try {
          store.sessions.create({ id: "s1", cwd: dir, model: "m" });
          const run = store.runs.createRun({ id: "run", sessionId: "s1" });
          store.runs.createRunAttempt({ id: "pending-attempt", runId: run.id });
          const runningAttempt = store.runs.createRunAttempt({ id: "running-attempt", runId: run.id });
          store.runs.updateRunAttempt(runningAttempt.id, { status: "running" });
          const completedAttempt = store.runs.createRunAttempt({ id: "completed-attempt", runId: run.id });
          store.runs.updateRunAttempt(completedAttempt.id, { status: "completed" });
          store.createSessionTask({ id: "pending-task", sessionId: "s1", type: "process", status: "pending", description: "pending", cwd: dir });
          store.createSessionTask({ id: "running-task", sessionId: "s1", type: "process", description: "running", cwd: dir });
          store.createSessionTask({ id: "done-task", sessionId: "s1", type: "process", status: "completed", description: "done", cwd: dir });
          const tx = createTransactions(store);

          expect(tx.settleActiveRunAttempts(run.id, "cancelled", "stopped")).toBe(2);
          expect(store.runs.listRunAttempts(run.id).map(({ status }) => status)).toEqual(["cancelled", "cancelled", "completed"]);
          expect(store.runs.getRunAttempt("pending-attempt")).toMatchObject({ error: "stopped", errorKind: "interrupted" });
          expect(tx.interruptActiveSessionTasks()).toBe(2);
          expect(store.getSessionTask("pending-task")).toMatchObject({ status: "interrupted", error: "Daemon restarted before the task completed" });
          expect(store.getSessionTask("running-task")).toMatchObject({ status: "interrupted" });
          expect(store.getSessionTask("done-task")!.status).toBe("completed");
        } finally {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it("interrupts active runs, marks unknown tool outcomes, terminalizes orphans, and finalizes eligible closing sessions", () => {
        const dir = mkdtempSync(join(tmpdir(), "ohs-recovery-runs-"));
        const store = new SessionStore({ path: join(dir, "store.db") });
        try {
          store.sessions.create({ id: "active", cwd: dir, model: "m" });
          const input = store.conversationTransactions.admitPrompt({ id: "owned", sessionId: "active", content: "owned" });
          const run = store.runs.createRun({ id: "active-run", sessionId: "active", inputId: input.id });
          const attempt = store.runs.createRunAttempt({ id: "active-attempt", runId: run.id });
          store.runs.updateRunAttempt(attempt.id, { status: "running" });
          const message = store.conversations.createMessage({ id: "assistant", sessionId: "active", role: "assistant", runId: run.id });
          store.conversations.upsertMessagePart({ id: "text-part", sessionId: "active", messageId: message.id, type: "text", status: "running", text: "partial" });
          store.conversations.upsertMessagePart({ id: "tool-part", sessionId: "active", messageId: message.id, type: "tool", status: "running", toolUseId: "tool-use", toolName: "Write" });
          store.conversationTransactions.admitPrompt({ id: "orphan", sessionId: "active", delivery: "steer", content: "orphan", metadata: { traceId: "trace" } });
          store.sessions.create({ id: "idle-closing", cwd: dir, model: "m" });
          store.sessions.beginArchive("idle-closing");
          const tx = createTransactions(store);

          expect(tx.interruptActiveRuns()).toBe(1);
          expect(store.runs.getRun("active-run")).toMatchObject({ status: "interrupted", error: "Daemon restarted before the run completed" });
          expect(store.runs.getRunAttempt("active-attempt")).toMatchObject({ status: "cancelled", errorKind: "interrupted" });
          expect(store.conversations.listMessageParts("active")).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "text-part", status: "interrupted" }),
            expect.objectContaining({ id: "tool-part", status: "failed", metadata: expect.objectContaining({ outcome: "unknown", failureKind: "unknown_outcome" }) }),
          ]));
          expect(tx.terminalizeUnownedInputs()).toBe(1);
          expect(store.runs.findRunByInput("orphan")).toMatchObject({
            status: "interrupted",
            metadata: { traceId: "trace", recovery: expect.objectContaining({ kind: "orphan_input", delivery: "steer" }) },
          });
          store.sessions.create({ id: "busy-closing", cwd: dir, model: "m" });
          store.runs.createRun({ id: "busy-run", sessionId: "busy-closing" });
          store.sessions.beginArchive("busy-closing");
          expect(tx.finalizeClosingSessions()).toBe(2);
          expect(store.sessions.get("idle-closing")!.status).toBe("archived");
          expect(store.sessions.get("busy-closing")!.status).toBe("closing");
        } finally {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it("rolls back a failed recovery batch in memory and after reopen", () => {
        const dir = mkdtempSync(join(tmpdir(), "ohs-recovery-fail-"));
        const dbPath = join(dir, "store.db");
        let store = new SessionStore({ path: dbPath });
        try {
          store.sessions.create({ id: "s1", cwd: dir, model: "m" });
          store.createSessionTask({ id: "task-1", sessionId: "s1", type: "process", description: "one", cwd: dir });
          store.createSessionTask({ id: "task-2", sessionId: "s1", type: "process", description: "two", cwd: dir });
          const tx = createTransactions(store, { afterRecoveryMutation: () => { throw new Error("injected recovery failure"); } });
          expect(() => tx.interruptActiveSessionTasks()).toThrow("injected recovery failure");
          expect(store.listSessionTasks("s1").map(({ status }) => status)).toEqual(["running", "running"]);
          store.close();
          store = new SessionStore({ path: dbPath });
          expect(store.listSessionTasks("s1").map(({ status }) => status)).toEqual(["running", "running"]);
        } finally {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it("rolls back active run, attempt, and running parts when run recovery fails", () => {
        const dir = mkdtempSync(join(tmpdir(), "ohs-run-recovery-fail-"));
        const dbPath = join(dir, "store.db");
        let store = new SessionStore({ path: dbPath });
        try {
          store.sessions.create({ id: "s1", cwd: dir, model: "m" });
          const run = store.runs.createRun({ id: "run", sessionId: "s1" });
          store.runs.updateRun(run.id, { status: "running" });
          const attempt = store.runs.createRunAttempt({ id: "attempt", runId: run.id });
          store.runs.updateRunAttempt(attempt.id, { status: "running" });
          const message = store.conversations.createMessage({ id: "message", sessionId: "s1", role: "assistant", runId: run.id });
          store.conversations.upsertMessagePart({ id: "text-part", sessionId: "s1", messageId: message.id, type: "text", status: "running", text: "partial" });
          store.conversations.upsertMessagePart({
            id: "tool-part", sessionId: "s1", messageId: message.id, type: "tool",
            status: "running", toolUseId: "tool-use", toolName: "Write", metadata: { existing: true },
          });
          const tx = createTransactions(store, {
            afterRecoveryMutation: () => { throw new Error("injected run recovery failure"); },
          });

          expect(() => tx.interruptActiveRuns()).toThrow("injected run recovery failure");
          expect(store.runs.getRun("run")!.status).toBe("running");
          expect(store.runs.getRunAttempt("attempt")!.status).toBe("running");
          expect(store.conversations.listMessageParts("s1")).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "text-part", status: "running" }),
            expect.objectContaining({ id: "tool-part", status: "running", metadata: { existing: true } }),
          ]));
          expect(store.conversations.listMessageParts("s1").find(({ id }) => id === "tool-part")!.metadata)
            .not.toHaveProperty("failureKind");

          store.close();
          store = new SessionStore({ path: dbPath });
          expect(store.runs.getRun("run")!.status).toBe("running");
          expect(store.runs.getRunAttempt("attempt")!.status).toBe("running");
          expect(store.conversations.listMessageParts("s1")).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "text-part", status: "running" }),
            expect.objectContaining({ id: "tool-part", status: "running", metadata: { existing: true } }),
          ]));
          expect(store.conversations.listMessageParts("s1").find(({ id }) => id === "tool-part")!.metadata)
            .not.toHaveProperty("failureKind");
        } finally {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it("notifies task listeners only after outer commit, never on rollback, and once per batch task", () => {
        const dir = mkdtempSync(join(tmpdir(), "ohs-task-notify-"));
        const store = new SessionStore({ path: join(dir, "store.db") });
        try {
          store.sessions.create({ id: "s1", cwd: dir, model: "m" });
          store.createSessionTask({ id: "task-1", sessionId: "s1", type: "process", description: "one", cwd: dir });
          store.createSessionTask({ id: "task-2", sessionId: "s1", type: "process", description: "two", cwd: dir });
          const calls = { one: 0, two: 0 };
          (store as any).taskListeners.set("task-1", new Set([() => { calls.one += 1; }]));
          (store as any).taskListeners.set("task-2", new Set([() => { calls.two += 1; }]));

          expect(() => store.transaction(() => {
            store.updateSessionTask("task-1", { status: "failed" });
            expect(calls.one).toBe(0);
            throw new Error("rollback");
          })).toThrow("rollback");
          expect(calls.one).toBe(0);
          store.transaction(() => {
            store.transaction(() => store.updateSessionTask("task-1", { status: "completed" }));
            expect(calls.one).toBe(0);
          });
          expect(calls.one).toBe(1);
          expect(createTransactions(store).interruptActiveSessionTasks()).toBe(1);
          expect(calls).toEqual({ one: 1, two: 1 });
        } finally {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });

    describe("getSessionState", () => {
      it("rejects a missing session", () => {
        const dir = mkdtempSync(join(tmpdir(), "ohs-snapshot-missing-"));
        const store = new SessionStore({ path: join(dir, "store.db") });
        try {
          expect(() => createTransactions(store).getSessionState("missing"))
            .toThrow("Session not found: missing");
        } finally {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it("returns the complete canonical aggregate at one cursor as a deep clone without children", () => {
        const dir = mkdtempSync(join(tmpdir(), "ohs-snapshot-full-"));
        const store = new SessionStore({ path: join(dir, "store.db") });
        try {
          store.sessions.create({ id: "s1", cwd: dir, model: "m", metadata: { nested: { value: 1 } } });
          store.sessions.create({ id: "child", parentId: "s1", cwd: dir, model: "m" });
          const input = store.conversationTransactions.admitPrompt({ id: "input", sessionId: "s1", content: "prompt" });
          const run = store.runs.createRun({ id: "run", sessionId: "s1", inputId: input.id });
          store.runs.createRunAttempt({ id: "attempt", runId: run.id });
          const message = store.conversations.createMessage({ id: "message", sessionId: "s1", role: "user", inputId: input.id, runId: run.id });
          store.conversations.upsertMessagePart({ id: "part", sessionId: "s1", messageId: message.id, type: "text", text: "hello" });
          store.createSessionTask({ id: "task", sessionId: "s1", runId: run.id, type: "process", description: "task", cwd: dir });
          store.permissions.create({ id: "permission", sessionId: "s1", runId: run.id, toolName: "Read", payload: {} });
          const expectedCursor = store.conversations.latestEventSeq();

          const snapshot = createTransactions(store).getSessionState("s1");
          expect(snapshot.cursor).toBe(expectedCursor);
          expect(snapshot).toEqual(expect.objectContaining({
            session: expect.objectContaining({ id: "s1" }),
            inputs: [expect.objectContaining({ id: "input" })],
            messages: [expect.objectContaining({ id: "message" })],
            parts: [expect.objectContaining({ id: "part" })],
            runs: [expect.objectContaining({ id: "run" })],
            attempts: [expect.objectContaining({ id: "attempt" })],
            tasks: [expect.objectContaining({ id: "task" })],
            permissions: [expect.objectContaining({ id: "permission" })],
          }));
          expect(snapshot).not.toHaveProperty("children");

          (snapshot.session.metadata.nested as { value: number }).value = 99;
          snapshot.messages[0]!.metadata.changed = true;
          expect(store.sessions.get("s1")!.metadata).toEqual({ nested: { value: 1 } });
          expect(store.conversations.listMessages("s1")[0]!.metadata).toEqual({});
        } finally {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it("composes a snapshot exclusively through narrow query collaborators", () => {
        const session = { id: "s1", cwd: "/repo", title: "", model: "m", status: "idle", metadata: {}, createdAt: 1, updatedAt: 1 };
        const run = { id: "run", sessionId: "s1", status: "completed", metadata: {}, createdAt: 2, updatedAt: 2 };
        const attempt = { id: "attempt", runId: "run", sequence: 1, status: "completed", createdAt: 3, updatedAt: 3 };
        const task = { id: "task", sessionId: "s1", type: "process", status: "completed", description: "task", cwd: "/repo", metadata: {}, createdAt: 4, updatedAt: 4 };
        const permission = { id: "permission", sessionId: "s1", toolName: "Read", payload: {}, status: "approved", createdAt: 5, updatedAt: 5 };
        const storage = {
          get state(): never { throw new Error("snapshot accessed storage state"); },
        };
        const tx = new ConversationTransactions({
          storage,
          sessions: { get: () => session },
          conversations: {
            latestEventSeq: () => 17,
            listInputs: () => [], listMessages: () => [], listMessageParts: () => [],
          },
          runs: {
            listRuns: () => [run], listRunAttempts: () => [attempt], listSessionTasks: () => [task],
          },
          permissions: { list: () => [permission] },
        } as any);

        expect(tx.getSessionState("s1")).toEqual({
          cursor: 17, session, inputs: [], messages: [], parts: [],
          runs: [run], attempts: [attempt], tasks: [task], permissions: [permission],
        });
      });
    });
  });
});
