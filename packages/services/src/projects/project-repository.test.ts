import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { ApplicationOwnerConflictError, SessionStore } from "../session-runtime/store.js";
import type { StorageContext } from "../database/storage-context.js";
import { normalizeProjectPath } from "./project-records.js";
import { ProjectRepository } from "./project-repository.js";

describe("ProjectRepository queries", () => {
  it("lists projects in current order and reads one project", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-project-repository-"));
    const firstPath = join(directory, "first");
    const secondPath = join(directory, "second");
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      const first = store.projects.inspect(firstPath);
      const second = store.projects.inspect(secondPath);
      const repository = new ProjectRepository((store as any).storage);

      expect(repository.list().map((project) => project.id)).toEqual([
        second.id,
        first.id,
      ]);
      expect(repository.get(first.id)).toMatchObject({
        id: first.id,
        path: firstPath,
      });
      expect(repository.list({ includeArchived: true })).toHaveLength(2);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("normalizes equivalent resolved paths to the same lookup key", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-project-path-"));
    try {
      const path = join(directory, "Repo");
      const expected = process.platform === "win32" ? path.toLowerCase() : path;
      expect(normalizeProjectPath(`${path}${sep}`)).toBe(
        expected.replace(/\\/g, "/"),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("ProjectRepository mutations", () => {
  const writes: Array<[string, (store: SessionStore, id: string, path: string) => unknown]> = [
    ["inspect new", (store, _id, path) => store.projects.inspect(`${path}-new`)],
    ["inspect existing", (store, _id, path) => store.projects.inspect(path)],
    ["rename", (store, id) => store.projects.rename(id, "changed")],
    ["setPinned", (store, id) => store.projects.setPinned(id, true)],
    ["setDefaultShell", (store, id) => store.projects.setDefaultShell(id, "pwsh")],
    ["archive", (store, id) => store.projects.archive(id)],
    ["rebind", (store, id, path) => store.projects.rebind(id, `${path}-new`)],
    ["inspectProject new", (store, _id, path) => store.projects.inspect(`${path}-new`)],
    ["inspectProject existing", (store, _id, path) => store.projects.inspect(path)],
    ["renameProject", (store, id) => store.projects.rename(id, "changed")],
    ["setProjectPinned", (store, id) => store.projects.setPinned(id, true)],
    ["setProjectDefaultShell", (store, id) => store.projects.setDefaultShell(id, "pwsh")],
    ["archiveProject", (store, id) => store.projects.archive(id)],
    ["rebindProject", (store, id, path) => store.projects.rebind(id, `${path}-new`)],
  ];

  describe.each(["before owner check", "after owner check"])("takeover %s", (timing) => {
    it.each(writes)("rejects %s without changing project or session state", (_name, write) => {
      const directory = mkdtempSync(join(tmpdir(), "ohs-project-owner-"));
      const path = join(directory, "sessions.db");
      const first = new SessionStore({ path });
      const second = new SessionStore({ path });
      const storage = (first as unknown as { storage: StorageContext }).storage;
      const assertWritable = storage.assertWritable;
      try {
        first.acquireApplicationOwner({ ownerId: "first", pid: 1, now: 1, staleAfterMs: 1_000 });
        const projectPath = join(directory, "project");
        const project = first.projects.inspect(projectPath);
        first.sessions.create({ id: "session", cwd: projectPath, projectId: project.id, model: "test" });
        const before = first.projects.list({ includeArchived: true });
        const locations = storage.database.connection.prepare("SELECT * FROM project_location").all();
        const session = first.sessions.get("session");
        const takeOver = () => second.acquireApplicationOwner({ ownerId: "second", pid: 2, now: 2_000, staleAfterMs: 1_000 });
        if (timing === "before owner check") takeOver();
        else storage.assertWritable = () => {
          assertWritable();
          takeOver();
        };

        expect(() => write(first, project.id, projectPath)).toThrow(
          timing === "before owner check" ? ApplicationOwnerConflictError : "database is locked",
        );
        expect(second.projects.list({ includeArchived: true })).toEqual(before);
        expect(storage.database.connection.prepare("SELECT * FROM project_location").all()).toEqual(locations);
        expect(first.sessions.get("session")).toEqual(session);
        expect(storage.database.connection.prepare("SELECT cwd FROM session WHERE id = 'session'").get()).toEqual({ cwd: projectPath });
      } finally {
        storage.assertWritable = assertWritable;
        first.close();
        second.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it("inspects and updates project presentation fields", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-project-mutations-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      const storage = (store as any).storage;
      const repository = new ProjectRepository(storage);
      const project = repository.inspect(join(directory, "workspace"));

      expect(repository.rename(project.id, "  New   Name ").name).toBe(
        "New Name",
      );
      expect(repository.setPinned(project.id, true).pinnedAt).toEqual(
        expect.any(Number),
      );
      expect(repository.setDefaultShell(project.id, "  pwsh.exe  ")).toMatchObject({
        defaultShell: "pwsh.exe",
      });
      expect(repository.setDefaultShell(project.id, null).defaultShell).toBeUndefined();
      repository.archive(project.id);
      expect(repository.list().map((item) => item.id)).not.toContain(project.id);
      expect(repository.list({ includeArchived: true }).map((item) => item.id)).toContain(
        project.id,
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back SQLite, read model, and mutations when rebind fails mid-loop", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-project-rebind-"));
    const oldPath = join(directory, "old");
    const nextPath = join(directory, "next");
    const databasePath = join(directory, "sessions.db");
    const store = new SessionStore({ path: databasePath });
    try {
      const project = store.projects.inspect(oldPath);
      const firstOldCwd = join(oldPath, "first");
      const secondOldCwd = join(oldPath, "second");
      store.sessions.create({
        id: "s1",
        projectId: project.id,
        cwd: firstOldCwd,
        model: "m",
      });
      store.sessions.create({
        id: "s2",
        projectId: project.id,
        cwd: secondOldCwd,
        model: "m",
      });
      const storage = (store as any).storage;
      const repository = new ProjectRepository(storage);
      storage.database.connection.exec(`
        CREATE TRIGGER fail_second_session_rebind
        BEFORE UPDATE OF cwd ON session
        WHEN NEW.id = 's2'
        BEGIN
          SELECT RAISE(ABORT, 'forced rebind failure');
        END;
      `);

      expect(() => repository.rebind(project.id, nextPath)).toThrow(
        "forced rebind failure",
      );

      expect(repository.get(project.id)?.path).toBe(oldPath);
      expect(store.sessions.get("s1")?.cwd).toBe(firstOldCwd);
      expect(store.sessions.get("s2")?.cwd).toBe(secondOldCwd);
      expect(
        storage.database.connection
          .prepare("SELECT id, cwd FROM session ORDER BY id")
          .all(),
      ).toEqual([
        { id: "s1", cwd: firstOldCwd },
        { id: "s2", cwd: secondOldCwd },
      ]);
      expect(storage.mutations.sessions.size).toBe(0);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rebinds successfully, preserves history, and rejects another active project", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-project-rebind-success-"));
    const originalPath = join(directory, "original");
    const nextPath = join(directory, "next");
    const conflictPath = join(directory, "conflict");
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      const project = store.projects.inspect(originalPath);
      store.sessions.create({
        id: "s1",
        projectId: project.id,
        cwd: join(originalPath, "app"),
        model: "m",
      });
      const conflict = store.projects.inspect(conflictPath);
      const storage = (store as any).storage;
      const repository = new ProjectRepository(storage);

      repository.rebind(project.id, nextPath);
      repository.rebind(project.id, originalPath);

      expect(repository.get(project.id)?.path).toBe(originalPath);
      expect(store.sessions.get("s1")?.cwd).toBe(join(originalPath, "app"));
      expect(
        storage.database.connection
          .prepare(
            "SELECT id, status FROM project_location WHERE project_id = ? ORDER BY rowid",
          )
          .all(project.id),
      ).toEqual([
        expect.objectContaining({ status: "historical" }),
        expect.objectContaining({ status: "historical" }),
        expect.objectContaining({ status: "active" }),
      ]);
      const locationIds = storage.database.connection
        .prepare(
          "SELECT id FROM project_location WHERE project_id = ? ORDER BY rowid",
        )
        .all(project.id) as Array<{ id: string }>;
      expect(new Set(locationIds.map((row) => row.id)).size).toBe(3);
      expect(storage.mutations.sessions.size).toBe(0);
      expect(() => repository.rebind(project.id, conflictPath)).toThrow(
        "Project directory is already bound to another project",
      );
      expect(repository.get(conflict.id)?.path).toBe(conflictPath);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("participates in an outer store transaction and returns isolated records", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-project-outer-transaction-"));
    const originalPath = join(directory, "original");
    const nextPath = join(directory, "next");
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      const project = store.projects.inspect(originalPath);
      const repository = store.projects;
      const returned = repository.get(project.id)!;
      returned.name = "mutated by caller";
      expect(repository.get(project.id)?.name).toBe(project.name);

      expect(() =>
        store.transaction(() => {
          repository.rebind(project.id, nextPath);
          throw new Error("rollback outer transaction");
        }),
      ).toThrow("rollback outer transaction");

      expect(repository.get(project.id)?.path).toBe(originalPath);
      store.transaction(() => repository.rebind(project.id, nextPath));
      expect(repository.get(project.id)?.path).toBe(nextPath);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
