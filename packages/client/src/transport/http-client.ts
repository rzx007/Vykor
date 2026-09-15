/**
 * daemon HTTP/SSE 客户端。
 *
 * 包装 `@openharness/server` 的 REST 路由与 `/events/stream` SSE；
 * 不含本地状态归并（见 `reducer.ts` / `sync.ts`）。
 */

import type {
  AdmitClientPromptInput,
  CommandCatalogEntry,
  CreateClientSessionInput,
  EditLatestClientPromptInput,
  CancelQueuedClientPromptInput,
  CancelQueuedPromptResponse,
  EventSyncOptions,
  ForkClientSessionInput,
  InterruptSessionResponse,
  ListClientMessagePartsOptions,
  ListCommandsOptions,
  ListEventsOptions,
  ListMessagesOptions,
  ListPermissionsOptions,
  ListSessionsOptions,
  ListProjectsOptions,
  ProjectRecord,
  AgentPersonaInfo,
  AuthStatus,
  CompactSessionResponse,
  CreateBackgroundShellInput,
  CreateBackgroundShellResult,
  CustomProviderInput,
  CreateScheduledTaskInput,
  HookInfo,
  ReloadPluginsResponse,
  RewindSessionResponse,
  McpServerStatus,
  MemoryEntryRecord,
  MemoryListResponse,
  ModelProviderInfo,
  OpenHarnessClientOptions,
  OpenHarnessServerHealth,
  PermissionRequestRecord,
  PluginInfo,
  PluginArchivePreview,
  PluginGitPreview,
  SkillSnapshot,
  PromoteQueuedClientPromptInput,
  PromoteQueuedPromptResponse,
  PromptResponse,
  ResumeInterruptedRunInput,
  ResumeInterruptedRunResponse,
  ProviderInfo,
  OutputStyleInfo,
  RememberSessionResponse,
  ScheduledRunRecord,
  ScheduledTaskRecord,
  ScheduledTaskStatusSummary,
  ReplyPermissionInput,
  SessionEventRecord,
  SessionExportResponse,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionStateSnapshot,
  SessionUsageResponse,
  StartDreamResponse,
  UpdateClientSessionInput,
  UpdateScheduledTaskInput,
  UploadAttachmentInput,
  DownloadAttachmentOptions,
  AttachmentAssetRecord,
  AttachmentStorageGcResult,
  AttachmentStorageRepairResult,
  AttachmentStorageReport,
} from "../types/index.js";
import type { CreateSessionGoalInput, GoalActionInput, SessionGoal, UpdateSessionGoalInput } from "@openharness/protocol";
import type {
  JobKind,
  JobReadResult,
  JobSnapshot,
  JobStatus,
  JobWaitResult,
  TerminalCreateRequest,
  TerminalEvent,
  TerminalReadResult,
  TerminalResizeRequest,
  TerminalSessionInfo,
  TerminalSignal,
  TerminalSource,
  TerminalWriteRequest,
  DurableChannelMessageInput,
  DurableChannelMessageResult,
  RecordChannelDeliveryInput,
  ChannelDeliveryRecord,
  ChannelStatusSnapshot,
  ClientProtocolSupport,
  ServerCapabilities,
} from "@openharness/protocol";
import {
  decodeJobReadResult,
  decodeJobSnapshot,
  decodeJobWaitResult,
  decodeSessionEventRecord,
  decodeSessionStateSnapshot,
  decodeTerminalEvent,
  decodeTerminalReadResult,
  decodeTerminalSessionInfo,
  ProtocolDataError,
  parseAttachmentAssetRecord,
} from "@openharness/protocol";

import {
  HttpTransport,
  OpenHarnessApiError,
  normalizeDaemonBaseUrl,
  responseField,
  responseArray,
  attachmentRangeHeader,
  isReadableStream,
} from "./http-transport.js";
import {
  SseTransport,
  streamServerSentEvents,
} from "./sse-transport.js";
import {
  ProtocolClient,
  IncompatibleProtocolError,
} from "../protocol/index.js";

export {
  HttpTransport,
  OpenHarnessApiError,
  normalizeDaemonBaseUrl,
  SseTransport,
  streamServerSentEvents,
  ProtocolClient,
  IncompatibleProtocolError,
};

let promptRequestCounter = 0;

/** Generate a caller-stable id for one prompt admission attempt. */
export function createPromptRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function")
    return globalThis.crypto.randomUUID();
  promptRequestCounter += 1;
  return `prompt-${Date.now().toString(36)}-${promptRequestCounter.toString(36)}`;
}

/**
 * 面向 daemon 的 typed fetch 客户端。
 * 构造时传入 `baseUrl` 与可选 Bearer `token`（通常来自 daemon registry）。
 */
export class OpenHarnessClient {
  readonly transport: HttpTransport;
  readonly sse: SseTransport;
  readonly protocol: ProtocolClient;

