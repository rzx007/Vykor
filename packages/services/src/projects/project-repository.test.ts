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
