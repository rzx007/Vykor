import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "../session-runtime/store.js";
import { SessionRepository } from "./session-repository.js";

describe("SessionRepository read operations", () => {
  it("gets a session by id and returns deep clones", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-session-repo-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    try {
      const repository = new SessionRepository((store as any).storage);
      expect(repository.get("nonexistent")).toBeUndefined();

      store.createSession({
        id: "s1",
        cwd: directory,
        model: "test-model",
        title: "Session 1",
        metadata: { key: "val", nested: { count: 1 } },
      });

      const session = repository.get("s1");
      expect(session).toBeDefined();
      expect(session!.id).toBe("s1");
      expect(session!.title).toBe("Session 1");

      // Mutate returned object
      session!.title = "Mutated";
      (session!.metadata.nested as { count: number }).count = 99;

      const fresh = repository.get("s1");
      expect(fresh!.title).toBe("Session 1");
      expect((fresh!.metadata.nested as { count: number }).count).toBe(1);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lists sessions with cwd filtering, limit, archiving, and updatedAt descending sort", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-session-repo-list-"));
    const dirA = join(directory, "dirA");
    const dirB = join(directory, "dirB");
    const store = new SessionStore({ path: join(directory, "store.db") });
    try {
      const repository = new SessionRepository((store as any).storage);

      store.createSession({ id: "s1", cwd: dirA, model: "m", title: "first" });
      store.createSession({ id: "s2", cwd: dirA, model: "m", title: "second" });
      store.createSession({ id: "s3", cwd: dirB, model: "m", title: "third" });

      // s1 is updated later -> updatedAt is newer
      store.updateSession("s1", { title: "first updated" });

      // Default list: sorted by updatedAt desc, exclude archived
      const all = repository.list();
      expect(all.map((s) => s.id)).toEqual(["s1", "s3", "s2"]);

      // With cwd filtering (cwd is resolved)
      const filtered = repository.list({ cwd: dirA });
      expect(filtered.map((s) => s.id)).toEqual(["s1", "s2"]);

      // With limit
      const limited = repository.list({ limit: 1 });
      expect(limited.map((s) => s.id)).toEqual(["s1"]);

      // Archiving
      store.archiveSession("s1");
      expect(repository.list().map((s) => s.id)).toEqual(["s3", "s2"]);
      expect(repository.list({ includeArchived: true }).map((s) => s.id)).toEqual([
        "s1",
        "s3",
        "s2",
      ]);

      // List returns clone
      const clonedList = repository.list();
      clonedList[0]!.title = "mutated list item";
      expect(repository.get(clonedList[0]!.id)!.title).not.toBe("mutated list item");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lists child sessions sorted by createdAt asc and errors when parent is not found", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-session-repo-child-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    try {
      const repository = new SessionRepository((store as any).storage);

      expect(() => repository.listChildren("missing-parent")).toThrow(
        "Session not found: missing-parent",
      );

      store.createSession({ id: "parent", cwd: directory, model: "m" });
      store.createSession({ id: "child1", parentId: "parent", cwd: directory, model: "m" });
      store.createSession({ id: "child2", parentId: "parent", cwd: directory, model: "m" });
      store.createSession({ id: "other", cwd: directory, model: "m" });

      const children = repository.listChildren("parent");
      expect(children.map((c) => c.id)).toEqual(["child1", "child2"]);

      // Archiving child1
      store.archiveSession("child1");
      expect(repository.listChildren("parent").map((c) => c.id)).toEqual(["child2"]);
      expect(
        repository.listChildren("parent", { includeArchived: true }).map((c) => c.id),
      ).toEqual(["child1", "child2"]);

      // Mutating result doesn't change repository state
      children[0]!.title = "mutated child";
      expect(repository.get("child1")!.title).not.toBe("mutated child");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  describe("SessionRepository write operations", () => {
    it("creates sessions with project inspection, parent project inheritance, defaults, and events", () => {
      const directory = mkdtempSync(join(tmpdir(), "ohs-session-repo-write-"));
      const store = new SessionStore({ path: join(directory, "store.db") });
      try {
        const repository = new SessionRepository({
          storage: (store as any).storage,
          projects: (store as any).projects,
          appendEvent: (input) => (store as any).appendEvent(input),
          save: () => (store as any).save(),
        });

        // 1. Create with defaults and inspect cwd
        const s1 = repository.create({
          id: "s1",
          cwd: directory,
          model: "gpt-4",
        });
        expect(s1.id).toBe("s1");
        expect(s1.title).toBe("");
        expect(s1.status).toBe("idle");
        expect(s1.metadata).toEqual({});
        expect(s1.createdAt).toBe(s1.updatedAt);
        expect(s1.cwdRelative).toBeDefined();

        // returns clone
        s1.title = "mutated title";
        expect(repository.get("s1")!.title).toBe("");

        // event emitted
        const events = store.listEvents({ sessionId: "s1" });
        const createdEvent = events.find((e) => e.type === "session.created");
        expect(createdEvent).toBeDefined();
        expect(createdEvent!.payload).toMatchObject({ session: { id: "s1" } });

        // 2. Reject duplicate id
        expect(() => repository.create({ id: "s1", cwd: directory, model: "m" })).toThrow(
          "Session already exists: s1",
        );

        // 3. Child session inherits parent's projectId
        const child = repository.create({
          id: "child1",
          parentId: "s1",
          cwd: directory,
          model: "m",
        });
        expect(child.projectId).toBe(s1.projectId);
        expect(child.parentId).toBe("s1");
      } finally {
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("updates sessions, handles agent deletion, replaces metadata, enforces mutable guard, and emits events", () => {
      const directory = mkdtempSync(join(tmpdir(), "ohs-session-repo-update-"));
      const store = new SessionStore({ path: join(directory, "store.db") });
      try {
        const repository = new SessionRepository({
          storage: (store as any).storage,
          projects: (store as any).projects,
          appendEvent: (input) => (store as any).appendEvent(input),
          save: () => (store as any).save(),
        });

        repository.create({
          id: "s1",
          cwd: directory,
          model: "gpt-4",
          title: "Initial",
          agent: "coder",
          metadata: { initial: 1 },
        });

        // Update title, model, metadata replacement, agent null removal
        const updated = repository.update("s1", {
          title: "New Title",
          model: "gpt-4-turbo",
          agent: null,
          metadata: { replaced: true },
        });
        expect(updated.title).toBe("New Title");
        expect(updated.model).toBe("gpt-4-turbo");
        expect(updated.agent).toBeUndefined();
        expect(updated.metadata).toEqual({ replaced: true });

        // event emitted
        const events = store.listEvents({ sessionId: "s1" });
        const updatedEvent = events.find((e) => e.type === "session.updated");
        expect(updatedEvent).toBeDefined();
        expect(updatedEvent!.payload).toMatchObject({
          session: { id: "s1", title: "New Title" },
        });

        // beginArchive & idempotency
        const closing = repository.beginArchive("s1");
        expect(closing.status).toBe("closing");
        const closing2 = repository.beginArchive("s1");
        expect(closing2.status).toBe("closing");

        // mutable guard on closing session
        expect(() => repository.update("s1", { title: "fail" })).toThrow(/Session is closing/);

        // archive & idempotency
        const archived = repository.archive("s1");
        expect(archived.status).toBe("archived");
        expect(archived.archivedAt).toBeDefined();
        const archived2 = repository.archive("s1");
        expect(archived2.status).toBe("archived");

        // mutable guard on archived session
        expect(() => repository.update("s1", { title: "fail" })).toThrow(/Session is archived/);
      } finally {
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});