  constructor(options: OpenHarnessClientOptions) {
    this.transport = new HttpTransport(options);
    this.sse = new SseTransport(this.transport.fetchImpl);
    this.protocol = new ProtocolClient(this.transport);
  }

  get baseUrl(): string {
    return this.transport.baseUrl;
  }

  get token(): string | undefined {
    return this.transport.token;
  }

  get fetchImpl(): typeof fetch {
    return this.transport.fetchImpl;
  }

  /** `GET /health` */
  async health(
    options: { signal?: AbortSignal } = {},
  ): Promise<OpenHarnessServerHealth> {
    return this.protocol.health(options);
  }

  /** 连接产品应先调用它，再根据 features 决定显示哪些功能。 */
  async capabilities(
    options: { signal?: AbortSignal; support?: ClientProtocolSupport } = {},
  ): Promise<ServerCapabilities> {
    return this.protocol.capabilities(options);
  }

  /** `POST /attachments` — upload bytes without JSON or multipart buffering. */
  async uploadAttachment(
    input: UploadAttachmentInput,
  ): Promise<AttachmentAssetRecord> {
    const headers: Record<string, string> = {};
    headers["x-openharness-filename"] = encodeURIComponent(input.displayName);
    if (input.mediaType) headers["content-type"] = input.mediaType;
    const response = await this.transport.requestResponse("/attachments", {
      method: "POST",
      headers,
      body: input.body as RequestInit["body"],
      signal: input.signal,
    });
    return parseAttachmentAssetRecord(await response.json());
  }

