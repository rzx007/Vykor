/**
 * SystemResource: 系统配置、命令、上下文、记忆、Dream 与环境设定资源。
 */

import type { PluginCatalogEntry } from "@openharness/protocol";
import type { HttpTransport } from "../transport/http-transport.js";
import type {
  CommandCatalogEntry,
  ListCommandsOptions,
  McpServerStatus,
  MemoryEntryRecord,
  MemoryListResponse,
  OutputStyleInfo,
  StartDreamResponse,
} from "../types/index.js";

export class SystemResource {
  constructor(private readonly transport: HttpTransport) {}

  /** `GET /commands` */
  async listCommands(
    options: ListCommandsOptions & { signal?: AbortSignal },
  ): Promise<CommandCatalogEntry[]> {
    const { signal, ...query } = options;
    const response = await this.transport.request<{ commands: CommandCatalogEntry[] }>(
      this.transport.path("/commands", query),
      { signal },
    );
    return response.commands;
  }

  /** `GET /settings` */
  async getSettings(
    options: { signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.transport.request<{ settings: Record<string, unknown> }>(
      "/settings",
      { signal: options.signal },
    );
    return response.settings;
  }

  /** `PATCH /settings` */
  async patchSettings(
    patch: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.transport.request<{ settings: Record<string, unknown> }>(
      "/settings",
      {
        method: "PATCH",
        body: patch,
        signal: options.signal,
      },
    );
    return response.settings;
  }

  /** `GET /sessions/:id/mcp` */
  async getSessionMcp(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<McpServerStatus[]> {
    const response = await this.transport.request<{ servers: McpServerStatus[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/mcp`,
      { signal: options.signal },
    );
    return response.servers;
  }

  /** `GET /memory?cwd=` */
  async listMemory(options: {
    cwd: string;
    signal?: AbortSignal;
  }): Promise<MemoryListResponse> {
    const { signal, ...query } = options;
    return await this.transport.request<MemoryListResponse>(
      this.transport.path("/memory", query),
      { signal },
    );
  }

  /** `GET /memory/:id?cwd=` */
  async getMemory(
    entryId: string,
    options: { cwd: string; signal?: AbortSignal },
  ): Promise<MemoryEntryRecord> {
    const { signal, cwd } = options;
    const response = await this.transport.request<{ entry: MemoryEntryRecord }>(
      this.transport.path(`/memory/${encodeURIComponent(entryId)}`, { cwd }),
      { signal },
    );
    return response.entry;
  }

  /** `POST /memory` */
  async addMemory(
    input: { cwd: string; content: string; tags?: string[] },
    options: { signal?: AbortSignal } = {},
  ): Promise<MemoryEntryRecord> {
    const response = await this.transport.request<{ entry: MemoryEntryRecord }>(
      "/memory",
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
    return response.entry;
  }

  /** `DELETE /memory/:id?cwd=` */
  async removeMemory(
    entryId: string,
    options: { cwd: string; signal?: AbortSignal },
  ): Promise<void> {
    const { signal, cwd } = options;
    await this.transport.request<{ deleted: boolean }>(
      this.transport.path(`/memory/${encodeURIComponent(entryId)}`, { cwd }),
      { method: "DELETE", signal },
    );
  }

  /** `GET /context/plugins?cwd=` — safe plugin picker metadata. */
  async listContextPlugins(options: {
    cwd: string;
    signal?: AbortSignal;
  }): Promise<PluginCatalogEntry[]> {
    const { signal, ...query } = options;
    const response = await this.transport.request<{ plugins: PluginCatalogEntry[] }>(
      this.transport.path("/context/plugins", query),
      { signal },
    );
    return response.plugins;
  }

  /** `GET /context?cwd=` */
  async getContextPreview(options: {
    cwd: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const { signal, ...query } = options;
    const response = await this.transport.request<{ report: string }>(
      this.transport.path("/context", query),
      { signal },
    );
    return response.report;
  }

  /** `GET /context/status?cwd=` */
  async getContextStatus(options: {
    cwd: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const { signal, ...query } = options;
    const response = await this.transport.request<{ report: string }>(
      this.transport.path("/context/status", query),
      { signal },
    );
    return response.report;
  }

  /** `GET /context/usage?cwd=&sessionId=&refresh=` */
  async getContextUsage(options: {
    cwd: string;
    sessionId?: string;
    refresh?: boolean;
    previousContextWindow?: number;
    signal?: AbortSignal;
  }): Promise<{ snapshot: unknown; report: string }> {
    const { signal, refresh, previousContextWindow, ...rest } = options;
    const query: Record<string, string | undefined> = {
      ...rest,
      ...(refresh !== undefined ? { refresh: refresh ? "true" : "false" } : {}),
      ...(previousContextWindow !== undefined
        ? { previousContextWindow: String(previousContextWindow) }
        : {}),
    };
    return await this.transport.request<{ snapshot: unknown; report: string }>(
      this.transport.path("/context/usage", query),
      { signal },
    );
  }

  /** `POST /dream` */
  async startDream(
    input: { cwd: string; sessionId?: string; preview?: boolean },
    options: { signal?: AbortSignal } = {},
  ): Promise<StartDreamResponse> {
    return await this.transport.request<StartDreamResponse>("/dream", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  /** `GET /profile` */
  async getProfileStatus(
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const response = await this.transport.request<{ report: string }>("/profile", {
      signal: options.signal,
    });
    return response.report;
  }

  /** `POST /profile/init` */
  async initProfile(options: { signal?: AbortSignal } = {}): Promise<string> {
    const response = await this.transport.request<{ report: string }>(
      "/profile/init",
      {
        method: "POST",
        signal: options.signal,
      },
    );
    return response.report;
  }

  /** `GET /output-styles` */
  async listOutputStyles(
    options: { signal?: AbortSignal } = {},
  ): Promise<OutputStyleInfo[]> {
    const response = await this.transport.request<{ styles: OutputStyleInfo[] }>(
      "/output-styles",
      {
        signal: options.signal,
      },
    );
    return response.styles;
  }
}
