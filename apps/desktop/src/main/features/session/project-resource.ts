import type { HttpTransport } from "@rzx/client";
import type { ProjectRecord } from "@vykor/protocol";

export class ProjectResource {
  constructor(private readonly transport: HttpTransport) {}

  /** `GET /projects` */
  async list(
    options: { includeArchived?: boolean; signal?: AbortSignal } = {},
  ): Promise<ProjectRecord[]> {
    const { signal, ...query } = options;
    const response = await this.transport.request<{ projects: ProjectRecord[] }>(
      this.transport.path("/projects", query),
      { signal },
    );
    return response.projects;
  }

  /** `POST /projects/inspect` */
  async inspect(path: string): Promise<ProjectRecord> {
    return (
      await this.transport.request<{ project: ProjectRecord }>("/projects/inspect", {
        method: "POST",
        body: { path },
      })
    ).project;
  }

  /** `PATCH /projects/:id` (name) */
  async rename(projectId: string, name: string): Promise<ProjectRecord> {
    return (
      await this.transport.request<{ project: ProjectRecord }>(
        `/projects/${encodeURIComponent(projectId)}`,
        { method: "PATCH", body: { name } },
      )
    ).project;
  }

  /** `PATCH /projects/:id` (pinned) */
  async setPinned(
    projectId: string,
    pinned: boolean,
  ): Promise<ProjectRecord> {
    return (
      await this.transport.request<{ project: ProjectRecord }>(
        `/projects/${encodeURIComponent(projectId)}`,
        { method: "PATCH", body: { pinned } },
      )
    ).project;
  }

  /** `PATCH /projects/:id` (defaultShell) */
  async setDefaultShell(
    projectId: string,
    defaultShell: string | null,
  ): Promise<ProjectRecord> {
    return (
      await this.transport.request<{ project: ProjectRecord }>(
        `/projects/${encodeURIComponent(projectId)}`,
        { method: "PATCH", body: { defaultShell } },
      )
    ).project;
  }

  /** `POST /projects/:id/rebind` */
  async rebind(projectId: string, path: string): Promise<ProjectRecord> {
    return (
      await this.transport.request<{ project: ProjectRecord }>(
        `/projects/${encodeURIComponent(projectId)}/rebind`,
        { method: "POST", body: { path } },
      )
    ).project;
  }

  /** `DELETE /projects/:id` */
  async archive(projectId: string): Promise<ProjectRecord> {
    return (
      await this.transport.request<{ project: ProjectRecord }>(
        `/projects/${encodeURIComponent(projectId)}`,
        { method: "DELETE" },
      )
    ).project;
  }

}
