import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "../session-runtime/store.js";
import { normalizeProjectPath } from "./project-records.js";
import { ProjectRepository } from "./project-repository.js";

describe("ProjectRepository queries", () => {
  it("lists projects in current order and reads one project", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-project-repository-"));
    const firstPath = join(directory, "first");
    const secondPath = join(directory, "second");
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      const first = store.inspectProject(firstPath);
      const second = store.inspectProject(secondPath);
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
      const project = store.inspectProject(oldPath);
      const firstOldCwd = join(oldPath, "first");
      const secondOldCwd = join(oldPath, "second");
      store.createSession({
        id: "s1",
        projectId: project.id,
        cwd: firstOldCwd,
        model: "m",
      });
      store.createSession({
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
      expect(store.getSession("s1")?.cwd).toBe(firstOldCwd);
      expect(store.getSession("s2")?.cwd).toBe(secondOldCwd);
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
});
