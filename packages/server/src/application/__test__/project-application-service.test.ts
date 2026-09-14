import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProjectRecord } from "@openharness/protocol";
import { SessionStore } from "@openharness/services";
import { describe, expect, it, vi } from "vitest";

import {
  ProjectApplicationService,
  type ProjectOperations,
} from "../project-application-service.js";
import { DaemonApplication } from "../daemon-application.js";

const project: ProjectRecord = {
  id: "p1",
  name: "Project",
  path: "C:/project",
  lastOpenedAt: 1,
  createdAt: 1,
  updatedAt: 1,
};

function createOperations(): ProjectOperations & Record<string, ReturnType<typeof vi.fn>> {
  return {
    list: vi.fn(() => [project]),
    inspect: vi.fn(() => project),
    rename: vi.fn(() => project),
    setPinned: vi.fn(() => project),
    setDefaultShell: vi.fn(() => project),
    rebind: vi.fn(() => project),
    archive: vi.fn(() => project),
  };
}

describe("ProjectApplicationService", () => {
  it("delegates every project operation through the narrow capability", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-project-service-"));
    const operations = createOperations();
    const service = new ProjectApplicationService(operations);
    try {
      expect(service.list({ includeArchived: true })).toEqual([project]);
      await expect(service.inspect(directory)).resolves.toEqual(project);
      expect(service.rename("p1", "Renamed")).toEqual(project);
      expect(service.setPinned("p1", true)).toEqual(project);
      expect(service.setDefaultShell("p1", null)).toEqual(project);
      await expect(service.rebind("p1", directory)).resolves.toEqual(project);
      expect(service.archive("p1")).toEqual(project);

      expect(operations.list).toHaveBeenCalledWith({ includeArchived: true });
      expect(operations.inspect).toHaveBeenCalledWith(directory);
      expect(operations.rename).toHaveBeenCalledWith("p1", "Renamed");
      expect(operations.setPinned).toHaveBeenCalledWith("p1", true);
      expect(operations.setDefaultShell).toHaveBeenCalledWith("p1", null);
      expect(operations.rebind).toHaveBeenCalledWith("p1", directory);
      expect(operations.archive).toHaveBeenCalledWith("p1");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is composed with store.projects instead of the legacy Store methods", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-project-composition-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    const project = store.inspectProject(directory);
    const application = new DaemonApplication({
      store,
      settings: {
        apiFormat: "anthropic",
        model: "test-model",
        maxTurns: 1,
        permission: { mode: "full_auto" },
        sandbox: { enabled: false },
        memory: { enabled: false },
      },
      log: () => undefined,
    });
    try {
      (store as any).renameProject = () => {
        throw new Error("legacy method must not be used");
      };

      expect(application.projects.rename(project.id, "Renamed").name).toBe(
        "Renamed",
      );
    } finally {
      await application.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects files before calling inspect or rebind", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-project-service-file-"));
    const file = join(directory, "not-a-directory.txt");
    writeFileSync(file, "file");
    const operations = createOperations();
    const service = new ProjectApplicationService(operations);
    try {
      await expect(service.inspect(file)).rejects.toThrow("path is not a directory");
      await expect(service.rebind("p1", file)).rejects.toThrow(
        "path is not a directory",
      );
      expect(operations.inspect).not.toHaveBeenCalled();
      expect(operations.rebind).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
