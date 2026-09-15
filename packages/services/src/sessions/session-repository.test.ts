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
});
