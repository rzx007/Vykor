import type { HttpTransport } from "@rzx/client";
import { isJsonObject, ProtocolDataError } from "@vykor/protocol";
import type { ClearMemoryInput, MemoryEntryRecord, PluginCatalogEntry, UpdateMemoryEntryInput } from "@vykor/protocol";
import type { CommandCatalogEntry } from "../workspace/types.js";
import type { FactReplacementResult, MemoryListResponse, ProjectFactRecord, StartDreamResponse } from "./types.js";

export class KnowledgeResource {
  constructor(private readonly transport: HttpTransport) {}

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

  /** `GET /facts?cwd=` — current project environment facts. */
  async listFacts(options: { cwd: string; signal?: AbortSignal }): Promise<{ facts: ProjectFactRecord[] }> {
    const { signal, ...query } = options;
    return await this.transport.request<{ facts: ProjectFactRecord[] }>(
      this.transport.path("/facts", query), { signal },
    );
  }

  /** `POST /facts/replace` — replace exactly one selected environment fact. */
  async replaceFact(
    input: { cwd: string; oldKey: string; newValue: string; sessionId?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<FactReplacementResult> {
    const response = await this.transport.request<{ result: FactReplacementResult }>(
      "/facts/replace", { method: "POST", body: input, signal: options.signal },
    );
    return response.result;
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
    options: { cwd: string; signal?: AbortSignal; expectedRevision?: string },
  ): Promise<void> {
    const { signal, cwd, expectedRevision } = options;
    await this.transport.request<{ deleted: boolean }>(
      this.transport.path(`/memory/${encodeURIComponent(entryId)}`, { cwd, expectedRevision }),
      { method: "DELETE", signal },
    );
  }

  async updateMemory(input: UpdateMemoryEntryInput, options: { signal?: AbortSignal } = {}): Promise<MemoryEntryRecord> {
    const { id, ...body } = input;
    const result = await this.transport.request<{ entry: MemoryEntryRecord }>(`/memory/${encodeURIComponent(id)}`, { method: "PATCH", body, signal: options.signal });
    return result.entry;
  }
  async clearMemory(input: ClearMemoryInput, options: { signal?: AbortSignal } = {}): Promise<{ deleted: number }> {
    return this.transport.request<{ deleted: number }>("/memory/clear", { method: "POST", body: input, signal: options.signal });
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

  /** `GET /context/composer-catalog?cwd=&sessionId=` */
  async getComposerCatalog({ cwd, sessionId, signal }: { cwd: string; sessionId?: string; signal?: AbortSignal }): Promise<{
    commands: CommandCatalogEntry[];
    plugins: PluginCatalogEntry[];
    contextUsage?: unknown;
  }> {
    const response = await this.transport.requestUnknown(this.transport.path("/context/composer-catalog", { cwd, sessionId }), { signal });
    if (!isJsonObject(response) || !Array.isArray(response.commands) || !response.commands.every(isCatalogCommand)
        || !Array.isArray(response.plugins) || !response.plugins.every(isCatalogPlugin)) {
      throw new ProtocolDataError("Invalid composer catalog response");
    }
    return { commands: response.commands, plugins: response.plugins, contextUsage: response.contextUsage };
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
}

function isCatalogCommand(value: unknown): value is CommandCatalogEntry {
  if (!isJsonObject(value) || typeof value.name !== "string") return false;
  if (!["displayName", "description", "argumentHint"].every((field) => value[field] === undefined || typeof value[field] === "string")) return false;
  if (value.source !== undefined && !["builtin", "bundled", "user", "plugin", "project"].some((source) => source === value.source)) return false;
  if (value.selection !== undefined && !["execute", "submenu", "insert"].some((selection) => selection === value.selection)) return false;
  if (value.requiresEmptyComposer !== undefined && typeof value.requiresEmptyComposer !== "boolean") return false;
  return value.kind === "session" && value.path === undefined && value.skillName === undefined
    || value.kind === "template" && typeof value.path === "string" && typeof value.skillName === "string";
}

function isCatalogPlugin(value: unknown): value is PluginCatalogEntry {
  return isJsonObject(value)
    && ["pluginId", "displayName", "version", "description"].every((field) => typeof value[field] === "string")
    && (value.icon === undefined || typeof value.icon === "string")
    && ["user", "managed", "project", "local"].some((scope) => scope === value.scope)
    && (value.origin === "native" || value.origin === "converted")
    && Array.isArray(value.capabilities)
    && value.capabilities.every((capability) => capability === "skills" || capability === "tools" || capability === "agents");
}
