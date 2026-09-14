import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { SessionStore, type SessionStoreOptions } from "../store.js";
import { createDurableEventRegistry } from "../event-registry.js";

const fixtureEventRegistry = createDurableEventRegistry([
  {
    type: "daemon.heartbeat",
    currentVersion: 1,
    scope: "global",
    validate: () => undefined,
  },
  {
    type: "daemon.legacy",
    currentVersion: 1,
    scope: "global",
    validate: () => undefined,
  },
  {
    type: "daemon.current",
    currentVersion: 1,
    scope: "global",
    validate: () => undefined,
  },
  {
    type: "daemon.after-restart",
    currentVersion: 1,
    scope: "session",
    validate: () => undefined,
  },
]);

function withStore(
  test: (store: SessionStore, path: string) => void,
  options: Omit<SessionStoreOptions, "path"> = {},
): void {
  const dir = mkdtempSync(join(tmpdir(), "ohs-session-runtime-"));
  const path = join(dir, "store.db");
  const store = new SessionStore({ path, ...options });
  try {
    test(store, path);
  } finally {
    store.close();
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}

function createReadyAttachment(
  store: SessionStore,
  id: string,
  sizeBytes = 100,
): void {
  store.createImportingAttachment({
    id,
    displayName: `${id}.png`,
    declaredMediaType: "image/png",
    stagingName: `${id}.part`,
    createdAt: 10,
  });
  store.markAttachmentReady(id, {
    sha256: "a".repeat(64),
    sizeBytes,
    mediaType: "image/png",
    updatedAt: 11,
  });
}

describe("SessionStore", () => {
  it("persists structured plugin input items and failed runs across disk reopen, rejecting legacy input rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-structured-input-"));
    const path = join(directory, "store.db");
    try {
      const store = new SessionStore({ path });
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const admitted = store.admitPrompt({
        id: "i1",
        sessionId: "s1",
        delivery: "queue",
        content: "caller content must not win",
        items: [
          { type: "text", text: "use " },
          { type: "skill", name: "review", path: "/repo/review/SKILL.md" },
          { type: "text", text: " " },
          { type: "capability", kind: "plugin", pluginId: "dev.quality", displayName: "Quality" },
          { type: "text", text: " " },
          { type: "capability", kind: "plugin_agent", pluginId: "dev.quality", agentId: "dev.quality:reviewer", displayName: "Reviewer" },
        ],
        metadata: { pluginId: "dev.quality" },
      });

      expect(admitted.items).toEqual([
        { type: "text", text: "use " },
        { type: "skill", name: "review", path: "/repo/review/SKILL.md" },
        { type: "text", text: " " },
        { type: "capability", kind: "plugin", pluginId: "dev.quality", displayName: "Quality" },
        { type: "text", text: " " },
        { type: "capability", kind: "plugin_agent", pluginId: "dev.quality", agentId: "dev.quality:reviewer", displayName: "Reviewer" },
      ]);
      expect(admitted.content).toBe("use $review @Quality @Reviewer");
      store.createRun({ id: "r1", sessionId: "s1", inputId: admitted.id, metadata: { pluginId: "dev.quality" } });
      store.updateRun("r1", { status: "failed", error: "Plugin tool permission denied" });
      store.close();

      const reloaded = new SessionStore({ path });
      expect(reloaded.getInput("i1")).toMatchObject({
        items: admitted.items,
        content: "use $review @Quality @Reviewer",
        metadata: { pluginId: "dev.quality" },
      });
      expect(reloaded.getRun("r1")).toMatchObject({
        inputId: "i1", status: "failed", error: "Plugin tool permission denied",
        metadata: { pluginId: "dev.quality" },
      });
      reloaded.close();

      const database = new Database(path);
      database.prepare("UPDATE session_input SET items_json = NULL WHERE id = ?").run("i1");
      database.close();
      expect(() => new SessionStore({ path })).toThrowError(
        /legacy_session_input_unsupported/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a format 1 database before running new migrations", () => {
    const root = mkdtempSync(join(tmpdir(), "ohs-format-1-"));
    const path = join(root, "store.db");
    try {
      const legacy = new Database(path);
      legacy.exec(`
        CREATE TABLE application_storage_format (
          id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
          version INTEGER NOT NULL
        );
        INSERT INTO application_storage_format (id, version) VALUES (1, 1);
      `);
      legacy.close();
      expect(() => new SessionStore({ path })).toThrow(
        /format 1.*move or delete/i,
      );
    } finally {
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  it("creates a format 2 database with input attachment and typed part columns", () => {
    withStore((_store, path) => {
      const database = new Database(path, { readonly: true });
      try {
        expect(
          database
            .prepare("SELECT version FROM application_storage_format WHERE id = 1")
            .get(),
        ).toEqual({ version: 2 });

        const refIndexes = database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_input_attachment'",
          )
          .all()
          .map((row) => (row as { name: string }).name);
        expect(refIndexes).toEqual(
          expect.arrayContaining([
            "session_input_attachment_input_seq_idx",
            "session_input_attachment_asset_idx",
            "session_input_attachment_session_idx",
          ]),
        );

        const partColumns = database
          .prepare("PRAGMA table_info(session_message_part)")
          .all()
          .map((row) => (row as { name: string }).name);
        expect(partColumns).toEqual(
          expect.arrayContaining([
            "asset_id",
            "attachment_intent",
            "display_name",
            "media_type",
            "size_bytes",
            "transformation_kind",
            "representation_id",
            "processor",
            "transformation_error",
          ]),
        );
      } finally {
        database.close();
      }
    });
  });

  it("persists and reloads typed attachment and transformation parts", () => {
    withStore((store, path) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const message = store.createMessage({
        id: "m1",
        sessionId: "s1",
        role: "user",
      });
      store.upsertMessagePart({
        id: "attachment-part",
        sessionId: "s1",
        messageId: message.id,
        type: "attachment",
        status: "completed",
        assetId: "att-1",
        intent: "vision",
        displayName: "screen.png",
        mediaType: "image/png",
        sizeBytes: 42,
        metadata: { inputAttachmentId: "ref-1" },
      });
      store.upsertMessagePart({
        id: "transformation-part",
        sessionId: "s1",
        messageId: message.id,
        type: "transformation",
        status: "completed",
        assetId: "att-1",
        kind: "document_extract",
        representationId: "rep-1",
        processor: "fixture-processor",
        transformationError: "none",
      });

      store.close();
      const reloaded = new SessionStore({ path });
      expect(reloaded.listMessageParts("s1")).toEqual([
        expect.objectContaining({
          id: "attachment-part",
          type: "attachment",
          assetId: "att-1",
          intent: "vision",
          displayName: "screen.png",
          mediaType: "image/png",
          sizeBytes: 42,
          metadata: { inputAttachmentId: "ref-1" },
        }),
        expect.objectContaining({
          id: "transformation-part",
          type: "transformation",
          assetId: "att-1",
          kind: "document_extract",
          representationId: "rep-1",
          processor: "fixture-processor",
          transformationError: "none",
        }),
      ]);
      reloaded.close();
    });
  });

  it("creates replay runs for the original input without copying its references", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      createReadyAttachment(store, "asset-replay", 42);
      const input = store.admitPrompt({
        id: "input-replay",
        sessionId: "s1",
        content: "inspect",
        attachments: [{ assetId: "asset-replay", intent: "vision" }],
      });
      store.createRun({ id: "run-original", sessionId: "s1", inputId: input.id });

      const replay = store.createReplayRun(input.id, {
        id: "run-replay",
        metadata: { recovery: { sourceRunId: "run-original" } },
      });

      expect(replay.inputId).toBe(input.id);
      expect(store.listRunsByInput(input.id).map((run) => run.id)).toEqual([
        "run-original",
        "run-replay",
      ]);
      expect(store.getInput(input.id)?.attachments).toEqual(input.attachments);
      expect(store.listInputAttachments(input.id)).toHaveLength(1);
    });
  });

  it("atomically replaces the latest prompt admission and its references", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      createReadyAttachment(store, "asset-old", 40);
      createReadyAttachment(store, "asset-new", 60);
      const oldInput = store.admitPrompt({
        id: "input-old",
        sessionId: "s1",
        content: "old",
        attachments: [{ assetId: "asset-old", intent: "vision" }],
      });
      store.createRun({ id: "run-old", sessionId: "s1", inputId: oldInput.id });
      const oldMessage = store.createMessage({
        id: "message-old",
        sessionId: "s1",
        role: "user",
        runId: "run-old",
        inputId: oldInput.id,
      });
      store.upsertMessagePart({
        id: "part-old",
        sessionId: "s1",
        messageId: oldMessage.id,
        type: "attachment",
        status: "completed",
        assetId: "asset-old",
        intent: "vision",
        displayName: "asset-old.png",
        mediaType: "image/png",
        sizeBytes: 40,
      });

      expect(() => store.replaceLatestPromptWithAdmission({
        sessionId: "s1",
        sourceMessageId: oldMessage.id,
        admission: {
          prompt: {
            id: "input-new",
            sessionId: "s1",
            content: "new",
            attachments: [{ assetId: "missing-asset" }],
          },
          run: { id: "run-new" },
        },
        createRun: true,
      })).toThrow(/missing-asset/i);
      expect(store.getInput(oldInput.id)).toEqual(oldInput);
      expect(store.getRun("run-old")).toBeDefined();
      expect(store.listMessages("s1").map((message) => message.id)).toEqual([oldMessage.id]);
      expect(store.listInputAttachments(oldInput.id)).toHaveLength(1);

      const replaced = store.replaceLatestPromptWithAdmission({
        sessionId: "s1",
        sourceMessageId: oldMessage.id,
        admission: {
          prompt: {
            id: "input-new",
            sessionId: "s1",
            content: "new",
            attachments: [{ assetId: "asset-new", intent: "ocr" }],
          },
          run: { id: "run-new" },
        },
        createRun: true,
      });

      expect(replaced.input.id).toBe("input-new");
      expect(replaced.run?.id).toBe("run-new");
      expect(store.getInput(oldInput.id)).toBeUndefined();
      expect(store.getRun("run-old")).toBeUndefined();
      expect(store.listMessages("s1")).toEqual([]);
      expect(store.listMessageParts("s1")).toEqual([]);
      expect(store.listInputAttachments(oldInput.id)).toEqual([]);
      expect(replaced.input.attachments).toEqual([
        expect.objectContaining({ assetId: "asset-new", intent: "ocr" }),
      ]);
    });
  });

  it("forks history with new ids, shared assets, and branch-local references", () => {
    withStore((store) => {
      const parent = store.createSession({
        id: "parent",
        cwd: process.cwd(),
        model: "m",
      });
      createReadyAttachment(store, "asset-shared", 42);
      const parentInput = store.admitPrompt({
        id: "parent-input",
        sessionId: parent.id,
        content: "inspect",
        attachments: [{ assetId: "asset-shared", intent: "vision" }],
      });
      const parentMessage = store.createMessage({
        id: "parent-message",
        sessionId: parent.id,
        role: "user",
        inputId: parentInput.id,
      });
      const parentPart = store.upsertMessagePart({
        id: "parent-part",
        sessionId: parent.id,
        messageId: parentMessage.id,
        type: "attachment",
        status: "completed",
        assetId: "asset-shared",
        intent: "vision",
        displayName: "asset-shared.png",
        mediaType: "image/png",
        sizeBytes: 42,
        metadata: { inputAttachmentId: parentInput.attachments[0]!.id },
      });

      const child = store.forkSessionWithHistory({
        sourceSessionId: parent.id,
        session: {
          id: "child",
          cwd: parent.cwd,
          model: parent.model,
          title: "child",
          metadata: {},
        },
      });
      const childMessage = store.listMessages(child.id)[0]!;
      const childInput = store.getInput(childMessage.inputId!)!;
      const childPart = store.listMessageParts(child.id)[0]!;

      expect(child.id).not.toBe(parent.id);
      expect(childInput.id).not.toBe(parentInput.id);
      expect(childInput.attachments[0]!.id).not.toBe(parentInput.attachments[0]!.id);
      expect(childMessage.id).not.toBe(parentMessage.id);
      expect(childPart.id).not.toBe(parentPart.id);
      expect(childInput.attachments[0]!.assetId).toBe("asset-shared");
      expect(childPart.assetId).toBe("asset-shared");

      store.deleteSessionTree(child.id);
      expect(store.listInputAttachments(parentInput.id)).toEqual(parentInput.attachments);
      expect(store.countInputAttachmentReferences("asset-shared")).toBe(1);
    });
  });

  it("copies model switch presentation messages only when they are inside the fork boundary", () => {
    withStore((store) => {
      const parent = store.createSession({
        id: "model-switch-parent",
        cwd: process.cwd(),
        model: "model-b",
      });
      const presentation = store.createMessage({
        id: "model-switch-message",
        sessionId: parent.id,
        role: "system",
        metadata: {
          presentation: {
            kind: "model_switch",
            fromModel: "model-a",
            toModel: "model-b",
          },
        },
      });
      store.upsertMessagePart({
        id: "model-switch-part",
        sessionId: parent.id,
        messageId: presentation.id,
        type: "text",
        status: "completed",
        text: "模型已切换 model-a → model-b",
      });
      const following = store.createMessage({
        id: "following-message",
        sessionId: parent.id,
        role: "assistant",
      });

      const after = store.forkSessionWithHistory({
        sourceSessionId: parent.id,
        afterMessageId: following.id,
        session: {
          id: "fork-after-switch",
          cwd: parent.cwd,
          model: parent.model,
          metadata: {},
        },
      });
      const before = store.forkSessionWithHistory({
        sourceSessionId: parent.id,
        beforeMessageId: presentation.id,
        session: {
          id: "fork-before-switch",
          cwd: parent.cwd,
          model: "model-a",
          metadata: {},
        },
      });

      expect(
        store.listMessages(after.id).some((message) =>
          (message.metadata.presentation as { kind?: string } | undefined)?.kind ===
          "model_switch"
        )
      ).toBe(true);
      expect(store.listMessageParts(after.id)).toEqual([
        expect.objectContaining({ text: "模型已切换 model-a → model-b" }),
      ]);
      expect(store.listMessages(before.id)).toEqual([]);
    });
  });

  it("allows one input to own multiple runs", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const input = store.admitPrompt({
        id: "i1",
        sessionId: "s1",
        content: "retry",
      });
      expect(
        store.createRun({ id: "r1", sessionId: "s1", inputId: input.id }),
      ).toMatchObject({ id: "r1" });
      expect(
        store.createRun({ id: "r2", sessionId: "s1", inputId: input.id }),
      ).toMatchObject({ id: "r2" });
    });
  });

  it("persists ordered attachment snapshots and restores them in one input", () => {
    withStore((store, path) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      createReadyAttachment(store, "asset-a", 40);
      createReadyAttachment(store, "asset-b", 60);

      const admitted = store.admitPrompt({
        id: "with-files",
        sessionId: "s1",
        content: "compare",
        attachments: [
          { assetId: "asset-b", intent: "ocr", displayName: "B renamed" },
          { assetId: "asset-a" },
        ],
      });
      expect(admitted.attachments).toEqual([
        expect.objectContaining({
          inputId: "with-files",
          assetId: "asset-b",
          seq: 0,
          intent: "ocr",
          displayName: "B renamed",
          mediaType: "image/png",
          sizeBytes: 60,
        }),
        expect.objectContaining({
          inputId: "with-files",
          assetId: "asset-a",
          seq: 1,
          intent: "auto",
          displayName: "asset-a.png",
          mediaType: "image/png",
          sizeBytes: 40,
        }),
      ]);
      expect(store.listInputAttachments("with-files")).toEqual(
        admitted.attachments,
      );

      store.close();
      const reloaded = new SessionStore({ path });
      expect(reloaded.getInput("with-files")?.attachments).toEqual(
        admitted.attachments,
      );
      reloaded.close();
    });
  });

  it("rejects unavailable, duplicate, empty, and over-quota references", () => {
    withStore(
      (store) => {
        store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
        createReadyAttachment(store, "ready-a", 70);
        createReadyAttachment(store, "ready-b", 50);
        store.createImportingAttachment({
          id: "importing",
          displayName: "importing.png",
          stagingName: "importing.part",
        });
        store.createImportingAttachment({
          id: "failed",
          displayName: "failed.png",
          stagingName: "failed.part",
        });
        store.failAttachmentImport("failed", "broken");
        createReadyAttachment(store, "deleted", 1);
        store.softDeleteAttachment("deleted");

        expect(() =>
          store.admitPrompt({ id: "empty", sessionId: "s1", content: "" }),
        ).toThrow(/prompt_content_required/);
        expect(
          store.admitPrompt({
            id: "skill-only",
            sessionId: "s1",
            items: [{ type: "skill", name: "archify", path: "/repo/archify/SKILL.md" }],
          }),
        ).toMatchObject({ id: "skill-only", content: "$archify" });
        expect(() =>
          store.admitPrompt({
            id: "invalid-skill-only",
            sessionId: "s1",
            items: [{ type: "skill", name: "bad\nname", path: "/repo/bad/SKILL.md" }],
          }),
        ).toThrow(/invalid_name/);
        expect(() =>
          store.admitPrompt({
            id: "unknown",
            sessionId: "s1",
            content: "x",
            attachments: [{ assetId: "missing" }],
          }),
        ).toThrow(/attachment_not_found/);
        for (const assetId of ["importing", "failed"]) {
          expect(() =>
            store.admitPrompt({
              id: `not-ready-${assetId}`,
              sessionId: "s1",
              content: "x",
              attachments: [{ assetId }],
            }),
          ).toThrow(/attachment_not_ready/);
        }
        expect(() =>
          store.admitPrompt({
            id: "deleted",
            sessionId: "s1",
            content: "x",
            attachments: [{ assetId: "deleted" }],
          }),
        ).toThrow(/attachment_not_found/);
        expect(() =>
          store.admitPrompt({
            id: "duplicate",
            sessionId: "s1",
            content: "x",
            attachments: [{ assetId: "ready-a" }, { assetId: "ready-a" }],
          }),
        ).toThrow(/attachment_duplicate_reference/);
        expect(() =>
          store.admitPrompt({
            id: "too-many",
            sessionId: "s1",
            content: "x",
            attachments: [{ assetId: "ready-a" }, { assetId: "ready-b" }],
          }),
        ).toThrow(/attachment_count_exceeded/);

        store.admitPrompt({
          id: "session-first",
          sessionId: "s1",
          content: "x",
          attachments: [{ assetId: "ready-a" }],
        });
        expect(
          store.admitPrompt({
            id: "session-same-asset",
            sessionId: "s1",
            content: "x",
            attachments: [{ assetId: "ready-a" }],
          }),
        ).toMatchObject({ id: "session-same-asset" });
        expect(() =>
          store.admitPrompt({
            id: "session-over",
            sessionId: "s1",
            content: "x",
            attachments: [{ assetId: "ready-b" }],
          }),
        ).toThrow(/attachment_session_size_exceeded/);
      },
      {
        attachmentLimits: {
          maxFilesPerPrompt: 1,
          maxBytesPerFile: 100,
          maxBytesPerPrompt: 100,
          maxSessionReferencedBytes: 100,
          resumableThresholdBytes: 50,
        },
      },
    );
  });

  it("reloads 200 inputs with ordered attachment references from one durable snapshot", () => {
    withStore((store, path) => {
      store.createSession({ id: "scale-session", cwd: process.cwd(), model: "m" });
      createReadyAttachment(store, "scale-a", 10);
      createReadyAttachment(store, "scale-b", 20);
      for (let index = 0; index < 200; index++) {
        store.admitPrompt({
          id: `scale-input-${index}`,
          sessionId: "scale-session",
          content: `input ${index}`,
          attachments: [
            { assetId: "scale-b", intent: "ocr" },
            { assetId: "scale-a", intent: "auto" },
          ],
        });
      }

      store.close();
      const reloaded = new SessionStore({ path });
      const inputs = reloaded.listInputs("scale-session");
      expect(inputs).toHaveLength(200);
      expect(inputs.every((input) => input.attachments.length === 2)).toBe(true);
      expect(inputs[199]?.attachments.map((reference) => reference.assetId)).toEqual([
        "scale-b",
        "scale-a",
      ]);
      reloaded.close();
    });
  }, 30_000);

  it("enforces the combined byte limit for one prompt", () => {
    withStore(
      (store) => {
        store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
        createReadyAttachment(store, "asset-a", 60);
        createReadyAttachment(store, "asset-b", 50);
        expect(() =>
          store.admitPrompt({
            id: "prompt-over",
            sessionId: "s1",
            content: "x",
            attachments: [{ assetId: "asset-a" }, { assetId: "asset-b" }],
          }),
        ).toThrow(/attachment_prompt_size_exceeded/);
      },
      {
        attachmentLimits: {
          maxFilesPerPrompt: 2,
          maxBytesPerFile: 100,
          maxBytesPerPrompt: 100,
          maxSessionReferencedBytes: 200,
          resumableThresholdBytes: 50,
        },
      },
    );
  });

  it("returns the first input and owning run for an identical admission retry", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      createReadyAttachment(store, "asset-a", 40);
      const first = store.admitPromptWithRun({
        prompt: {
          id: "retry-input",
          sessionId: "s1",
          content: "x",
          attachments: [{ assetId: "asset-a", intent: "ocr" }],
          metadata: { source: "client", traceId: "first-trace" },
        },
        run: { id: "first-run" },
      });
      const retried = store.admitPromptWithRun({
        prompt: {
          id: "retry-input",
          sessionId: "s1",
          content: "x",
          attachments: [{ assetId: "asset-a", intent: "ocr" }],
          metadata: { source: "client", traceId: "retry-trace" },
        },
        run: { id: "unused-retry-run" },
      });

      expect(retried).toEqual(first);
      expect(store.listRunsByInput("retry-input")).toHaveLength(1);
      expect(store.getRun("unused-retry-run")).toBeUndefined();
      expect(() =>
        store.admitPrompt({
          id: "retry-input",
          sessionId: "s1",
          content: "changed",
          attachments: [{ assetId: "asset-a", intent: "ocr" }],
          metadata: { source: "client" },
        }),
      ).toThrow(/prompt_id_conflict/);
    });
  });

  it("rolls back input, refs, run, and admission event when ref persistence fails", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      createReadyAttachment(store, "asset-a", 40);
      const database = (store as any).database as Database.Database;
      database.exec(`
        CREATE TRIGGER fail_attachment_ref_insert
        BEFORE INSERT ON session_input_attachment
        BEGIN
          SELECT RAISE(ABORT, 'forced attachment ref failure');
        END;
      `);

      expect(() =>
        store.admitPromptWithRun({
          prompt: {
            id: "atomic-file-input",
            sessionId: "s1",
            content: "x",
            attachments: [{ assetId: "asset-a" }],
          },
          run: { id: "atomic-file-run" },
        }),
      ).toThrow("forced attachment ref failure");

      expect(store.getInput("atomic-file-input")).toBeUndefined();
      expect(store.listInputAttachments("atomic-file-input")).toEqual([]);
      expect(store.getRun("atomic-file-run")).toBeUndefined();
      expect(
        store
          .listEvents()
          .some(
            (event) =>
              event.type === "session.input.admitted" &&
              (event.payload.input as { id?: string } | undefined)?.id ===
                "atomic-file-input",
          ),
      ).toBe(false);
    });
  });

  it("persists an attachment from importing to ready", () => {
    withStore((store, path) => {
      const importing = store.createImportingAttachment({
        id: "att-ready",
        displayName: "截图.png",
        declaredMediaType: "image/png",
        stagingName: "att-ready.part",
        createdAt: 100,
      });

      expect(importing).toEqual({
        id: "att-ready",
        displayName: "截图.png",
        declaredMediaType: "image/png",
        status: "importing",
        createdAt: 100,
        updatedAt: 100,
      });
      expect(store.listImportingAttachments()).toEqual([
        expect.objectContaining({
          id: "att-ready",
          stagingName: "att-ready.part",
        }),
      ]);

      const ready = store.markAttachmentReady("att-ready", {
        sha256: "a".repeat(64),
        sizeBytes: 8,
        mediaType: "image/png",
        updatedAt: 101,
      });
      expect(ready).toEqual({
        id: "att-ready",
        displayName: "截图.png",
        declaredMediaType: "image/png",
        mediaType: "image/png",
        sizeBytes: 8,
        sha256: "a".repeat(64),
        status: "ready",
        createdAt: 100,
        updatedAt: 101,
      });
      expect(store.findReadyAttachmentByHash("a".repeat(64))).toEqual(ready);
      expect(store.listImportingAttachments()).toEqual([]);

      store.close();
      const reloaded = new SessionStore({ path });
      expect(reloaded.getAttachment("att-ready")).toEqual(ready);
      reloaded.close();
    });
  });

  it("records a failed attachment import without exposing staging metadata", () => {
    withStore((store) => {
      store.createImportingAttachment({
        id: "att-failed",
        displayName: "broken.png",
        stagingName: "att-failed.part",
        createdAt: 200,
      });

      expect(
        store.failAttachmentImport(
          "att-failed",
          "attachment_storage_failed",
          201,
        ),
      ).toEqual({
        id: "att-failed",
        displayName: "broken.png",
        status: "failed",
        failureCode: "attachment_storage_failed",
        createdAt: 200,
        updatedAt: 201,
      });
      expect(store.listImportingAttachments()).toEqual([]);
    });
  });

  it("enforces attachment state transitions and hides deleted assets", () => {
    withStore((store) => {
      store.createImportingAttachment({
        id: "att-delete",
        displayName: "a.txt",
        declaredMediaType: "text/plain",
        stagingName: "att-delete.part",
        createdAt: 300,
      });
      store.markAttachmentReady("att-delete", {
        sha256: "b".repeat(64),
        sizeBytes: 1,
        mediaType: "text/plain",
        updatedAt: 301,
      });

      expect(() =>
        store.markAttachmentReady("att-delete", {
          sha256: "c".repeat(64),
          sizeBytes: 2,
          mediaType: "text/plain",
          updatedAt: 302,
        }),
      ).toThrow("expected importing");

      const deleted = store.softDeleteAttachment("att-delete", 303);
      expect(deleted).toMatchObject({
        id: "att-delete",
        status: "deleted",
        deletedAt: 303,
      });
      expect(store.getAttachment("att-delete")).toBeUndefined();
      expect(
        store.getAttachment("att-delete", { includeDeleted: true }),
      ).toEqual(deleted);
      expect(() => store.softDeleteAttachment("att-delete", 304)).toThrow(
        "expected ready",
      );
    });
  });

  it("validates attachment transitions before changing durable state", () => {
    withStore((store) => {
      store.createImportingAttachment({
        id: "att-invalid-ready",
        displayName: "a.txt",
        stagingName: "att-invalid-ready.part",
        createdAt: 400,
      });
      expect(() =>
        store.markAttachmentReady("att-invalid-ready", {
          sha256: "not-a-sha",
          sizeBytes: -1,
          mediaType: "",
          updatedAt: 401,
        }),
      ).toThrow();
      expect(store.getAttachment("att-invalid-ready")).toMatchObject({
        status: "importing",
        updatedAt: 400,
      });

      expect(() =>
        store.failAttachmentImport("att-invalid-ready", "", 402),
      ).toThrow("failureCode");
      expect(store.getAttachment("att-invalid-ready")).toMatchObject({
        status: "importing",
        updatedAt: 400,
      });

      store.markAttachmentReady("att-invalid-ready", {
        sha256: "d".repeat(64),
        sizeBytes: 1,
        mediaType: "text/plain",
        updatedAt: 403,
      });
      expect(() =>
        store.softDeleteAttachment("att-invalid-ready", -1),
      ).toThrow("non-negative safe integer");
      expect(store.getAttachment("att-invalid-ready")).toMatchObject({
        status: "ready",
        updatedAt: 403,
      });
    });
  });

  it("reserves one durable pending task for repeated producer requests", () => {
    withStore((store, path) => {
      store.createSession({
        id: "session-1",
        cwd: process.cwd(),
        model: "test",
      });
      const input = {
        id: "task-reserved",
        sessionId: "session-1",
        requestNamespace: "tool",
        requestId: "tool:call-1",
        type: "shell",
        description: "dev server",
        cwd: process.cwd(),
        metadata: { requestFingerprint: "fingerprint-1" },
      };

      const first = store.reserveSessionTask(input);
      const retry = store.reserveSessionTask({ ...input, id: "task-ignored" });

      expect(first).toMatchObject({
        created: true,
        task: { id: "task-reserved", status: "pending" },
      });
      expect(first.task).not.toHaveProperty("startedAt");
      expect(retry).toMatchObject({
        created: false,
        task: { id: "task-reserved" },
      });
      expect(store.listSessionTasks("session-1")).toHaveLength(1);

      expect(store.getSessionTask("task-reserved")).toMatchObject({
        status: "pending",
        requestNamespace: "tool",
        requestId: "tool:call-1",
      });

      store.close();
      const reloaded = new SessionStore({ path });
      expect(reloaded.getSessionTask("task-reserved")).toMatchObject({
        status: "pending",
        requestNamespace: "tool",
        requestId: "tool:call-1",
      });
      expect(
        reloaded.reserveSessionTask({ ...input, id: "task-after-restart" }),
      ).toMatchObject({ created: false, task: { id: "task-reserved" } });
      reloaded.updateSessionTask("task-reserved", {
        status: "interrupted",
        metadata: { admissionPhase: "runtime_missing" },
      });
      reloaded.close();

      const verified = new SessionStore({ path });
      expect(verified.getSessionTask("task-reserved")).toMatchObject({
        requestNamespace: "tool",
        requestId: "tool:call-1",
      });
      expect(
        verified.reserveSessionTask({ ...input, id: "task-after-reconcile" }),
      ).toMatchObject({ created: false, task: { id: "task-reserved" } });
      verified.close();
    });
  });

  it("does not confirm a pending task after it has been stopped", () => {
    withStore((store) => {
      store.createSession({
        id: "session-1",
        cwd: process.cwd(),
        model: "test",
      });
      store.reserveSessionTask({
        id: "task-raced",
        sessionId: "session-1",
        requestNamespace: "http",
        requestId: "request-raced",
        type: "shell",
        description: "dev server",
        cwd: process.cwd(),
        metadata: { admissionPhase: "reserved" },
      });
      store.updateSessionTask("task-raced", { status: "stopped" });

      const result = store.transitionPendingSessionTask("task-raced", {
        status: "running",
        metadata: { admissionPhase: "confirmed" },
      });

      expect(result).toMatchObject({
        transitioned: false,
        task: { id: "task-raced", status: "stopped" },
      });
      expect(store.getSessionTask("task-raced")).toMatchObject({
        status: "stopped",
        metadata: { admissionPhase: "reserved" },
      });
    });
  });

  it("stores Scheduled tasks and Agent run projections in SQLite", () => {
    withStore((store, path) => {
      const task = store.createScheduledTask({
        id: "schedule-1",
        name: "weekday-review",
        prompt: "Review the last day of changes and report risks.",
        recurrence:
          "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0",
        recurrenceFormat: "rrule",
        timezone: "Asia/Shanghai",
        destination: "standalone",
        projectPaths: [process.cwd()],
        executionMode: "worktree",
        skillNames: ["review"],
        permissionProfile: { mode: "workspace_write", network: false },
        createdBy: "agent",
        nextRunAt: 200,
      });
      const run = store.createScheduledRun({
        id: "scheduled-run-1",
        taskId: task.id,
        cause: "manual",
        scheduledFor: 100,
      });
      store.updateScheduledRun(run.id, {
        status: "succeeded",
        sessionId: "session-1",
        runId: "agent-run-1",
        summary: "No high-risk changes.",
        unread: true,
        startedAt: 110,
        finishedAt: 150,
      });
      store.updateScheduledTask(task.id, {
        lastRunAt: 150,
        runCount: 1,
        nextRunAt: 300,
      });
      store.close();

      const reloaded = new SessionStore({ path });
      expect(reloaded.getScheduledTask(task.id)).toMatchObject({
        name: "weekday-review",
        destination: "standalone",
        executionMode: "worktree",
        projectPaths: [process.cwd()],
        skillNames: ["review"],
        runCount: 1,
        nextRunAt: 300,
      });
      expect(
        reloaded.listScheduledRuns({ taskId: task.id, unread: true }),
      ).toMatchObject([
        {
          id: "scheduled-run-1",
          status: "succeeded",
          sessionId: "session-1",
          runId: "agent-run-1",
          summary: "No high-risk changes.",
          unread: true,
        },
      ]);
      expect(reloaded.listScheduledTasks().map((item) => item.id)).toContain(
        task.id,
      );
      expect(reloaded.getScheduledRun(run.id)?.id).toBe(run.id);
      expect(reloaded.deleteScheduledTask(task.id)).toBe(true);
      expect(reloaded.getScheduledTask(task.id)).toBeUndefined();
      expect(reloaded.getScheduledRun(run.id)).toBeUndefined();
      reloaded.close();
    });
  });

  it("interrupts unfinished Scheduled runs after daemon restart", () => {
    withStore((store) => {
      const task = store.createScheduledTask({
        name: "follow-up",
        prompt: "Check deployment status.",
        recurrence: "RRULE:FREQ=MINUTELY;INTERVAL=10",
        recurrenceFormat: "rrule",
        timezone: "UTC",
        destination: "chat",
        sessionId: "session-1",
      });
      const run = store.createScheduledRun({
        taskId: task.id,
        cause: "scheduled",
        scheduledFor: Date.now(),
      });
      store.updateScheduledRun(run.id, {
        status: "running",
        startedAt: Date.now(),
      });

      expect(store.interruptActiveScheduledRuns("daemon restarted")).toBe(1);
      expect(store.getScheduledRun(run.id)).toMatchObject({
        status: "interrupted",
        error: "daemon restarted",
        unread: true,
      });
    });
  });

  it("keeps the legacy Workflow methods and mirrors owner-session events", () => {
    withStore((store) => {
      store.createSession({ id: "workflow-session", cwd: process.cwd(), model: "m" });
      store.saveWorkflowRun({ runId: "workflow-legacy", ownerSessionId: "workflow-session", status: "running", snapshotJson: "{}", createdAt: 1, updatedAt: 1, taskAttempts: [] });
      expect(store.loadWorkflowRun("workflow-legacy")?.runId).toBe("workflow-legacy");
      expect(store.listWorkflowRuns({ ownerSessionId: "workflow-session" })).toHaveLength(1);
      store.appendWorkflowEvent({ runId: "workflow-legacy", sessionId: "workflow-session", type: "workflow_started", eventJson: '{"type":"workflow_started","runId":"workflow-legacy"}', createdAt: 2 });
      expect(store.listWorkflowEvents("workflow-legacy")).toEqual(['{"type":"workflow_started","runId":"workflow-legacy"}']);
      expect(store.listEvents({ sessionId: "workflow-session" }).map((event) => event.type)).toContain("workflow.workflow_started");
      const claim = store.claimWorkflowRun("workflow-legacy", "owner");
      expect(claim.generation).toBe(1);
      store.finishWorkflowRunClaim("workflow-legacy", "owner", "completed");
    });
  });

  it("lists direct child sessions without mixing descendants or siblings", () => {
    withStore((store) => {
      store.createSession({ id: "parent", cwd: process.cwd(), model: "m" });
      store.createSession({
        id: "child-1",
        parentId: "parent",
        cwd: process.cwd(),
        model: "m",
      });
      store.createSession({
        id: "child-2",
        parentId: "parent",
        cwd: process.cwd(),
        model: "m",
      });
      store.createSession({
        id: "grandchild",
        parentId: "child-1",
        cwd: process.cwd(),
        model: "m",
      });
      store.createSession({ id: "other", cwd: process.cwd(), model: "m" });

      expect(
        store
          .listChildSessions("parent")
          .map((session) => session.id)
          .sort(),
      ).toEqual(["child-1", "child-2"]);
      expect(
        store.listChildSessions("child-1").map((session) => session.id),
      ).toEqual(["grandchild"]);
    });
  });

  it("persists sessions and rehydrates from disk", () => {
    withStore((store, path) => {
      const session = store.createSession({
        id: "s1",
        cwd: process.cwd(),
        title: "main",
        model: "test-model",
        metadata: { source: "tui" },
      });

      const reloaded = new SessionStore({ path });
      expect(reloaded.getSession("s1")).toEqual(session);
      expect(reloaded.listSessions().map((row) => row.id)).toEqual(["s1"]);
      reloaded.close();
    });
  });

  it("does not read legacy JSON stores as a migration source", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-session-runtime-"));
    const path = join(dir, "legacy.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({ sessions: { legacy: { id: "legacy" } } }),
        "utf-8",
      );
      expect(() => new SessionStore({ path })).toThrow(/database/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updates session model and emits session.updated", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "old" });
      const updated = store.updateSession("s1", { model: "new" });
      expect(updated.model).toBe("new");
      expect(store.listEvents().map((event) => event.type)).toContain(
        "session.updated",
      );
      expect(store.getSession("s1")?.model).toBe("new");
    });
  });

  it("replaces a session transcript atomically", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const old = store.createMessage({
        id: "m1",
        sessionId: "s1",
        role: "user",
      });
      store.upsertMessagePart({
        id: "p1",
        sessionId: "s1",
        messageId: old.id,
        type: "text",
        status: "completed",
        text: "old",
      });

      const replaced = store.replaceTranscript({
        sessionId: "s1",
        messages: [
          {
            role: "assistant",
            parts: [
              { type: "text", status: "completed", text: "compacted summary" },
            ],
          },
          {
            role: "user",
            parts: [{ type: "text", status: "completed", text: "recent" }],
          },
        ],
      });

      expect(replaced.messages).toHaveLength(2);
      expect(store.listMessages("s1").map((message) => message.id)).toEqual(
        replaced.messages.map((message) => message.id),
      );
      expect(store.listMessageParts("s1").map((part) => part.text)).toEqual([
        "compacted summary",
        "recent",
      ]);
      expect(store.listEvents().map((event) => event.type)).toContain(
        "session.transcript.replaced",
      );
    });
  });

  it("admits prompts, creates messages, updates parts, and keeps per-session order", () => {
    withStore((store, path) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      store.createSession({ id: "s2", cwd: process.cwd(), model: "m" });

      const prompt = store.admitPrompt({
        id: "i1",
        sessionId: "s1",
        content: "hello from the first prompt sentence.",
      });
      expect(store.getSession("s1")?.title).toBe("hello from the first");
      expect(store.resolveSessionListTitle("s1")).toBe("hello from the first");
      store.updateSession("s1", { title: "Renamed conversation" });
      expect(store.resolveSessionListTitle("s1")).toBe("Renamed conversation");
      const first = store.createMessage({
        id: "m1",
        sessionId: "s1",
        role: "user",
        inputId: prompt.id,
      });
      const userPart = store.upsertMessagePart({
        id: "p1",
        sessionId: "s1",
        messageId: first.id,
        type: "text",
        status: "completed",
        text: "hello",
      });
      const second = store.createMessage({
        id: "m2",
        sessionId: "s1",
        role: "assistant",
      });
      const assistantPart = store.upsertMessagePart({
        id: "p2",
        sessionId: "s1",
        messageId: second.id,
        type: "text",
        status: "running",
        text: "h",
      });
      const deltaEvent = store.appendMessagePartDelta({
        sessionId: "s1",
        messageId: second.id,
        partId: assistantPart.id,
        field: "text",
        delta: "i",
      });
      expect(store.latestEventSeq()).toBe(deltaEvent.seq);
      expect(prompt.seq).toBe(1);
      expect(first.seq).toBe(1);
      expect(second.seq).toBe(2);
      expect(userPart.seq).toBe(1);
      expect(store.listMessages("s1").map((row) => row.id)).toEqual([
        "m1",
        "m2",
      ]);
      expect(
        store.listMessages("s1", { afterSeq: 1 }).map((row) => row.id),
      ).toEqual(["m2"]);
      expect(
        store.listMessageParts("s1").map((row) => [row.id, row.text]),
      ).toEqual([
        ["p1", "hello"],
        ["p2", "hi"],
      ]);
      expect(
        store
          .listMessageParts("s1", { messageId: second.id })
          .map((row) => row.id),
      ).toEqual(["p2"]);
      expect(store.listEvents().map((event) => event.type)).not.toContain(
        "session.message.part.delta",
      );
      const runningReloaded = new SessionStore({ path });
      expect(
        runningReloaded.listMessageParts("s1", { messageId: second.id }),
      ).toMatchObject([{ id: "p2", text: "h", status: "running" }]);
      runningReloaded.close();
      store.flushMessagePartDeltas();
      const checkpointReloaded = new SessionStore({ path });
      expect(
        checkpointReloaded.listMessageParts("s1", { messageId: second.id }),
      ).toMatchObject([{ id: "p2", text: "hi", status: "running" }]);
      checkpointReloaded.close();
      store.createMessage({ id: "m3", sessionId: "s2", role: "user" });
      store.upsertMessagePart({
        id: "p2",
        sessionId: "s1",
        messageId: second.id,
        type: "text",
        status: "completed",
      });

      const reloaded = new SessionStore({ path });
      expect(
        reloaded
          .listMessageParts("s1", { messageId: second.id })
          .map((row) => [row.id, row.text]),
      ).toEqual([["p2", "hi"]]);
      expect(reloaded.listEvents().map((event) => event.type)).not.toContain(
        "session.message.part.delta",
      );
      expect(reloaded.listEvents().map((event) => event.type)).toContain(
        "session.message.part.updated",
      );
      reloaded.close();
    });
  });

  it("atomically admits a queued prompt with its owning run", () => {
    withStore((store, path) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      createReadyAttachment(store, "atomic-asset", 40);
      const database = (store as any).database as Database.Database;
      database.exec(`
        CREATE TRIGGER fail_atomic_run_insert
        BEFORE INSERT ON session_run
        BEGIN
          SELECT RAISE(ABORT, 'forced run insert failure');
        END;
      `);

      expect(() =>
        store.admitPromptWithRun({
          prompt: {
            id: "atomic-input",
            sessionId: "s1",
            content: "hello",
            attachments: [{ assetId: "atomic-asset" }],
          },
          run: { id: "atomic-run", metadata: { traceId: "trace-atomic" } },
        }),
      ).toThrow("forced run insert failure");

      expect(store.getInput("atomic-input")).toBeUndefined();
      expect(store.listInputAttachments("atomic-input")).toEqual([]);
      expect(store.getRun("atomic-run")).toBeUndefined();
      expect(store.listEvents().map((event) => event.type)).not.toContain(
        "session.input.admitted",
      );
      const failedReload = new SessionStore({ path });
      expect(failedReload.getInput("atomic-input")).toBeUndefined();
      expect(failedReload.getRun("atomic-run")).toBeUndefined();
      failedReload.close();

      database.exec("DROP TRIGGER fail_atomic_run_insert");
      const admitted = store.admitPromptWithRun({
        prompt: {
          id: "atomic-input",
          sessionId: "s1",
          content: "hello",
          attachments: [{ assetId: "atomic-asset" }],
        },
        run: { id: "atomic-run", metadata: { traceId: "trace-atomic" } },
      });
      expect(admitted).toMatchObject({
        input: { id: "atomic-input", delivery: "queue" },
        run: {
          id: "atomic-run",
          inputId: "atomic-input",
          status: "pending",
          metadata: { traceId: "trace-atomic" },
        },
      });
    });
  });

  it("rolls back transcript replacement when replacement prompt admission fails", () => {
    withStore((store, path) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const original = store.createMessage({
        id: "m1",
        sessionId: "s1",
        role: "user",
      });
      store.upsertMessagePart({
        id: "p1",
        sessionId: "s1",
        messageId: original.id,
        type: "text",
        status: "completed",
        text: "original prompt",
      });
      const database = (store as any).database as Database.Database;
      database.exec(`
        CREATE TRIGGER fail_edit_run_insert
        BEFORE INSERT ON session_run
        BEGIN
          SELECT RAISE(ABORT, 'forced edit run failure');
        END;
      `);

      expect(() =>
        store.replaceTranscriptAndAdmitPrompt({
          transcript: { sessionId: "s1", messages: [] },
          admission: {
            prompt: {
              id: "replacement-input",
              sessionId: "s1",
              content: "replacement",
            },
            run: { id: "replacement-run" },
          },
          createRun: true,
        }),
      ).toThrow("forced edit run failure");

      expect(store.listMessages("s1")).toEqual([
        expect.objectContaining({ id: "m1" }),
      ]);
      expect(store.listMessageParts("s1")).toEqual([
        expect.objectContaining({ id: "p1", text: "original prompt" }),
      ]);
      expect(store.getInput("replacement-input")).toBeUndefined();
      expect(store.getRun("replacement-run")).toBeUndefined();

      const reloaded = new SessionStore({ path });
      expect(reloaded.listMessages("s1")).toEqual([
        expect.objectContaining({ id: "m1" }),
      ]);
      expect(reloaded.listMessageParts("s1")).toEqual([
        expect.objectContaining({ id: "p1", text: "original prompt" }),
      ]);
      reloaded.close();
    });
  });

  it("terminalizes only inputs that have no durable run ownership", () => {
    withStore((store, path) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const owned = store.admitPrompt({
        id: "owned-input",
        sessionId: "s1",
        content: "owned",
      });
      store.createRun({ id: "owned-run", sessionId: "s1", inputId: owned.id });
      const promoted = store.admitPrompt({
        id: "promoted-input",
        sessionId: "s1",
        delivery: "steer",
        content: "promoted",
      });
      const promotedRun = store.createRun({
        id: "promoted-run",
        sessionId: "s1",
      });
      store.createMessage({
        id: "promoted-message",
        sessionId: "s1",
        role: "user",
        inputId: promoted.id,
        runId: promotedRun.id,
      });
      store.admitPrompt({
        id: "orphan-input",
        sessionId: "s1",
        delivery: "steer",
        content: "orphan",
        metadata: { traceId: "trace-orphan" },
      });

      expect(store.terminalizeUnownedInputs("daemon restarted")).toBe(1);
      expect(store.findRunByInput("owned-input")?.id).toBe("owned-run");
      expect(store.findRunByInput("promoted-input")?.id).toBe("promoted-run");
      expect(store.findRunByInput("orphan-input")).toMatchObject({
        status: "interrupted",
        error: "daemon restarted",
        metadata: {
          traceId: "trace-orphan",
          recovery: {
            kind: "orphan_input",
            inputId: "orphan-input",
            delivery: "steer",
            reason: "daemon restarted",
          },
        },
      });
      expect(store.terminalizeUnownedInputs("daemon restarted")).toBe(0);

      const reloaded = new SessionStore({ path });
      expect(reloaded.findRunByInput("orphan-input")).toMatchObject({
        status: "interrupted",
        error: "daemon restarted",
      });
      expect(reloaded.terminalizeUnownedInputs("daemon restarted")).toBe(0);
      reloaded.close();
    });
  });

  it("replays monotonic events by cursor and session", () => {
    withStore(
      (store) => {
        store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
        const cursor = store.listEvents().at(-1)!.seq;
        store.createSession({ id: "s2", cwd: process.cwd(), model: "m" });
        store.admitPrompt({
          sessionId: "s1",
          items: [{ type: "text", text: "wake" }],
        });
        store.appendEvent({ type: "daemon.heartbeat", payload: { ok: true } });

        expect(store.listEvents().map((event) => event.seq)).toEqual([
          1, 2, 3, 4,
        ]);
        expect(store.listEvents().map((event) => event.schemaVersion)).toEqual([
          1, 1, 2, 1,
        ]);
        expect(
          store.listEvents({ afterSeq: cursor }).map((event) => event.type),
        ).toEqual([
          "session.created",
          "session.input.admitted",
          "daemon.heartbeat",
        ]);
        expect(
          store
            .listEvents({ afterSeq: cursor, sessionId: "s1" })
            .map((event) => event.type),
        ).toEqual(["session.input.admitted", "daemon.heartbeat"]);
      },
      { eventRegistry: fixtureEventRegistry },
    );
  });

  it("rejects databases without the current storage format marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-session-event-version-"));
    const path = join(dir, "store.db");
    try {
      const legacy = new Database(path);
      legacy.exec(`
        CREATE TABLE session_event (
          id TEXT PRIMARY KEY,
          seq INTEGER NOT NULL UNIQUE,
          type TEXT NOT NULL,
          session_id TEXT,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO session_event
          (id, seq, type, session_id, payload_json, created_at)
        VALUES ('legacy-event', 7, 'daemon.legacy', NULL, '{"ok":true}', 100);
      `);
      legacy.close();

      expect(
        () => new SessionStore({ path, eventRegistry: fixtureEventRegistry }),
      ).toThrow("Existing databases are not upgraded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists idempotent projection settlements and tracks finite repair attempts", () => {
    withStore((store, path) => {
      const input = {
        id: "settlement-1",
        projector: "daemon-agent:agent-1",
        rootSessionId: "root-1",
        eventSequence: 9,
        action: "retry-terminal-projection" as const,
        payload: { event: { id: "framework-9", type: "child.closed" } },
        error: "first projection failed",
      };
      const created = store.createProjectionSettlement(input);
      expect(store.createProjectionSettlement(input)).toEqual(created);
      expect(() =>
        store.createProjectionSettlement({
          ...input,
          action: "compensate-child",
        }),
      ).toThrow("Projection settlement identity conflict");

      expect(store.markProjectionSettlementRetrying(created.id)).toMatchObject({
        status: "retrying",
        attemptCount: 1,
      });
      expect(
        store.failProjectionSettlement(created.id, "still unavailable", 123),
      ).toMatchObject({
        status: "pending",
        attemptCount: 1,
        lastError: "still unavailable",
        nextRetryAt: 123,
      });
      expect(store.markProjectionSettlementRetrying(created.id)).toMatchObject({
        status: "retrying",
        attemptCount: 2,
      });
      expect(store.resolveProjectionSettlement(created.id)).toMatchObject({
        status: "resolved",
        attemptCount: 2,
        resolvedAt: expect.any(Number),
      });
      store.close();

      const reloaded = new SessionStore({ path });
      expect(
        reloaded.listProjectionSettlements({
          projector: input.projector,
          rootSessionId: input.rootSessionId,
          status: "resolved",
        }),
      ).toHaveLength(1);
      expect(
        reloaded.listProjectionSettlements({ status: ["pending", "retrying"] }),
      ).toEqual([]);
      reloaded.close();
    });
  });

  it("keeps runs terminal while allowing a child task to bind a later run", () => {
    withStore(
      (store) => {
        store.createSession({ id: "parent", cwd: process.cwd(), model: "m" });
        store.createSession({
          id: "child",
          parentId: "parent",
          cwd: process.cwd(),
          model: "m",
        });
        const input = store.admitPrompt({
          id: "i1",
          sessionId: "child",
          content: "first",
        });
        const run = store.createRun({
          id: "r1",
          sessionId: "child",
          inputId: input.id,
        });
        store.updateRun(run.id, { status: "failed", error: "first failed" });
        expect(() => store.updateRun(run.id, { status: "running" })).toThrow(
          "Session run is already terminal",
        );
        expect(store.getRun(run.id)).toMatchObject({
          status: "failed",
          error: "first failed",
        });

        const nextInput = store.admitPrompt({
          id: "i2",
          sessionId: "child",
          content: "second",
        });
        const nextRun = store.createRun({
          id: "r2",
          sessionId: "child",
          inputId: nextInput.id,
        });

        store.createSessionTask({
          id: "task-1",
          sessionId: "parent",
          childSessionId: "child",
          runId: nextRun.id,
          type: "agent",
          description: "Explore",
          cwd: process.cwd(),
        });
        store.updateSessionTask("task-1", {
          status: "failed",
          output: "old",
          error: "old error",
        });
        store.updateSessionTask("task-1", { status: "running" });
        expect(store.getSessionTask("task-1")).toMatchObject({
          status: "running",
        });
        expect(store.getSessionTask("task-1")).not.toHaveProperty("finishedAt");
        expect(store.getSessionTask("task-1")).not.toHaveProperty("output");
        expect(store.getSessionTask("task-1")).not.toHaveProperty("error");
      },
      { deltaFlushIntervalMs: 60_000, deltaFlushBytes: 1024 * 1024 },
    );
  });

  it("flushes pending text deltas when the store closes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-session-runtime-close-"));
    const path = join(dir, "store.db");
    const store = new SessionStore({
      path,
      deltaFlushIntervalMs: 60_000,
      deltaFlushBytes: 1024 * 1024,
    });
    store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
    const message = store.createMessage({
      id: "m1",
      sessionId: "s1",
      role: "assistant",
    });
    const part = store.upsertMessagePart({
      id: "p1",
      sessionId: "s1",
      messageId: message.id,
      type: "text",
      status: "running",
      text: "",
    });
    store.appendMessagePartDelta({
      sessionId: "s1",
      messageId: message.id,
      partId: part.id,
      field: "text",
      delta: "checkpointed",
    });

    store.close();
    const reloaded = new SessionStore({ path });
    expect(reloaded.listMessageParts("s1")).toMatchObject([
      { id: "p1", text: "checkpointed" },
    ]);
    reloaded.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("checkpoints high-frequency deltas in one write transaction", () => {
    withStore(
      (store) => {
        store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
        const message = store.createMessage({
          id: "m1",
          sessionId: "s1",
          role: "assistant",
        });
        const part = store.upsertMessagePart({
          id: "p1",
          sessionId: "s1",
          messageId: message.id,
          type: "text",
          status: "running",
          text: "",
        });
        const database = (store as any).database as Database.Database;
        database.exec(`
        CREATE TABLE delta_audit (count INTEGER NOT NULL);
        INSERT INTO delta_audit VALUES (0);
        CREATE TRIGGER count_delta_update AFTER UPDATE OF text ON session_message_part
        WHEN NEW.id = 'p1'
        BEGIN
          UPDATE delta_audit SET count = count + 1;
        END;
      `);

        for (let index = 0; index < 100; index++) {
          store.appendMessagePartDelta({
            sessionId: "s1",
            messageId: message.id,
            partId: part.id,
            field: "text",
            delta: "x",
          });
        }
        expect(
          database
            .prepare("SELECT text FROM session_message_part WHERE id = 'p1'")
            .get(),
        ).toEqual({ text: "" });

        store.flushMessagePartDeltas();

        expect(database.prepare("SELECT count FROM delta_audit").get()).toEqual(
          { count: 1 },
        );
        expect(
          database
            .prepare(
              "SELECT length(text) AS length FROM session_message_part WHERE id = 'p1'",
            )
            .get(),
        ).toEqual({ length: 100 });
      },
      { deltaFlushIntervalMs: 60_000, deltaFlushBytes: 1024 * 1024 },
    );
  });

  it("keeps part.updated payload text stable after a later delta mutates the live row", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const message = store.createMessage({
        id: "m1",
        sessionId: "s1",
        role: "assistant",
      });
      store.upsertMessagePart({
        id: "p1",
        sessionId: "s1",
        messageId: message.id,
        type: "text",
        status: "running",
        text: "",
      });
      store.appendMessagePartDelta({
        sessionId: "s1",
        messageId: message.id,
        partId: "p1",
        field: "text",
        delta: "Building",
      });

      const updated = store
        .listEvents()
        .filter((event) => event.type === "session.message.part.updated")
        .at(-1);
      const part = updated?.payload.part as { text?: string } | undefined;
      expect(part?.text).toBe("");
      expect(store.listMessageParts("s1")).toMatchObject([
        { id: "p1", text: "Building" },
      ]);
    });
  });

  it("does not mutate live text when transient cursor allocation fails", () => {
    withStore(
      (store) => {
        store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
        const message = store.createMessage({
          id: "m1",
          sessionId: "s1",
          role: "assistant",
        });
        const part = store.upsertMessagePart({
          id: "p1",
          sessionId: "s1",
          messageId: message.id,
          type: "text",
          status: "running",
          text: "",
        });
        const internals = store as any;
        const database = internals.database as Database.Database;
        internals.eventSequence.reservedThrough =
          internals.state.nextEventSeq - 1;
        database.exec(`
        CREATE TRIGGER fail_event_sequence_reservation BEFORE UPDATE ON session_event_sequence
        BEGIN
          SELECT RAISE(ABORT, 'forced sequence reservation failure');
        END;
      `);

        expect(() =>
          store.appendMessagePartDelta({
            sessionId: "s1",
            messageId: message.id,
            partId: part.id,
            field: "text",
            delta: "ghost",
          }),
        ).toThrow("forced sequence reservation failure");
        expect(store.listMessageParts("s1")).toMatchObject([
          { id: "p1", text: "" },
        ]);
        database.exec("DROP TRIGGER fail_event_sequence_reservation");
      },
      { deltaFlushIntervalMs: 60_000, deltaFlushBytes: 1024 * 1024 },
    );
  });

  it("flushes grouped deltas on the timer and retries a failed checkpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-session-runtime-timer-"));
    const path = join(dir, "store.db");
    const store = new SessionStore({
      path,
      deltaFlushIntervalMs: 10,
      deltaFlushBytes: 1024 * 1024,
    });
    try {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const message = store.createMessage({
        id: "m1",
        sessionId: "s1",
        role: "assistant",
      });
      const part = store.upsertMessagePart({
        id: "p1",
        sessionId: "s1",
        messageId: message.id,
        type: "text",
        status: "running",
        text: "",
      });
      const database = (store as any).database as Database.Database;
      database.exec(`
        CREATE TRIGGER fail_delta_update BEFORE UPDATE OF text ON session_message_part
        WHEN NEW.id = 'p1'
        BEGIN
          SELECT RAISE(ABORT, 'forced delta failure');
        END;
      `);
      store.transaction(() => {
        store.appendMessagePartDelta({
          sessionId: "s1",
          messageId: message.id,
          partId: part.id,
          field: "text",
          delta: "timer",
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(
        database
          .prepare("SELECT text FROM session_message_part WHERE id = 'p1'")
          .get(),
      ).toEqual({ text: "" });
      database.exec("DROP TRIGGER fail_delta_update");

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(
        database
          .prepare("SELECT text FROM session_message_part WHERE id = 'p1'")
          .get(),
      ).toEqual({ text: "timer" });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flushes immediately when the delta byte threshold is reached", () => {
    withStore(
      (store) => {
        store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
        const message = store.createMessage({
          id: "m1",
          sessionId: "s1",
          role: "assistant",
        });
        const part = store.upsertMessagePart({
          id: "p1",
          sessionId: "s1",
          messageId: message.id,
          type: "text",
          status: "running",
          text: "",
        });
        const database = (store as any).database as Database.Database;
        store.appendMessagePartDelta({
          sessionId: "s1",
          messageId: message.id,
          partId: part.id,
          field: "text",
          delta: "he",
        });
        expect(
          database
            .prepare("SELECT text FROM session_message_part WHERE id = 'p1'")
            .get(),
        ).toEqual({ text: "" });
        store.appendMessagePartDelta({
          sessionId: "s1",
          messageId: message.id,
          partId: part.id,
          field: "text",
          delta: "llo",
        });
        expect(
          database
            .prepare("SELECT text FROM session_message_part WHERE id = 'p1'")
            .get(),
        ).toEqual({ text: "hello" });
      },
      { deltaFlushIntervalMs: 60_000, deltaFlushBytes: 5 },
    );
  });

  it("rolls back both SQLite and the in-memory read model when a grouped write fails", () => {
    withStore((store, path) => {
      store.createSession({ id: "existing", cwd: process.cwd(), model: "m" });

      expect(() =>
        store.transaction(() => {
          store.createSession({
            id: "transient",
            cwd: process.cwd(),
            model: "m",
          });
          (store as any).database.exec(`
          CREATE TRIGGER fail_session_insert
          BEFORE INSERT ON session
          BEGIN
            SELECT RAISE(ABORT, 'forced store failure');
          END;
        `);
          store.createSession({
            id: "never-committed",
            cwd: process.cwd(),
            model: "m",
          });
        }),
      ).toThrow("forced store failure");

      expect(store.getSession("existing")).toBeDefined();
      expect(store.getSession("transient")).toBeUndefined();
      expect(store.getSession("never-committed")).toBeUndefined();

      const reloaded = new SessionStore({ path });
      expect(reloaded.listSessions().map((session) => session.id)).toEqual([
        "existing",
      ]);
      reloaded.close();
    });
  });

  it("does not reuse a live delta sequence after restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-session-runtime-sequence-"));
    const path = join(dir, "store.db");
    try {
      const store = new SessionStore({ path, deltaFlushIntervalMs: 60_000 });
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const message = store.createMessage({
        id: "m1",
        sessionId: "s1",
        role: "assistant",
      });
      const part = store.upsertMessagePart({
        id: "p1",
        sessionId: "s1",
        messageId: message.id,
        type: "text",
        status: "running",
        text: "",
      });
      const delta = store.appendMessagePartDelta({
        sessionId: "s1",
        messageId: message.id,
        partId: part.id,
        field: "text",
        delta: "live",
      });
      store.close();

      const reloaded = new SessionStore({
        path,
        eventRegistry: fixtureEventRegistry,
      });
      const durable = reloaded.appendEvent({
        type: "daemon.after-restart",
        sessionId: "s1",
      });
      expect(durable.seq).toBeGreaterThan(delta.seq);
      expect(
        reloaded.listEvents({ afterSeq: delta.seq }).map((event) => event.id),
      ).toContain(durable.id);
      reloaded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists only dirty rows and commits grouped mutations once", () => {
    withStore((store, path) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      store.createSession({ id: "s2", cwd: process.cwd(), model: "m" });
      const database = (store as any).database as Database.Database;
      database.exec(`
        CREATE TABLE mutation_audit (count INTEGER NOT NULL);
        INSERT INTO mutation_audit VALUES (0);
        CREATE TRIGGER reject_session_delete BEFORE DELETE ON session
        BEGIN
          SELECT RAISE(ABORT, 'full snapshot rewrite detected');
        END;
        CREATE TRIGGER count_s1_update AFTER UPDATE ON session
        WHEN NEW.id = 's1'
        BEGIN
          UPDATE mutation_audit SET count = count + 1;
        END;
      `);

      store.transaction(() => {
        store.updateSession("s1", { title: "first" });
        store.updateSession("s1", { title: "final" });
      });

      expect(
        database.prepare("SELECT count FROM mutation_audit").get(),
      ).toEqual({ count: 1 });
      const reloaded = new SessionStore({ path });
      expect(reloaded.getSession("s1")?.title).toBe("final");
      expect(reloaded.getSession("s2")).toBeDefined();
      reloaded.close();
    });
  });

  it("tracks runs and permission replies as durable events", () => {
    withStore((store, path) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const input = store.admitPrompt({
        id: "i1",
        sessionId: "s1",
        content: "edit file",
      });
      const run = store.createRun({
        id: "r1",
        sessionId: "s1",
        inputId: input.id,
      });
      store.updateRun(run.id, { status: "running" });
      const attempt = store.createRunAttempt({
        id: "attempt-r1-1",
        runId: run.id,
        provider: "openrouter",
        model: "m",
      });
      store.updateRunAttempt(attempt.id, { status: "running" });
      const message = store.createMessage({
        id: "m1",
        sessionId: "s1",
        role: "assistant",
        runId: run.id,
      });
      store.upsertMessagePart({
        id: "part-tool",
        sessionId: "s1",
        messageId: message.id,
        type: "tool",
        status: "running",
        toolUseId: "tu1",
        toolName: "Write",
        input: { path: "README.md" },
      });
      store.upsertMessagePart({
        id: "part-tool",
        sessionId: "s1",
        messageId: message.id,
        type: "tool",
        status: "completed",
        toolUseId: "tu1",
        toolName: "Write",
        input: { path: "README.md" },
        output: { content: [{ type: "text", text: "ok" }] },
      });
      const permission = store.createPermissionRequest({
        id: "p1",
        sessionId: "s1",
        runId: run.id,
        toolName: "shell",
        payload: { command: "pnpm test" },
      });
      store.replyPermission({
        requestId: permission.id,
        status: "approved",
        decision: "once",
        clientId: "tui-1",
      });
      expect(() =>
        store.replyPermission({ requestId: permission.id, status: "denied" }),
      ).toThrow("Permission request already resolved");
      store.settleActiveRunAttempts(run.id, "completed");
      store.updateRun(run.id, { status: "completed" });

      const reloaded = new SessionStore({ path });
      expect(reloaded.getRun("r1")!.status).toBe("completed");
      expect(reloaded.listRunAttempts("r1")).toMatchObject([
        {
          id: "attempt-r1-1",
          sequence: 1,
          status: "completed",
          provider: "openrouter",
          model: "m",
        },
      ]);
      expect(reloaded.listMessageParts("s1")).toMatchObject([
        {
          id: "part-tool",
          status: "completed",
          toolName: "Write",
          output: { content: [{ type: "text", text: "ok" }] },
        },
      ]);
      expect(reloaded.getPermissionRequest("p1")).toMatchObject({
        status: "approved",
        decision: "once",
        decidedByClientId: "tui-1",
      });
      expect(
        reloaded.listPermissionRequests({
          sessionId: "s1",
          status: "approved",
        }),
      ).toMatchObject([{ id: "p1", toolName: "shell" }]);
      expect(reloaded.listEvents().map((event) => event.type)).toContain(
        "permission.replied",
      );
      expect(reloaded.listEvents().map((event) => event.type)).toContain(
        "session.message.part.updated",
      );
      expect(reloaded.listEvents().map((event) => event.type)).toContain(
        "session.run_attempt.updated",
      );
      reloaded.close();
    });
  });

  it("records multiple logical provider attempts under one run with independent identities", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const input = store.admitPrompt({
        id: "i1",
        sessionId: "s1",
        content: "retry me",
      });
      store.createRun({ id: "r1", sessionId: "s1", inputId: input.id });
      store.updateRun("r1", { status: "running" });

      const first = store.createRunAttempt({
        id: "attempt-1",
        runId: "r1",
        provider: "p",
        model: "m",
      });
      store.updateRunAttempt(first.id, { status: "running" });
      store.updateRunAttempt(first.id, {
        status: "failed",
        errorKind: "provider",
        error: "fallback",
      });
      const second = store.createRunAttempt({
        id: "attempt-2",
        runId: "r1",
        provider: "backup",
        model: "m2",
        retryReason: "primary provider failed",
      });
      store.updateRunAttempt(second.id, { status: "running" });
      store.updateRunAttempt(second.id, {
        status: "completed",
        inputTokens: 10,
        outputTokens: 4,
      });
      store.updateRun("r1", { status: "completed" });

      expect(store.listRunAttempts("r1")).toMatchObject([
        {
          id: "attempt-1",
          runId: "r1",
          sequence: 1,
          status: "failed",
          provider: "p",
        },
        {
          id: "attempt-2",
          runId: "r1",
          sequence: 2,
          status: "completed",
          provider: "backup",
        },
      ]);
    });
  });

  it("returns an atomic attach snapshot and interrupts runs left by a previous daemon", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const input = store.admitPrompt({
        id: "i1",
        sessionId: "s1",
        content: "hello",
      });
      store.createRun({ id: "r1", sessionId: "s1", inputId: input.id });
      const attempt = store.createRunAttempt({
        id: "attempt-r1-1",
        runId: "r1",
      });
      store.updateRunAttempt(attempt.id, { status: "running" });
      const message = store.createMessage({
        id: "m1",
        sessionId: "s1",
        role: "user",
        inputId: input.id,
      });
      store.upsertMessagePart({
        id: "part1",
        sessionId: "s1",
        messageId: message.id,
        type: "text",
        status: "completed",
        text: "hello",
      });
      const assistant = store.createMessage({
        id: "m2",
        sessionId: "s1",
        role: "assistant",
        runId: "r1",
      });
      store.upsertMessagePart({
        id: "part-running-text",
        sessionId: "s1",
        messageId: assistant.id,
        type: "text",
        status: "running",
        text: "partial",
      });
      store.upsertMessagePart({
        id: "part-running-tool",
        sessionId: "s1",
        messageId: assistant.id,
        type: "tool",
        status: "running",
        toolUseId: "tool-1",
        toolName: "Read",
      });

      expect(store.interruptActiveRuns()).toBe(1);
      const snapshot = store.getSessionState("s1");
      expect(snapshot.cursor).toBe(store.listEvents().at(-1)?.seq);
      expect(snapshot.inputs.map((row) => row.id)).toEqual(["i1"]);
      expect(snapshot.messages.map((row) => row.id)).toEqual(["m1", "m2"]);
      expect(snapshot.parts.find((row) => row.id === "part1")?.text).toBe(
        "hello",
      );
      expect(snapshot.runs).toMatchObject([
        { id: "r1", status: "interrupted" },
      ]);
      expect(snapshot.attempts).toMatchObject([
        {
          id: "attempt-r1-1",
          runId: "r1",
          status: "cancelled",
          errorKind: "interrupted",
        },
      ]);
      expect(
        snapshot.parts
          .filter((part) => part.messageId === "m2")
          .map((part) => part.status),
      ).toEqual(["interrupted", "failed"]);
      expect(
        snapshot.parts.find((part) => part.id === "part-running-tool")
          ?.metadata,
      ).toMatchObject({
        toolCallId: "tool-1",
        toolAttemptId: "tool_attempt_tool-1_1",
        failureKind: "unknown_outcome",
      });
    });
  });

  it("expires permission requests whose live resolver belonged to a previous daemon", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      store.createPermissionRequest({
        id: "pending",
        sessionId: "s1",
        toolName: "Write",
      });
      const resolved = store.createPermissionRequest({
        id: "resolved",
        sessionId: "s1",
        toolName: "Read",
      });
      store.replyPermission({
        requestId: resolved.id,
        status: "approved",
        decision: "once",
      });

      expect(store.expirePendingPermissionRequests()).toBe(1);
      expect(store.getPermissionRequest("pending")).toMatchObject({
        status: "expired",
        decision: "Daemon restarted before the permission was resolved",
      });
      expect(store.getPermissionRequest("resolved")?.status).toBe("approved");
    });
  });

  it("persists task/child/run links and terminalizes active tasks after a restart", () => {
    withStore((store, path) => {
      store.createSession({ id: "parent", cwd: process.cwd(), model: "m" });
      store.createSession({
        id: "child",
        parentId: "parent",
        cwd: process.cwd(),
        model: "m",
      });
      const input = store.admitPrompt({
        id: "child-input",
        sessionId: "child",
        content: "inspect",
      });
      const run = store.createRun({
        id: "child-run",
        sessionId: "child",
        inputId: input.id,
      });
      store.createSessionTask({
        id: "task-child",
        sessionId: "parent",
        childSessionId: "child",
        type: "agent",
        description: "Explore@default",
        cwd: process.cwd(),
      });
      store.updateSessionTask("task-child", { runId: run.id });

      const reloaded = new SessionStore({ path });
      expect(reloaded.getSessionState("parent").tasks).toMatchObject([
        {
          id: "task-child",
          childSessionId: "child",
          runId: "child-run",
          status: "running",
        },
      ]);
      expect(reloaded.interruptActiveSessionTasks()).toBe(1);
      expect(reloaded.getSessionTask("task-child")).toMatchObject({
        status: "interrupted",
        error: "Daemon restarted before the task completed",
      });
      expect(
        reloaded.listEvents({ sessionId: "parent" }).map((event) => event.type),
      ).toContain("session.task.updated");
      reloaded.close();
    });
  });

  it("archives sessions without deleting their replay history", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      store.archiveSession("s1");

      expect(store.listSessions().map((session) => session.id)).toEqual([]);
      expect(
        store
          .listSessions({ includeArchived: true })
          .map((session) => session.id),
      ).toEqual(["s1"]);
      expect(store.listEvents().map((event) => event.type)).toEqual([
        "session.created",
        "session.archived",
      ]);
    });
  });

  it("hard deletes session trees and their replay history", () => {
    withStore((store) => {
      store.createSession({ id: "parent", cwd: process.cwd(), model: "m" });
      store.createSession({
        id: "child",
        parentId: "parent",
        cwd: process.cwd(),
        model: "m",
      });
      const input = store.admitPrompt({
        id: "input-parent",
        sessionId: "parent",
        content: "hello",
      });
      const run = store.createRun({
        id: "run-parent",
        sessionId: "parent",
        inputId: input.id,
      });
      const message = store.createMessage({
        id: "message-parent",
        sessionId: "parent",
        role: "assistant",
        runId: run.id,
      });
      store.upsertMessagePart({
        id: "part-parent",
        sessionId: "parent",
        messageId: message.id,
        type: "text",
        status: "completed",
        text: "done",
      });
      store.createPermissionRequest({
        id: "permission-parent",
        sessionId: "parent",
        runId: run.id,
        toolName: "Write",
        payload: {},
      });

      expect(store.deleteSessionTree("parent")).toEqual(["parent", "child"]);

      expect(store.listSessions({ includeArchived: true })).toEqual([]);
      expect(store.listEvents().map((event) => event.sessionId)).not.toContain(
        "parent",
      );
      expect(() => store.getSessionState("parent")).toThrow(
        "Session not found: parent",
      );
      expect(() => store.getSessionState("child")).toThrow(
        "Session not found: child",
      );
    });
  });

  it("owns projects in SQLite and keeps session identity when the directory is rebound", () => {
    withStore((store) => {
      const root = mkdtempSync(join(tmpdir(), "ohs-project-"));
      const moved = join(root, "moved");
      const nested = join(root, "source", "apps", "desktop");
      mkdirSync(nested, { recursive: true });
      mkdirSync(join(moved, "apps", "desktop"), { recursive: true });
      try {
        const project = store.inspectProject(join(root, "source"));
        const session = store.createSession({
          id: "project-session",
          projectId: project.id,
          cwd: nested,
          model: "m",
        });
        expect(session.cwdRelative).toBe(join("apps", "desktop"));
        expect(store.listProjects()).toHaveLength(1);

        store.rebindProject(project.id, moved);
        expect(store.getSession(session.id)).toMatchObject({
          projectId: project.id,
          cwd: join(moved, "apps", "desktop"),
        });

        store.archiveProject(project.id);
        expect(store.listProjects()).toEqual([]);
        expect(store.listProjects({ includeArchived: true })).toHaveLength(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("keeps unpinned project order stable when a project is inspected again", () => {
    withStore((store, databasePath) => {
      const root = mkdtempSync(join(tmpdir(), "ohs-project-order-"));
      const firstPath = join(root, "first");
      const secondPath = join(root, "second");
      mkdirSync(firstPath);
      mkdirSync(secondPath);
      try {
        const first = store.inspectProject(firstPath);
        const second = store.inspectProject(secondPath);
        const database = new Database(databasePath);
        try {
          database
            .prepare(
              "UPDATE project SET created_at = ?, last_opened_at = ? WHERE id = ?",
            )
            .run(100, 100, first.id);
          database
            .prepare(
              "UPDATE project SET created_at = ?, last_opened_at = ? WHERE id = ?",
            )
            .run(200, 200, second.id);
        } finally {
          database.close();
        }

        store.inspectProject(firstPath);

        expect(store.listProjects().map((project) => project.id)).toEqual([
          second.id,
          first.id,
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("stores and clears a project default shell", () => {
    withStore((store) => {
      const root = mkdtempSync(join(tmpdir(), "ohs-project-shell-"));
      try {
        const project = store.inspectProject(root);
        expect(project.defaultShell).toBeUndefined();

        const updated = store.setProjectDefaultShell(
          project.id,
          "  pwsh.exe  ",
        );
        expect(updated.defaultShell).toBe("pwsh.exe");
        expect(store.getProject(project.id)?.defaultShell).toBe("pwsh.exe");

        const cleared = store.setProjectDefaultShell(project.id, "");
        expect(cleared.defaultShell).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("persists versioned attachment representations and reuses only completed cache entries", () => {
    withStore((store, path) => {
      createReadyAttachment(store, "att-ocr");
      const running = store.createAttachmentRepresentation({
        id: "rep-1",
        assetId: "att-ocr",
        kind: "ocr_text",
        processor: "light-ocr",
        processorVersion: "0.5.7",
        cacheKey: "cache-a",
        mediaType: "text/plain",
        createdAt: 100,
      });
      expect(running.status).toBe("running");
      expect(store.findCompletedAttachmentRepresentation("att-ocr", "ocr_text", "cache-a"))
        .toBeUndefined();

      const completed = store.completeAttachmentRepresentation("rep-1", {
        text: "hello",
        metadata: { lineCount: 1 },
        updatedAt: 101,
      });
      expect(completed).toMatchObject({ status: "completed", text: "hello" });
      expect(store.findCompletedAttachmentRepresentation("att-ocr", "ocr_text", "cache-a"))
        .toEqual(completed);
      expect(store.listAttachmentRepresentations("att-ocr")).toEqual([
        completed,
      ]);

      store.close();
      const reloaded = new SessionStore({ path });
      try {
        expect(reloaded.getAttachmentRepresentation("rep-1")).toEqual(completed);
      } finally {
        reloaded.close();
      }
    });
  });

  it("acquires, renews, expires, and idempotently releases attachment leases", () => {
    withStore((store) => {
      createReadyAttachment(store, "att-lease-a");
      createReadyAttachment(store, "att-lease-b");

      const acquired = store.acquireAttachmentLeases({
        assetIds: ["att-lease-a", "att-lease-b"],
        ownerKind: "session_run",
        ownerId: "run-1",
        timestamp: 100,
        expiresAt: 200,
      });
      expect(acquired).toHaveLength(2);
      expect(acquired.map((lease) => lease.assetId)).toEqual([
        "att-lease-a",
        "att-lease-b",
      ]);
      expect(store.listActiveAttachmentLeases(150)).toEqual(acquired);

      const reacquired = store.acquireAttachmentLeases({
        assetIds: ["att-lease-a"],
        ownerKind: "session_run",
        ownerId: "run-1",
        timestamp: 160,
        expiresAt: 260,
      });
      expect(reacquired).toEqual([
        expect.objectContaining({
          id: acquired[0]!.id,
          assetId: "att-lease-a",
          createdAt: 100,
          renewedAt: 160,
          expiresAt: 260,
        }),
      ]);

      expect(store.renewAttachmentLeases({
        ownerKind: "session_run",
        ownerId: "run-1",
        timestamp: 180,
        expiresAt: 300,
      })).toBe(2);
      expect(store.listActiveAttachmentLeases(250)).toHaveLength(2);
      expect(store.listActiveAttachmentLeases(300)).toEqual([]);
      expect(store.deleteExpiredAttachmentLeases(300)).toBe(2);
      expect(store.deleteExpiredAttachmentLeases(300)).toBe(0);
      expect(store.releaseAttachmentLeases("session_run", "run-1")).toBe(0);
    });
  });

  it("rolls back a lease batch when any attachment is unavailable", () => {
    withStore((store) => {
      createReadyAttachment(store, "att-lease-ready");

      expect(() => store.acquireAttachmentLeases({
        assetIds: ["att-lease-ready", "att-missing"],
        ownerKind: "session_run",
        ownerId: "run-atomic",
        timestamp: 100,
        expiresAt: 200,
      })).toThrow("Attachment is not ready: att-missing");
      expect(store.listActiveAttachmentLeases(150)).toEqual([]);
    });
  });
});
