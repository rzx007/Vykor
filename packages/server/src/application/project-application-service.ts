import { stat } from "node:fs/promises";

import { isAbsolute, relative, sep } from "node:path";
import type { ProjectRecord, SessionRecord } from "@vykor/protocol";
import { ApplicationError } from "../shared/application-error.js";

interface ProjectRebindRuntime {
  listSessions(): SessionRecord[];
  hasWork(sessionId: string): boolean;
  hasActiveTerminals(projectId: string): boolean;
  closeAgent(sessionId: string): Promise<void>;
  enterRebind(isIdle: () => boolean): { release(): void } | undefined;
  events: { checkpoint(): number; publishSince(seq: number): void };
}

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
  constructor(private readonly projects: ProjectOperations, private readonly runtime?: ProjectRebindRuntime) {}

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
    if (!this.runtime) return this.projects.rebind(projectId, path);
    const previous = this.projects.list({ includeArchived: true }).find(project => project.id === projectId);
    if (!previous) throw new ApplicationError(404, `Project not found: ${projectId}`);
    const sessions = this.runtime.listSessions().filter(session => session.projectId === projectId);
    const lease = this.runtime.enterRebind(() => !this.runtime!.hasActiveTerminals(projectId) && sessions.every(session => session.status !== "running" && !this.runtime!.hasWork(session.id)));
    if (!lease) throw new ApplicationError(409, "Project has active work; wait before rebinding");
    try {
      for (const session of sessions) {
        const path = relative(previous.path, session.cwd);
        if (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)) await this.runtime.closeAgent(session.id);
      }
      const before = this.runtime.events.checkpoint();
      const project = this.projects.rebind(projectId, path);
      this.runtime.events.publishSince(before);
      return project;
    } finally { lease.release(); }
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
