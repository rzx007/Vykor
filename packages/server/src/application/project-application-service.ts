import { stat } from "node:fs/promises";

import type { ProjectRecord } from "@vykor/protocol";

export interface ProjectOperations {
  list(options?: { includeArchived?: boolean }): ProjectRecord[];
  inspect(path: string): ProjectRecord;
  rename(projectId: string, name: string): ProjectRecord;
  setPinned(projectId: string, pinned: boolean): ProjectRecord;
  setDefaultShell(projectId: string, shell: string | null): ProjectRecord;
  rebind(projectId: string, path: string): ProjectRecord;
  archive(projectId: string): ProjectRecord;
}

export class ProjectApplicationService {
  constructor(private readonly projects: ProjectOperations) {}

  list(options: { includeArchived?: boolean } = {}) {
    return this.projects.list(options);
  }

  async inspect(path: string) {
    await this.assertDirectory(path);
    return this.projects.inspect(path);
  }

  rename(projectId: string, name: string) {
    return this.projects.rename(projectId, name);
  }

  setPinned(projectId: string, pinned: boolean) {
    return this.projects.setPinned(projectId, pinned);
  }

  setDefaultShell(projectId: string, shell: string | null) {
    return this.projects.setDefaultShell(projectId, shell);
  }

  async rebind(projectId: string, path: string) {
    await this.assertDirectory(path);
    return this.projects.rebind(projectId, path);
  }

  archive(projectId: string) {
    return this.projects.archive(projectId);
  }

  private async assertDirectory(path: string): Promise<void> {
    if (!(await stat(path)).isDirectory()) {
      throw new Error("path is not a directory");
    }
  }
}