  async getAttachment(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AttachmentAssetRecord> {
    const value = await this.request<unknown>(
      `/attachments/${encodeURIComponent(id)}`,
      { signal: options.signal },
    );
    return parseAttachmentAssetRecord(value);
  }

  /** Returns the raw response so callers can consume the body as a stream. */
  async downloadAttachment(
    id: string,
    options: DownloadAttachmentOptions = {},
  ): Promise<Response> {
    const range = attachmentRangeHeader(options.range);
    const headers: Record<string, string> = {};
    if (range) headers.range = range;
    return await this.transport.requestResponse(
      `/attachments/${encodeURIComponent(id)}/content`,
      { method: "GET", headers, signal: options.signal },
    );
  }

  async deleteAttachment(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AttachmentAssetRecord> {
    const value = await this.request<unknown>(
      `/attachments/${encodeURIComponent(id)}`,
      { method: "DELETE", signal: options.signal },
    );
    return parseAttachmentAssetRecord(value);
  }

  async scanAttachmentStorage(
    options: { signal?: AbortSignal } = {},
  ): Promise<AttachmentStorageReport> {
    return await this.request<AttachmentStorageReport>("/attachments/storage", {
      signal: options.signal,
    });
  }

  async repairAttachmentStorage(
    options: { signal?: AbortSignal } = {},
  ): Promise<AttachmentStorageRepairResult> {
    return await this.request<AttachmentStorageRepairResult>(
      "/attachments/storage/actions",
      {
        method: "POST",
        body: { action: "repair-safe" },
        signal: options.signal,
      },
    );
  }

  async gcAttachmentStorage(
    options: { signal?: AbortSignal } = {},
  ): Promise<AttachmentStorageGcResult> {
    return await this.request<AttachmentStorageGcResult>(
      "/attachments/storage/actions",
      {
        method: "POST",
        body: { action: "gc" },
        signal: options.signal,
      },
    );
  }

  async handleChannelMessage(
    input: DurableChannelMessageInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<DurableChannelMessageResult> {
    return await this.request<DurableChannelMessageResult>(
      "/channels/messages",
      { method: "POST", body: input, signal: options.signal },
    );
  }

  async recordChannelDelivery(
    deliveryId: string,
    input: RecordChannelDeliveryInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ChannelDeliveryRecord> {
    const response = await this.request<{ delivery: ChannelDeliveryRecord }>(
      `/channels/deliveries/${encodeURIComponent(deliveryId)}/result`,
      { method: "POST", body: input, signal: options.signal },
    );
    return response.delivery;
  }

  async getChannelStatus(
    options: { connector?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ChannelStatusSnapshot> {
    const { signal, ...query } = options;
    return await this.request<ChannelStatusSnapshot>(
      this.path("/channels/status", query),
      { signal },
    );
  }

  async listPendingChannelDeliveries(
    options: { connector?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ChannelDeliveryRecord[]> {
    const { signal, ...query } = options;
    const response = await this.request<{
      deliveries: ChannelDeliveryRecord[];
    }>(this.path("/channels/deliveries/pending", query), { signal });
    return response.deliveries;
  }

  /** `GET /commands?cwd=` — cwd-scoped slash command catalog for autocomplete. */
  async listCommands(
    options: ListCommandsOptions & { signal?: AbortSignal },
  ): Promise<CommandCatalogEntry[]> {
    const { signal, ...query } = options;
    const response = await this.request<{ commands: CommandCatalogEntry[] }>(
      this.path("/commands", query),
      { signal },
    );
    return response.commands;
  }

  /** `GET /settings` */
  async getSettings(
    options: { signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.request<{ settings: Record<string, unknown> }>(
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
    const response = await this.request<{ settings: Record<string, unknown> }>(
      "/settings",
      {
        method: "PATCH",
        body: patch,
        signal: options.signal,
      },
    );
    return response.settings;
  }

  /** `GET /providers` */
  async listProviders(
    options: { signal?: AbortSignal } = {},
  ): Promise<ProviderInfo[]> {
    const response = await this.request<{ providers: ProviderInfo[] }>(
      "/providers",
      { signal: options.signal },
    );
    return response.providers;
  }

  async createCustomProvider(
    input: CustomProviderInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ProviderInfo> {
    const response = await this.request<{ provider: ProviderInfo }>(
      "/providers/custom",
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
    return response.provider;
  }

  async connectCatalogProvider(
    id: string,
    apiKey: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ProviderInfo> {
    const response = await this.request<{ provider: ProviderInfo }>(
      `/providers/catalog/${encodeURIComponent(id)}/connect`,
      { method: "POST", body: { apiKey }, signal: options.signal },
    );
    return response.provider;
  }

  async disconnectCatalogProvider(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.request<{ ok: true }>(
      `/providers/catalog/${encodeURIComponent(id)}/connect`,
      { method: "DELETE", signal: options.signal },
    );
  }

  async updateCustomProvider(
    id: string,
    input: CustomProviderInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ProviderInfo> {
    const response = await this.request<{ provider: ProviderInfo }>(
      `/providers/custom/${encodeURIComponent(id)}`,
      { method: "PATCH", body: input, signal: options.signal },
    );
    return response.provider;
  }

  async removeCustomProvider(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.request<{ ok: true }>(
      `/providers/custom/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        signal: options.signal,
      },
    );
  }

  /** `GET /models` */
  async listModels(
    options: { signal?: AbortSignal } = {},
  ): Promise<ModelProviderInfo[]> {
    const response = await this.request<{ providers: ModelProviderInfo[] }>(
      "/models",
      { signal: options.signal },
    );
    return response.providers;
  }

  /** `GET /sessions/:id/mcp` */
  async getSessionMcp(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<McpServerStatus[]> {
    const response = await this.request<{ servers: McpServerStatus[] }>(
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
    return await this.request<MemoryListResponse>(this.path("/memory", query), {
      signal,
    });
  }

  /** `GET /memory/:id?cwd=` */
  async getMemory(
    entryId: string,
    options: { cwd: string; signal?: AbortSignal },
  ): Promise<MemoryEntryRecord> {
    const { signal, cwd } = options;
    const response = await this.request<{ entry: MemoryEntryRecord }>(
      this.path(`/memory/${encodeURIComponent(entryId)}`, { cwd }),
      { signal },
    );
    return response.entry;
  }

  /** `POST /memory` */
  async addMemory(
    input: { cwd: string; content: string; tags?: string[] },
    options: { signal?: AbortSignal } = {},
  ): Promise<MemoryEntryRecord> {
    const response = await this.request<{ entry: MemoryEntryRecord }>(
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
    await this.request<{ deleted: boolean }>(
      this.path(`/memory/${encodeURIComponent(entryId)}`, { cwd }),
      { method: "DELETE", signal },
    );
  }

  /** `GET /auth` */
  async getAuthStatus(
    options: { signal?: AbortSignal } = {},
  ): Promise<AuthStatus> {
    const response = await this.request<{ auth: AuthStatus }>("/auth", {
      signal: options.signal,
    });
    return response.auth;
  }

  /** `POST /auth/login` */
  async authLogin(
    input: { provider: string; apiKey?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return await this.request<{ message: string }>("/auth/login", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  /** `POST /auth/logout` */
  async authLogout(
    input: { provider: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return await this.request<{ message: string }>("/auth/logout", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  /** `GET /context/plugins?cwd=` — safe plugin picker metadata. */
  async listContextPlugins(options: { cwd: string; signal?: AbortSignal }): Promise<import("@openharness/protocol").PluginCatalogEntry[]> {
    const { signal, ...query } = options;
    const response = await this.request<{ plugins: import("@openharness/protocol").PluginCatalogEntry[] }>(
      this.path("/context/plugins", query), { signal },
    );
    return response.plugins;
  }

  /** `GET /context?cwd=` */
  async getContextPreview(options: {
    cwd: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const { signal, ...query } = options;
    const response = await this.request<{ report: string }>(
      this.path("/context", query),
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
    const response = await this.request<{ report: string }>(
      this.path("/context/status", query),
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
    return await this.request<{ snapshot: unknown; report: string }>(
      this.path("/context/usage", query),
      { signal },
    );
  }

  /** `POST /sessions/:id/compact` */
  async compactSession(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<CompactSessionResponse> {
    return await this.request<CompactSessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/compact`,
      { method: "POST", signal: options.signal },
    );
  }

  async getSessionGoal(sessionId: string): Promise<SessionGoal | null> {
    const response = await this.request<{ goal: SessionGoal | null }>(`/sessions/${encodeURIComponent(sessionId)}/goal`);
    return response.goal;
  }

  async createSessionGoal(sessionId: string, input: CreateSessionGoalInput): Promise<SessionGoal> {
    const response = await this.request<{ goal: SessionGoal }>(`/sessions/${encodeURIComponent(sessionId)}/goals`, { method: "POST", body: input });
    return response.goal;
  }

  async updateSessionGoal(sessionId: string, goalId: string, input: UpdateSessionGoalInput): Promise<SessionGoal> {
    const response = await this.request<{ goal: SessionGoal }>(`/sessions/${encodeURIComponent(sessionId)}/goals/${encodeURIComponent(goalId)}`, { method: "PATCH", body: input });
    return response.goal;
  }

  async applySessionGoalAction(sessionId: string, goalId: string, input: GoalActionInput): Promise<SessionGoal> {
    const response = await this.request<{ goal: SessionGoal }>(`/sessions/${encodeURIComponent(sessionId)}/goals/${encodeURIComponent(goalId)}/actions`, { method: "POST", body: input });
    return response.goal;
  }

  /** `POST /sessions/:id/rewind` */
  async rewindSession(
    sessionId: string,
    input: { count?: number } = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<RewindSessionResponse> {
    return await this.request<RewindSessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/rewind`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  /** `POST /sessions/:id/remember` */
  async rememberSession(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<RememberSessionResponse> {
    return await this.request<RememberSessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/remember`,
      { method: "POST", signal: options.signal },
    );
  }

  /** `POST /dream` */
  async startDream(
    input: { cwd: string; sessionId?: string; preview?: boolean },
    options: { signal?: AbortSignal } = {},
  ): Promise<StartDreamResponse> {
    return await this.request<StartDreamResponse>("/dream", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  /** `GET /profile` */
  async getProfileStatus(
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const response = await this.request<{ report: string }>("/profile", {
      signal: options.signal,
    });
    return response.report;
  }

  /** `POST /profile/init` */
  async initProfile(options: { signal?: AbortSignal } = {}): Promise<string> {
    const response = await this.request<{ report: string }>("/profile/init", {
      method: "POST",
      signal: options.signal,
    });
    return response.report;
  }

  /** `GET /output-styles` */
  async listOutputStyles(
    options: { signal?: AbortSignal } = {},
  ): Promise<OutputStyleInfo[]> {
    const response = await this.request<{ styles: OutputStyleInfo[] }>(
      "/output-styles",
      {
        signal: options.signal,
      },
    );
    return response.styles;
  }

  /** `POST /project/init` */
  async initProject(
    input: { cwd: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const response = await this.request<{ report: string }>("/project/init", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
    return response.report;
  }

  /** `GET /plugins?cwd=` */
  async listPlugins(options: { cwd: string; signal?: AbortSignal }): Promise<{
    plugins: PluginInfo[];
    warnings: string[];
  }> {
    const { signal, ...query } = options;
    return await this.request<{ plugins: PluginInfo[]; warnings: string[] }>(
      this.path("/plugins", query),
      { signal },
    );
  }

  /** `POST /plugins/:id/enable` */
  async enablePlugin(
    id: string,
    input: { cwd: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return await this.request<{ message: string }>(
      `/plugins/${encodeURIComponent(id)}/enable`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  /** `POST /plugins/:id/disable` */
  async disablePlugin(
    id: string,
    input: { cwd: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return await this.request<{ message: string }>(
      `/plugins/${encodeURIComponent(id)}/disable`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  async installLocalPlugin(input: {
    cwd: string;
    sourcePath: string;
    scope: "user";
    approvedPermissions: string[];
    link?: boolean;
  }): Promise<{ message: string }> {
    return await this.request<{ message: string }>(
      input.link ? "/plugins/link-local" : "/plugins/install-local",
      { method: "POST", body: input },
    );
  }

  /** `POST /plugins/archive/preview` */
  async previewPluginArchive(
    input: { cwd: string; archivePath: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginArchivePreview> {
    return await this.request<PluginArchivePreview>("/plugins/archive/preview", {
      method: "POST", body: input, signal: options.signal,
    });
  }

  /** `POST /plugins/archive/install` */
  async installPluginArchive(
    input: { cwd: string; archivePath: string; expectedArchiveDigest: string; approvedPermissions: string[] },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return await this.request<{ message: string }>("/plugins/archive/install", {
      method: "POST", body: input, signal: options.signal,
    });
  }

  /** `POST /plugins/git/preview` */
  async previewPluginGit(
    input: { cwd: string; url: string; ref?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginGitPreview> {
    return await this.request<PluginGitPreview>("/plugins/git/preview", {
      method: "POST", body: input, signal: options.signal,
    });
  }

  /** `POST /plugins/git/install` */
  async installPluginGit(
    input: { cwd: string; url: string; ref?: string; expectedSourceDigest: string; approvedPermissions: string[] },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return await this.request<{ message: string }>("/plugins/git/install", {
      method: "POST", body: input, signal: options.signal,
    });
  }

  async uninstallPlugin(
    id: string,
    input: { cwd: string },
  ): Promise<{ message: string }> {
    return await this.request<{ message: string }>(
      `/plugins/${encodeURIComponent(id)}`,
      { method: "DELETE", body: input },
    );
  }

  /** `POST /plugins/reload` */
  async reloadPlugins(
    input: { cwd: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<ReloadPluginsResponse> {
    return await this.request<ReloadPluginsResponse>("/plugins/reload", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  /** `GET /skills` */
  async listSkills(
    options: { signal?: AbortSignal } = {},
  ): Promise<SkillSnapshot> {
    return await this.request<SkillSnapshot>("/skills", {
      signal: options.signal,
    });
  }

  /** `DELETE /skills/:id` */
  async removeSkill(
    id: string,
    input: { expectedContent: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<SkillSnapshot> {
    return await this.request<SkillSnapshot>(
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
    const response = await this.request<{ agents: AgentPersonaInfo[] }>(
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
    const response = await this.request<{ hooks: HookInfo[] }>(
      this.path("/hooks", query),
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
    const response = await this.request<{ output: string }>(
      this.path("/git/diff", { cwd, ...(full ? { full: "true" } : {}) }),
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
    const response = await this.request<{ output: string }>(
      this.path("/git/branch", { cwd, ...(list ? { list: "true" } : {}) }),
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
    const response = await this.request<{ output: string }>(
      this.path("/git/status", { cwd }),
      { signal },
    );
    return response.output;
  }

  /** `POST /git/commit` */
  async gitCommit(
    input: { cwd: string; message: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const response = await this.request<{ output: string }>("/git/commit", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
    return response.output;
  }

  /** `GET /sessions/:id/usage` */
  async getSessionUsage(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionUsageResponse> {
    return await this.request<SessionUsageResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/usage`,
      { signal: options.signal },
    );
  }

  /** `POST /sessions/:id/export` */
  async exportSession(
    sessionId: string,
    input: { filename?: string; json?: boolean } = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionExportResponse> {
    return await this.request<SessionExportResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/export`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  /** `GET /sessions` */
  async listSessions(
    options: ListSessionsOptions & { signal?: AbortSignal } = {},
  ): Promise<SessionRecord[]> {
    const { signal, ...query } = options;
    const response = await this.request<{ sessions: SessionRecord[] }>(
      this.path("/sessions", query),
      { signal },
    );
    return response.sessions;
  }

  async listProjects(
    options: ListProjectsOptions & { signal?: AbortSignal } = {},
  ): Promise<ProjectRecord[]> {
    const { signal, ...query } = options;
    const response = await this.request<{ projects: ProjectRecord[] }>(
      this.path("/projects", query),
      { signal },
    );
    return response.projects;
  }

  async inspectProject(path: string): Promise<ProjectRecord> {
    return (
      await this.request<{ project: ProjectRecord }>("/projects/inspect", {
        method: "POST",
        body: { path },
      })
    ).project;
  }

  async renameProject(projectId: string, name: string): Promise<ProjectRecord> {
    return (
      await this.request<{ project: ProjectRecord }>(
        `/projects/${encodeURIComponent(projectId)}`,
        { method: "PATCH", body: { name } },
      )
    ).project;
  }

  async setProjectPinned(
    projectId: string,
    pinned: boolean,
  ): Promise<ProjectRecord> {
    return (
      await this.request<{ project: ProjectRecord }>(
        `/projects/${encodeURIComponent(projectId)}`,
        { method: "PATCH", body: { pinned } },
      )
    ).project;
  }

  async setProjectDefaultShell(
    projectId: string,
    defaultShell: string | null,
  ): Promise<ProjectRecord> {
    return (
      await this.request<{ project: ProjectRecord }>(
        `/projects/${encodeURIComponent(projectId)}`,
        { method: "PATCH", body: { defaultShell } },
      )
    ).project;
  }

  async rebindProject(projectId: string, path: string): Promise<ProjectRecord> {
    return (
      await this.request<{ project: ProjectRecord }>(
        `/projects/${encodeURIComponent(projectId)}/rebind`,
        { method: "POST", body: { path } },
      )
    ).project;
  }

  async archiveProject(projectId: string): Promise<ProjectRecord> {
    return (
      await this.request<{ project: ProjectRecord }>(
        `/projects/${encodeURIComponent(projectId)}`,
        { method: "DELETE" },
      )
    ).project;
  }

  /** `POST /sessions` */
  async createSession(
    input: CreateClientSessionInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionRecord> {
    const response = await this.request<{ session: SessionRecord }>(
      "/sessions",
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
    return response.session;
  }

  /** `GET /sessions/:id` */
  async getSession(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionRecord> {
    const response = await this.request<{ session: SessionRecord }>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      {
        signal: options.signal,
      },
    );
    return response.session;
  }

  /** `POST /sessions/:id/fork` */
  async forkSession(
    sessionId: string,
    input: ForkClientSessionInput = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionRecord> {
    const response = await this.request<{ session: SessionRecord }>(
      `/sessions/${encodeURIComponent(sessionId)}/fork`,
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
    return response.session;
  }

  /** `GET /sessions/:id/state` - atomic attach snapshot plus SSE cursor. */
  async getSessionState(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionStateSnapshot> {
    const response = await this.request<unknown>(
      `/sessions/${encodeURIComponent(sessionId)}/state`,
      {
        signal: options.signal,
      },
    );
    return decodeSessionStateSnapshot(response);
  }

  /** `DELETE /sessions/:id` */
  async archiveSession(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionRecord> {
    const response = await this.request<{ session: SessionRecord }>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "DELETE",
        signal: options.signal,
      },
    );
    return response.session;
  }

  /** `DELETE /sessions/:id/hard` */
  async deleteSession(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string[]> {
    const response = await this.request<{ deletedSessionIds: string[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/hard`,
      {
        method: "DELETE",
        signal: options.signal,
      },
    );
    return response.deletedSessionIds;
  }

  /** `PATCH /sessions/:id` - update title, agent, or metadata.runtime fields. */
  async updateSession(
    sessionId: string,
    input: UpdateClientSessionInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionRecord> {
    const response = await this.request<{ session: SessionRecord }>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "PATCH",
        body: input,
        signal: options.signal,
      },
    );
    return response.session;
  }

  /** `GET /sessions/:id/messages` */
  async listMessages(
    sessionId: string,
    options: ListMessagesOptions & { signal?: AbortSignal } = {},
  ): Promise<SessionMessageRecord[]> {
    const { signal, ...query } = options;
    const response = await this.request<{ messages: SessionMessageRecord[] }>(
      this.path(`/sessions/${encodeURIComponent(sessionId)}/messages`, query),
      { signal },
    );
    return response.messages;
  }

  /** `GET /sessions/:id/parts` */
  async listMessageParts(
    sessionId: string,
    options: ListClientMessagePartsOptions & { signal?: AbortSignal } = {},
  ): Promise<SessionMessagePartRecord[]> {
    const { signal, ...query } = options;
    const response = await this.request<{ parts: SessionMessagePartRecord[] }>(
      this.path(`/sessions/${encodeURIComponent(sessionId)}/parts`, query),
      { signal },
    );
    return response.parts;
  }

  /** `POST /sessions/:id/prompts` — 提交用户输入并触发/排队一次 run。 */
  async admitPrompt(
    sessionId: string,
    input: AdmitClientPromptInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PromptResponse> {
    return await this.request<PromptResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/prompts`,
      {
        method: "POST",
        body: { ...input, id: input.id ?? createPromptRequestId() },
        signal: options.signal,
      },
    );
  }

  /** `POST /sessions/:id/prompts/latest/edit` */
  async editLatestPrompt(
    sessionId: string,
    input: EditLatestClientPromptInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PromptResponse> {
    return await this.request<PromptResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/prompts/latest/edit`,
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
  }

  /** Promote one durable queued prompt into the exact active run. */
  async promoteQueuedPrompt(
    sessionId: string,
    inputId: string,
    input: PromoteQueuedClientPromptInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PromoteQueuedPromptResponse> {
    return await this.request<PromoteQueuedPromptResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(inputId)}/promote`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  /** Cancel one durable prompt that is still waiting in the run queue. */
  async cancelQueuedPrompt(
    sessionId: string,
    inputId: string,
    input: CancelQueuedClientPromptInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<CancelQueuedPromptResponse> {
    return await this.request<CancelQueuedPromptResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(inputId)}/cancel`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  /**
   * `POST /sessions/:id/runs/:runId/resume` — 显式重放一次中断 run 的原始 prompt。
   * 不会继续旧 provider stream；服务端会创建一个带恢复溯源的新 input/run。
   */
  async resumeInterruptedRun(
    sessionId: string,
    runId: string,
    input: ResumeInterruptedRunInput = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<ResumeInterruptedRunResponse> {
    return await this.request<ResumeInterruptedRunResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/resume`,
      {
        method: "POST",
        body: { ...input, id: input.id ?? createPromptRequestId() },
        signal: options.signal,
      },
    );
  }

  /** `POST /sessions/:id/interrupt` — 中断当前/排队中的 run。 */
  async interruptSession(
    sessionId: string,
    options: { signal?: AbortSignal; expectedRunId?: string } = {},
  ): Promise<InterruptSessionResponse> {
    return await this.request<InterruptSessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/interrupt`,
      {
        method: "POST",
        body: options.expectedRunId
          ? { expectedRunId: options.expectedRunId }
          : undefined,
        signal: options.signal,
      },
    );
  }

  /** `GET /events` — 用于 attach 时的历史 replay。 */
  async listEvents(
    options: ListEventsOptions & { signal?: AbortSignal } = {},
  ): Promise<SessionEventRecord[]> {
    const { signal, ...query } = options;
    const response = await this.request<unknown>(this.path("/events", query), {
      signal,
    });
    return responseArray(response, "events", decodeSessionEventRecord);
  }

  /** `GET /permissions` */
  async listPermissions(
    options: ListPermissionsOptions & { signal?: AbortSignal } = {},
  ): Promise<PermissionRequestRecord[]> {
    const { signal, ...query } = options;
    const response = await this.request<{
      requests: PermissionRequestRecord[];
    }>(this.path("/permissions", query), { signal });
    return response.requests;
  }

  /** `POST /permissions/:id/reply` — 批准/拒绝工具权限请求。 */
  async replyPermission(
    requestId: string,
    input: ReplyPermissionInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PermissionRequestRecord> {
    const response = await this.request<{ request: PermissionRequestRecord }>(
      `/permissions/${encodeURIComponent(requestId)}/reply`,
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
    return response.request;
  }

  async getScheduledTaskStatus(
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduledTaskStatusSummary> {
    return await this.request<ScheduledTaskStatusSummary>("/schedules/status", {
      signal: options.signal,
    });
  }

  async listScheduledTasks(
    options: {
      status?: ScheduledTaskRecord["status"];
      signal?: AbortSignal;
    } = {},
  ): Promise<ScheduledTaskRecord[]> {
    const { signal, ...query } = options;
    const response = await this.request<{ tasks: ScheduledTaskRecord[] }>(
      this.path("/schedules/tasks", query),
      { signal },
    );
    return response.tasks;
  }

  async getScheduledTask(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduledTaskRecord> {
    const response = await this.request<{ task: ScheduledTaskRecord }>(
      `/schedules/tasks/${encodeURIComponent(id)}`,
      { signal: options.signal },
    );
    return response.task;
  }

  async createScheduledTask(
    input: CreateScheduledTaskInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduledTaskRecord> {
    const response = await this.request<{ task: ScheduledTaskRecord }>(
      "/schedules/tasks",
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
    return response.task;
  }

  async updateScheduledTask(
    id: string,
    input: UpdateScheduledTaskInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduledTaskRecord> {
    const response = await this.request<{ task: ScheduledTaskRecord }>(
      `/schedules/tasks/${encodeURIComponent(id)}`,
      { method: "PATCH", body: input, signal: options.signal },
    );
    return response.task;
  }

  async removeScheduledTask(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.request<{ removed: true }>(
      `/schedules/tasks/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        signal: options.signal,
      },
    );
  }

  async triggerScheduledTask(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduledRunRecord> {
    const response = await this.request<{ run: ScheduledRunRecord }>(
      `/schedules/tasks/${encodeURIComponent(id)}/run`,
      { method: "POST", signal: options.signal },
    );
    return response.run;
  }

  async listScheduledRuns(
    options: {
      taskId?: string;
      unread?: boolean;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ScheduledRunRecord[]> {
    const { signal, ...query } = options;
    const response = await this.request<{ runs: ScheduledRunRecord[] }>(
      this.path("/schedules/runs", query),
      { signal },
    );
    return response.runs;
  }

  async setScheduledRunUnread(
    id: string,
    unread: boolean,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduledRunRecord> {
    const response = await this.request<{ run: ScheduledRunRecord }>(
      `/schedules/runs/${encodeURIComponent(id)}/read`,
      { method: "PATCH", body: { unread }, signal: options.signal },
    );
    return response.run;
  }

  async createTerminal(
    input: TerminalCreateRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<TerminalSessionInfo> {
    const response = await this.request<unknown>("/terminals", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
    return decodeTerminalSessionInfo(responseField(response, "terminal"));
  }

  async listJobs(options: {
    sessionId: string;
    kinds?: JobKind[];
    statuses?: JobStatus[];
    startedAfter?: number;
    startedBefore?: number;
    updatedAfter?: number;
    updatedBefore?: number;
    includeFinished?: boolean;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<JobSnapshot[]> {
    const { signal, kinds, statuses, includeFinished, ...query } = options;
    const response = await this.request<unknown>(
      this.path("/jobs", {
        ...query,
        ...(kinds ? { kinds: kinds.join(",") } : {}),
        ...(statuses ? { statuses: statuses.join(",") } : {}),
        ...(includeFinished !== undefined
          ? { includeFinished: String(includeFinished) }
          : {}),
      }),
      { signal },
    );
    return responseArray(response, "jobs", decodeJobSnapshot);
  }

  async createBackgroundShell(
    input: CreateBackgroundShellInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<CreateBackgroundShellResult> {
    return await this.request<CreateBackgroundShellResult>(
      "/background-shells",
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
  }

  async readJob(
    jobId: string,
    options: {
      sessionId: string;
      after?: number;
      maxChars?: number;
      signal?: AbortSignal;
    },
  ): Promise<JobReadResult> {
    const { signal, ...query } = options;
    const response = await this.request<unknown>(
      this.path(`/jobs/${encodeURIComponent(jobId)}`, query),
      { signal },
    );
    return decodeJobReadResult(response);
  }

  async waitJob(
    jobId: string,
    input: {
      sessionId: string;
      timeoutMs?: number;
      after?: number;
      maxChars?: number;
    },
    options: { signal?: AbortSignal } = {},
  ): Promise<JobWaitResult> {
    const response = await this.request<unknown>(
      `/jobs/${encodeURIComponent(jobId)}/wait`,
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
    return decodeJobWaitResult(response);
  }

  async sendJob(
    jobId: string,
    input: { sessionId: string; data: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.request(`/jobs/${encodeURIComponent(jobId)}/input`, {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  async cancelJob(
    jobId: string,
    input: { sessionId: string; reason?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<JobSnapshot> {
    const response = await this.request<unknown>(
      `/jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST", body: input, signal: options.signal },
    );
    return decodeJobSnapshot(responseField(response, "snapshot"));
  }

  async listTerminals(
    options: {
      projectId?: string;
      sessionId?: string;
      source?: TerminalSource;
      signal?: AbortSignal;
    } = {},
  ): Promise<TerminalSessionInfo[]> {
    const { signal, ...query } = options;
    const response = await this.request<unknown>(
      this.path("/terminals", query),
      { signal },
    );
    return responseArray(response, "terminals", decodeTerminalSessionInfo);
  }

  async getTerminal(
    terminalId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TerminalSessionInfo> {
    const response = await this.request<unknown>(
      `/terminals/${encodeURIComponent(terminalId)}`,
      { signal: options.signal },
    );
    return decodeTerminalSessionInfo(responseField(response, "terminal"));
  }

  async readTerminal(
    terminalId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TerminalReadResult> {
    const response = await this.request<unknown>(
      `/terminals/${encodeURIComponent(terminalId)}/output`,
      { signal: options.signal },
    );
    return decodeTerminalReadResult(responseField(response, "snapshot"));
  }

  async writeTerminal(
    input: TerminalWriteRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.request<{ written: true }>(
      `/terminals/${encodeURIComponent(input.terminalId)}/input`,
      { method: "POST", body: { data: input.data }, signal: options.signal },
    );
  }

  async resizeTerminal(
    input: TerminalResizeRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.request<{ resized: true }>(
      `/terminals/${encodeURIComponent(input.terminalId)}/resize`,
      {
        method: "POST",
        body: { cols: input.cols, rows: input.rows },
        signal: options.signal,
      },
    );
  }

  async signalTerminal(
    terminalId: string,
    signal: TerminalSignal,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.request<{ signaled: true }>(
      `/terminals/${encodeURIComponent(terminalId)}/signal`,
      { method: "POST", body: { signal }, signal: options.signal },
    );
  }

  async closeTerminal(
    terminalId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.request<{ removed: true }>(
      `/terminals/${encodeURIComponent(terminalId)}`,
      {
        method: "DELETE",
        signal: options.signal,
      },
    );
  }

  streamTerminalEvents(
    options: { signal?: AbortSignal } = {},
  ): AsyncIterable<TerminalEvent> {
    return this.sse.stream(
      this.transport.resolveUrl("/terminals/stream"),
      {
        headers: this.transport.headers(),
        signal: options.signal,
        decode: decodeTerminalEvent,
      },
    );
  }

  streamEvents(
    options: EventSyncOptions = {},
  ): AsyncIterable<SessionEventRecord> {
    const query = {
      cursor: options.cursor,
      sessionId: options.sessionId,
    };
    return this.sse.stream(
      this.transport.resolveUrl("/events/stream", query),
      {
        headers: this.transport.headers(),
        signal: options.signal,
        decode: decodeSessionEventRecord,
      },
    );
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
      auth?: boolean;
    } = {},
  ): Promise<T> {
    return this.transport.request<T>(path, options);
  }

  private headers(json = false, auth = true): Record<string, string> {
    return this.transport.headers(json, auth);
  }

  /** 拼 query；跳过 undefined / null / false。 */
  private path(pathname: string, query: Record<string, unknown> = {}): string {
    return this.transport.path(pathname, query);
  }

  private async throwResponseError(response: Response): Promise<never> {
    return this.transport.throwResponseError(response);
  }
}
