import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "../session-runtime/store.js";
import { ConversationRepository } from "./conversation-repository.js";

describe("ConversationRepository read operations", () => {
  it("reads inputs and input attachments with position ordering", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-conv-repo-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    try {
      const repository = new ConversationRepository((store as any).storage);

      expect(() => repository.listInputs("missing-session")).toThrow(
        "Session not found: missing-session",
      );
      expect(() => repository.listSessionInputAttachments("missing-session")).toThrow(
        "Session not found: missing-session",
      );

      store.createSession({ id: "s1", cwd: directory, model: "m" });

      expect(repository.getInput("i1")).toBeUndefined();

      store.createImportingAttachment({
        id: "att1",
        displayName: "doc.txt",
        declaredMediaType: "text/plain",
        stagingName: "doc.part",
        createdAt: 10,
      });
      store.markAttachmentReady("att1", {
        sha256: "a".repeat(64),
        sizeBytes: 50,
        mediaType: "text/plain",
        updatedAt: 11,
      });

      const in1 = store.admitPrompt({
        id: "i1",
        sessionId: "s1",
        delivery: "queue",
        attachments: [{ assetId: "att1" }],
        items: [{ type: "text", text: "hello" }],
      });

      const in2 = store.admitPrompt({
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
    const directory = mkdtempSync(join(tmpdir(), "ohs-conv-repo-msg-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    try {
      const repository = new ConversationRepository((store as any).storage);

      expect(() => repository.listMessages("missing")).toThrow("Session not found: missing");
      expect(() => repository.listMessageParts("missing")).toThrow("Session not found: missing");

      store.createSession({ id: "s1", cwd: directory, model: "m" });

      store.createMessage({ id: "m1", sessionId: "s1", role: "user" });
      store.createMessage({ id: "m2", sessionId: "s1", role: "assistant" });
      store.createMessage({ id: "m3", sessionId: "s1", role: "user" });

      store.upsertMessagePart({ id: "p1", sessionId: "s1", messageId: "m1", type: "text", text: "part 1" });
      store.upsertMessagePart({ id: "p2", sessionId: "s1", messageId: "m1", type: "text", text: "part 2" });
      store.upsertMessagePart({ id: "p3", sessionId: "s1", messageId: "m2", type: "text", text: "part 3" });
      store.upsertMessagePart({ id: "p4", sessionId: "s1", messageId: "m3", type: "text", text: "part 4" });

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
    const directory = mkdtempSync(join(tmpdir(), "ohs-conv-repo-events-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    try {
      const repository = new ConversationRepository((store as any).storage);

      store.createSession({ id: "s1", cwd: directory, model: "m" });
      store.createSession({ id: "s2", cwd: directory, model: "m" });

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
});
