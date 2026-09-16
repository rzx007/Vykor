/**
 * DevelopmentResource: 技能、Agent Persona、Hook 与 Git 源码控制资源。
 */

import type { HttpTransport } from "../transport/http-transport.js";
import type {
  AgentPersonaInfo,
  HookInfo,
  SkillSnapshot,
} from "../types/index.js";

export class DevelopmentResource {
  constructor(private readonly transport: HttpTransport) {}

  /** `GET /skills` */
  async listSkills(
    options: { signal?: AbortSignal } = {},
  ): Promise<SkillSnapshot> {
    return await this.transport.request<SkillSnapshot>("/skills", {
      signal: options.signal,
    });
  }

  /** `DELETE /skills/:id` */
  async removeSkill(
    id: string,
    input: { expectedContent: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<SkillSnapshot> {
    return await this.transport.request<SkillSnapshot>(
      `/skills/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        body: input,
        signal: options.signal,
      },
    );
  }

  /** `GET /agent-personas` */
  async listAgentPersonas(
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentPersonaInfo[]> {
    const response = await this.transport.request<{ agents: AgentPersonaInfo[] }>(
      "/agent-personas",
      {
        signal: options.signal,
      },
    );
    return response.agents;
  }

  /** `GET /hooks?cwd=&sessionId=` */
  async listHooks(options: {
    cwd: string;
    sessionId?: string;
    signal?: AbortSignal;
  }): Promise<HookInfo[]> {
    const { signal, ...query } = options;
    const response = await this.transport.request<{ hooks: HookInfo[] }>(
      this.transport.path("/hooks", query),
      { signal },
    );
    return response.hooks;
  }

  /** `GET /git/diff?cwd=&full=` */
  async getGitDiff(options: {
    cwd: string;
    full?: boolean;
    signal?: AbortSignal;
  }): Promise<string> {
    const { signal, cwd, full } = options;
    const response = await this.transport.request<{ output: string }>(
      this.transport.path("/git/diff", { cwd, ...(full ? { full: "true" } : {}) }),
      { signal },
    );
    return response.output;
  }

  /** `GET /git/branch?cwd=&list=` */
  async getGitBranch(options: {
    cwd: string;
    list?: boolean;
    signal?: AbortSignal;
  }): Promise<string> {
    const { signal, cwd, list } = options;
    const response = await this.transport.request<{ output: string }>(
      this.transport.path("/git/branch", { cwd, ...(list ? { list: "true" } : {}) }),
      { signal },
    );
    return response.output;
  }

  /** `GET /git/status?cwd=` */
  async getGitStatus(options: {
    cwd: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const { signal, cwd } = options;
    const response = await this.transport.request<{ output: string }>(
      this.transport.path("/git/status", { cwd }),
      { signal },
    );
    return response.output;
  }

  /** `POST /git/commit` */
  async gitCommit(
    input: { cwd: string; message: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const response = await this.transport.request<{ output: string }>("/git/commit", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
    return response.output;
  }
}
