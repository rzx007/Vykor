import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "../session-runtime/store.js";
import { ConversationRepository } from "./conversation-repository.js";

describe("ConversationRepository read operations", () => {
  it("reads inputs and input attachments with position ordering", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-conv-repo-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    try {
      const repository = new ConversationRepository((store as any).storage);

      expect(() => repository.listInputs("missing-session")).toThrow(
        "Session not found: missing-session",
      );
      expect(() => repository.listSessionInputAttachments("missing-session")).toThrow(
        "Session not found: missing-session",
      );

      store.sessions.create({ id: "s1", cwd: directory, model: "m" });

      expect(repository.getInput("i1")).toBeUndefined();

      store.attachments.createImportingAttachment({
        id: "att1",
        displayName: "doc.txt",
        declaredMediaType: "text/plain",
        stagingName: "doc.part",
        createdAt: 10,
      });
      store.attachments.markAttachmentReady("att1", {
        sha256: "a".repeat(64),
        sizeBytes: 50,
        mediaType: "text/plain",
        updatedAt: 11,
      });

      const in1 = store.conversationTransactions.admitPrompt({
        id: "i1",
        sessionId: "s1",
        delivery: "queue",
        attachments: [{ assetId: "att1" }],
        items: [{ type: "text", text: "hello" }],
      });

      const in2 = store.conversationTransactions.admitPrompt({
        id: "i2",
        sessionId: "s1",
        delivery: "queue",
        items: [{ type: "text", text: "second input" }],
      });

      // getInput returns clone
      const fetchedIn1 = repository.getInput("i1");
      expect(fetchedIn1).toBeDefined();
      expect(fetchedIn1!.id).toBe("i1");
      fetchedIn1!.content = "mutated";
      expect(repository.getInput("i1")!.content).not.toBe("mutated");

      // listInputs sorted by seq
      const inputs = repository.listInputs("s1");
      expect(inputs.map((i) => i.id)).toEqual(["i1", "i2"]);

      // listInputAttachments
      const inputAttachments = repository.listInputAttachments("i1");
      expect(inputAttachments).toHaveLength(1);
      expect(inputAttachments[0]!.assetId).toBe("att1");

      // listSessionInputAttachments
      const sessionAttachments = repository.listSessionInputAttachments("s1");
      expect(sessionAttachments).toHaveLength(1);

      // count references
      expect(repository.countInputAttachmentReferences("att1")).toBe(1);
      expect(repository.countAttachmentReferences("att1")).toBe(1);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lists messages and parts with messageId, afterSeq, limit, and clone protection", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-conv-repo-msg-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    try {
      const repository = new ConversationRepository((store as any).storage);

      expect(() => repository.listMessages("missing")).toThrow("Session not found: missing");
      expect(() => repository.listMessageParts("missing")).toThrow("Session not found: missing");

      store.sessions.create({ id: "s1", cwd: directory, model: "m" });

      store.conversations.createMessage({ id: "m1", sessionId: "s1", role: "user" });
      store.conversations.createMessage({ id: "m2", sessionId: "s1", role: "assistant" });
      store.conversations.createMessage({ id: "m3", sessionId: "s1", role: "user" });

      store.conversations.upsertMessagePart({ id: "p1", sessionId: "s1", messageId: "m1", type: "text", text: "part 1" });
      store.conversations.upsertMessagePart({ id: "p2", sessionId: "s1", messageId: "m1", type: "text", text: "part 2" });
      store.conversations.upsertMessagePart({ id: "p3", sessionId: "s1", messageId: "m2", type: "text", text: "part 3" });
      store.conversations.upsertMessagePart({ id: "p4", sessionId: "s1", messageId: "m3", type: "text", text: "part 4" });

      // listMessages
      expect(repository.listMessages("s1").map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
      expect(repository.listMessages("s1", { afterSeq: 1 }).map((m) => m.id)).toEqual(["m2", "m3"]);
      expect(repository.listMessages("s1", { afterSeq: 1, limit: 1 }).map((m) => m.id)).toEqual(["m2"]);

      // listMessageParts with messageId filter, afterSeq, limit
      expect(repository.listMessageParts("s1", { messageId: "m1" }).map((p) => p.id)).toEqual(["p1", "p2"]);
      expect(repository.listMessageParts("s1", { afterSeq: 1, limit: 2 }).map((p) => p.id)).toEqual(["p2", "p3"]);

      // clone protection
      const parts = repository.listMessageParts("s1");
      parts[0]!.text = "mutated text";
      expect(repository.listMessageParts("s1")[0]!.text).toBe("part 1");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lists events with afterSeq, sessionId filter, limit, and checks latestEventSeq", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-conv-repo-events-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    try {
      const repository = new ConversationRepository((store as any).storage);

      store.sessions.create({ id: "s1", cwd: directory, model: "m" });
      store.sessions.create({ id: "s2", cwd: directory, model: "m" });

      const initialSeq = repository.latestEventSeq();
      expect(initialSeq).toBeGreaterThanOrEqual(2); // session.created events

      const s1Events = repository.listEvents({ sessionId: "s1" });
      expect(s1Events.length).toBeGreaterThanOrEqual(1);
      expect(s1Events.every((e) => e.sessionId === undefined || e.sessionId === "s1")).toBe(true);

      const allEvents = repository.listEvents();
      const firstEventSeq = allEvents[0]!.seq;
      const afterSeqEvents = repository.listEvents({ afterSeq: firstEventSeq });
      expect(afterSeqEvents.every((e) => e.seq > firstEventSeq)).toBe(true);

      const limited = repository.listEvents({ limit: 1 });
      expect(limited).toHaveLength(1);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  describe("ConversationRepository write operations", () => {
    it("creates messages with seq ordering, duplicate checks, session timestamps, and event emission", () => {
      const directory = mkdtempSync(join(tmpdir(), "vk-conv-repo-msg-write-"));
      const store = new SessionStore({ path: join(directory, "store.db") });
      try {
        const repository = new ConversationRepository({
          storage: (store as any).storage,
          save: () => (store as any).save(),
        });

        store.sessions.create({ id: "s1", cwd: directory, model: "m" });
        const before = store.sessions.get("s1")!.updatedAt;

        // 1. Create message
        const m1 = repository.createMessage({
          id: "m1",
          sessionId: "s1",
          role: "user",
          metadata: { orig: true },
        });
        expect(m1.id).toBe("m1");
        expect(m1.seq).toBe(1);
        expect(m1.role).toBe("user");
        expect(store.sessions.get("s1")!.updatedAt).toBeGreaterThanOrEqual(before);

        // returns clone
        m1.role = "assistant";
        expect(repository.listMessages("s1")[0]!.role).toBe("user");

        // Event emitted
        const events = repository.listEvents({ sessionId: "s1" });
        const createdEvent = events.find((e) => e.type === "session.message.created");
        expect(createdEvent).toBeDefined();
        expect(createdEvent!.payload).toMatchObject({ message: { id: "m1", role: "user" } });

        // 2. Reject duplicate message id
        expect(() =>
          repository.createMessage({ id: "m1", sessionId: "s1", role: "assistant" }),
        ).toThrow("Session message already exists: m1");

        // 3. Reject missing session
        expect(() =>
          repository.createMessage({ sessionId: "missing", role: "user" }),
        ).toThrow("Session not found: missing");

        // 4. Sequential seq
        const m2 = repository.createMessage({
          id: "m2",
          sessionId: "s1",
          role: "assistant",
        });
        expect(m2.seq).toBe(2);
      } finally {
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("upserts message parts with alignment checks, field merging, typed fields, and events", () => {
      const directory = mkdtempSync(join(tmpdir(), "vk-conv-repo-part-write-"));
      const store = new SessionStore({ path: join(directory, "store.db") });
      try {
        const repository = new ConversationRepository({
          storage: (store as any).storage,
          save: () => (store as any).save(),
        });

        store.sessions.create({ id: "s1", cwd: directory, model: "m" });
        store.sessions.create({ id: "s2", cwd: directory, model: "m" });
        repository.createMessage({ id: "m1", sessionId: "s1", role: "user" });

        // 1. Session alignment check
        expect(() =>
          repository.upsertMessagePart({
            id: "p1",
            sessionId: "s2",
            messageId: "m1",
            type: "text",
            text: "misaligned",
          }),
        ).toThrow("Session message m1 does not belong to session s2");

        // 2. Insert part with typed fields
        const part = repository.upsertMessagePart({
          id: "p1",
          sessionId: "s1",
          messageId: "m1",
          type: "tool",
          status: "pending",
          toolName: "bash",
          toolUseId: "call_1",
          input: { cmd: "ls" },
          metadata: { note: "initial" },
        });
        expect(part.id).toBe("p1");
        expect(part.seq).toBe(1);
        expect(part.status).toBe("pending");
        expect(part.toolName).toBe("bash");

        // returns clone
        part.toolName = "mutated";
        expect(repository.listMessageParts("s1", { messageId: "m1" })[0]!.toolName).toBe("bash");

        // 3. Update part with field merge
        const updated = repository.upsertMessagePart({
          id: "p1",
          sessionId: "s1",
          messageId: "m1",
          type: "tool",
          status: "completed",
          output: { stdout: "files" },
          isError: false,
          metadata: { step: 2 },
        });
        expect(updated.status).toBe("completed");
        expect(updated.output).toEqual({ stdout: "files" });
        expect(updated.toolName).toBe("bash"); // retained from previous
        expect(updated.metadata).toEqual({ note: "initial", step: 2 }); // merged

        // Event emitted
        const events = repository.listEvents({ sessionId: "s1" });
        const partEvent = events.filter((e) => e.type === "session.message.part.updated").at(-1);
        expect(partEvent).toBeDefined();
        expect(partEvent!.payload).toMatchObject({ part: { id: "p1", status: "completed" } });
      } finally {
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("appends events with registry validation, seq monotonicity, and optional session", () => {
      const directory = mkdtempSync(join(tmpdir(), "vk-conv-repo-event-write-"));
      const store = new SessionStore({ path: join(directory, "store.db") });
      try {
        const repository = new ConversationRepository({
          storage: (store as any).storage,
          save: () => (store as any).save(),
        });

        store.sessions.create({ id: "s1", cwd: directory, model: "m" });

        // 1. Registry validation error
        expect(() =>
          repository.appendEvent({
            type: "invalid.event.type" as any,
            sessionId: "s1",
          }),
        ).toThrow(/Unregistered durable event type/);

        // 2. Missing session error when sessionId is passed
        expect(() =>
          repository.appendEvent({
            type: "session.closing",
            sessionId: "missing",
            payload: { sessionId: "missing" },
          }),
        ).toThrow("Session not found: missing");

        // 3. Monotonic seq
        const e1 = repository.appendEvent({
          type: "session.closing",
          sessionId: "s1",
          payload: { sessionId: "s1" },
        });
        const e2 = repository.appendEvent({
          type: "session.archived",
          sessionId: "s1",
          payload: { sessionId: "s1" },
        });
        expect(e2.seq).toBeGreaterThan(e1.seq);
        expect(e2.sessionId).toBe("s1");

        // returns clone
        e1.type = "mutated" as any;
        expect(repository.listEvents().find((e) => e.id === e1.id)!.type).toBe("session.closing");
      } finally {
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});
