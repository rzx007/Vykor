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
import {
  SystemResource,
  ProviderResource,
  AuthResource,
  ProjectResource,
  PluginResource,
  DevelopmentResource,
  SessionResource,
  AttachmentResource,
  PermissionResource,
  ScheduleResource,
  JobResource,
  TerminalResource,
  ChannelResource,
  EventResource,
  createPromptRequestId,
} from "../resources/index.js";

export {
  HttpTransport,
  OpenHarnessApiError,
  normalizeDaemonBaseUrl,
  SseTransport,
  streamServerSentEvents,
  ProtocolClient,
  IncompatibleProtocolError,
  SystemResource,
  ProviderResource,
  AuthResource,
  ProjectResource,
  PluginResource,
  DevelopmentResource,
  SessionResource,
  AttachmentResource,
  PermissionResource,
  ScheduleResource,
  JobResource,
  TerminalResource,
  ChannelResource,
  EventResource,
  createPromptRequestId,
};

/**
 * 面向 daemon 的 typed fetch 客户端。
 * 构造时传入 `baseUrl` 与可选 Bearer `token`（通常来自 daemon registry）。
 */
export class OpenHarnessClient {
  readonly transport: HttpTransport;
  readonly sse: SseTransport;
  readonly protocol: ProtocolClient;
  readonly system: SystemResource;
  readonly providers: ProviderResource;
  readonly auth: AuthResource;
  readonly projects: ProjectResource;
  readonly plugins: PluginResource;
  readonly development: DevelopmentResource;
  readonly sessions: SessionResource;
  readonly attachments: AttachmentResource;
  readonly permissions: PermissionResource;
  readonly schedules: ScheduleResource;
  readonly jobs: JobResource;
  readonly terminals: TerminalResource;
  readonly channels: ChannelResource;
  readonly events: EventResource;

  constructor(options: OpenHarnessClientOptions) {
    this.transport = new HttpTransport(options);
    this.sse = new SseTransport(this.transport.fetchImpl);
    this.protocol = new ProtocolClient(this.transport);
    this.system = new SystemResource(this.transport);
    this.providers = new ProviderResource(this.transport);
    this.auth = new AuthResource(this.transport);
    this.projects = new ProjectResource(this.transport);
    this.plugins = new PluginResource(this.transport);
    this.development = new DevelopmentResource(this.transport);
    this.sessions = new SessionResource(this.transport);
    this.attachments = new AttachmentResource(this.transport);
    this.permissions = new PermissionResource(this.transport);
    this.schedules = new ScheduleResource(this.transport);
    this.jobs = new JobResource(this.transport);
    this.terminals = new TerminalResource(this.transport, this.sse);
    this.channels = new ChannelResource(this.transport);
    this.events = new EventResource(this.transport, this.sse);
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
    return this.attachments.upload(input);
  }

  async getAttachment(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AttachmentAssetRecord> {
    return this.attachments.get(id, options);
  }

  /** Returns the raw response so callers can consume the body as a stream. */
  async downloadAttachment(
    id: string,
    options: DownloadAttachmentOptions = {},
  ): Promise<Response> {
    return this.attachments.download(id, options);
  }

  async deleteAttachment(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AttachmentAssetRecord> {
    return this.attachments.delete(id, options);
  }

  async scanAttachmentStorage(
    options: { signal?: AbortSignal } = {},
  ): Promise<AttachmentStorageReport> {
    return this.attachments.scanStorage(options);
  }

  async repairAttachmentStorage(
    options: { signal?: AbortSignal } = {},
  ): Promise<AttachmentStorageRepairResult> {
    return this.attachments.repairStorage(options);
  }

  async gcAttachmentStorage(
    options: { signal?: AbortSignal } = {},
  ): Promise<AttachmentStorageGcResult> {
    return this.attachments.gcStorage(options);
  }

  async handleChannelMessage(
    input: DurableChannelMessageInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<DurableChannelMessageResult> {
    return this.channels.handleMessage(input, options);
  }

  async recordChannelDelivery(
    deliveryId: string,
    input: RecordChannelDeliveryInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ChannelDeliveryRecord> {
    return this.channels.recordDelivery(deliveryId, input, options);
  }

  async getChannelStatus(
    options: { connector?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ChannelStatusSnapshot> {
    return this.channels.getStatus(options);
  }

  async listPendingChannelDeliveries(
    options: { connector?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ChannelDeliveryRecord[]> {
    return this.channels.listPendingDeliveries(options);
  }

  /** `GET /commands?cwd=` — cwd-scoped slash command catalog for autocomplete. */
  async listCommands(
    options: ListCommandsOptions & { signal?: AbortSignal },
  ): Promise<CommandCatalogEntry[]> {
    return this.system.listCommands(options);
  }

  /** `GET /settings` */
  async getSettings(
    options: { signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    return this.system.getSettings(options);
  }

  /** `PATCH /settings` */
  async patchSettings(
    patch: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    return this.system.patchSettings(patch, options);
  }

  /** `GET /providers` */
  async listProviders(
    options: { signal?: AbortSignal } = {},
  ): Promise<ProviderInfo[]> {
    return this.providers.listProviders(options);
  }

  async createCustomProvider(
    input: CustomProviderInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ProviderInfo> {
    return this.providers.createCustomProvider(input, options);
  }

  async connectCatalogProvider(
    id: string,
    apiKey: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ProviderInfo> {
    return this.providers.connectCatalogProvider(id, apiKey, options);
  }

  async disconnectCatalogProvider(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.providers.disconnectCatalogProvider(id, options);
  }

  async updateCustomProvider(
    id: string,
    input: CustomProviderInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ProviderInfo> {
    return this.providers.updateCustomProvider(id, input, options);
  }

  async removeCustomProvider(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.providers.removeCustomProvider(id, options);
  }

  /** `GET /models` */
  async listModels(
    options: { signal?: AbortSignal } = {},
  ): Promise<ModelProviderInfo[]> {
    return this.providers.listModels(options);
  }

  /** `GET /sessions/:id/mcp` */
  async getSessionMcp(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<McpServerStatus[]> {
    return this.system.getSessionMcp(sessionId, options);
  }

  /** `GET /memory?cwd=` */
  async listMemory(options: {
    cwd: string;
    signal?: AbortSignal;
  }): Promise<MemoryListResponse> {
    return this.system.listMemory(options);
  }

  /** `GET /memory/:id?cwd=` */
  async getMemory(
    entryId: string,
    options: { cwd: string; signal?: AbortSignal },
  ): Promise<MemoryEntryRecord> {
    return this.system.getMemory(entryId, options);
  }

  /** `POST /memory` */
  async addMemory(
    input: { cwd: string; content: string; tags?: string[] },
    options: { signal?: AbortSignal } = {},
  ): Promise<MemoryEntryRecord> {
    return this.system.addMemory(input, options);
  }

  /** `DELETE /memory/:id?cwd=` */
  async removeMemory(
    entryId: string,
    options: { cwd: string; signal?: AbortSignal },
  ): Promise<void> {
    return this.system.removeMemory(entryId, options);
  }

  /** `GET /auth` */
  async getAuthStatus(
    options: { signal?: AbortSignal } = {},
  ): Promise<AuthStatus> {
    return this.auth.getStatus(options);
  }

  /** `POST /auth/login` */
  async authLogin(
    input: { provider: string; apiKey?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return this.auth.login(input, options);
  }

  /** `POST /auth/logout` */
  async authLogout(
    input: { provider: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return this.auth.logout(input, options);
  }

  /** `GET /context/plugins?cwd=` — safe plugin picker metadata. */
  async listContextPlugins(options: { cwd: string; signal?: AbortSignal }): Promise<import("@openharness/protocol").PluginCatalogEntry[]> {
    return this.system.listContextPlugins(options);
  }

  /** `GET /context?cwd=` */
  async getContextPreview(options: {
    cwd: string;
    signal?: AbortSignal;
  }): Promise<string> {
    return this.system.getContextPreview(options);
  }

  /** `GET /context/status?cwd=` */
  async getContextStatus(options: {
    cwd: string;
    signal?: AbortSignal;
  }): Promise<string> {
    return this.system.getContextStatus(options);
  }

  /** `GET /context/usage?cwd=&sessionId=&refresh=` */
  async getContextUsage(options: {
    cwd: string;
    sessionId?: string;
    refresh?: boolean;
    previousContextWindow?: number;
    signal?: AbortSignal;
  }): Promise<{ snapshot: unknown; report: string }> {
    return this.system.getContextUsage(options);
  }

  /** `POST /sessions/:id/compact` */
  async compactSession(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<CompactSessionResponse> {
    return this.sessions.compact(sessionId, options);
  }

  async getSessionGoal(sessionId: string): Promise<SessionGoal | null> {
    return this.sessions.getGoal(sessionId);
  }

  async createSessionGoal(sessionId: string, input: CreateSessionGoalInput): Promise<SessionGoal> {
    return this.sessions.createGoal(sessionId, input);
  }

  async updateSessionGoal(sessionId: string, goalId: string, input: UpdateSessionGoalInput): Promise<SessionGoal> {
    return this.sessions.updateGoal(sessionId, goalId, input);
  }

  async applySessionGoalAction(sessionId: string, goalId: string, input: GoalActionInput): Promise<SessionGoal> {
    return this.sessions.applyGoalAction(sessionId, goalId, input);
  }

  /** `POST /sessions/:id/rewind` */
  async rewindSession(
    sessionId: string,
    input: { count?: number } = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<RewindSessionResponse> {
    return this.sessions.rewind(sessionId, input, options);
  }

  /** `POST /sessions/:id/remember` */
  async rememberSession(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<RememberSessionResponse> {
    return this.sessions.remember(sessionId, options);
  }

  /** `POST /dream` */
  async startDream(
    input: { cwd: string; sessionId?: string; preview?: boolean },
    options: { signal?: AbortSignal } = {},
  ): Promise<StartDreamResponse> {
    return this.system.startDream(input, options);
  }

  /** `GET /profile` */
  async getProfileStatus(
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    return this.system.getProfileStatus(options);
  }

  /** `POST /profile/init` */
  async initProfile(options: { signal?: AbortSignal } = {}): Promise<string> {
    return this.system.initProfile(options);
  }

  /** `GET /output-styles` */
  async listOutputStyles(
    options: { signal?: AbortSignal } = {},
  ): Promise<OutputStyleInfo[]> {
    return this.system.listOutputStyles(options);
  }

  /** `POST /project/init` */
  async initProject(
    input: { cwd: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    return this.projects.init(input, options);
  }

  /** `GET /plugins?cwd=` */
  async listPlugins(options: { cwd: string; signal?: AbortSignal }): Promise<{
    plugins: PluginInfo[];
    warnings: string[];
  }> {
    return this.plugins.list(options);
  }

  /** `POST /plugins/:id/enable` */
  async enablePlugin(
    id: string,
    input: { cwd: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return this.plugins.enable(id, input, options);
  }

  /** `POST /plugins/:id/disable` */
  async disablePlugin(
    id: string,
    input: { cwd: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return this.plugins.disable(id, input, options);
  }

  async installLocalPlugin(input: {
    cwd: string;
    sourcePath: string;
    scope: "user";
    approvedPermissions: string[];
    link?: boolean;
  }): Promise<{ message: string }> {
    return this.plugins.installLocal(input);
  }

  /** `POST /plugins/archive/preview` */
  async previewPluginArchive(
    input: { cwd: string; archivePath: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginArchivePreview> {
    return this.plugins.previewArchive(input, options);
  }

  /** `POST /plugins/archive/install` */
  async installPluginArchive(
    input: { cwd: string; archivePath: string; expectedArchiveDigest: string; approvedPermissions: string[] },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return this.plugins.installArchive(input, options);
  }

  /** `POST /plugins/git/preview` */
  async previewPluginGit(
    input: { cwd: string; url: string; ref?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginGitPreview> {
    return this.plugins.previewGit(input, options);
  }

  /** `POST /plugins/git/install` */
  async installPluginGit(
    input: { cwd: string; url: string; ref?: string; expectedSourceDigest: string; approvedPermissions: string[] },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return this.plugins.installGit(input, options);
  }

  async uninstallPlugin(
    id: string,
    input: { cwd: string },
  ): Promise<{ message: string }> {
    return this.plugins.uninstall(id, input);
  }

  /** `POST /plugins/reload` */
  async reloadPlugins(
    input: { cwd: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<ReloadPluginsResponse> {
    return this.plugins.reload(input, options);
  }

  /** `GET /skills` */
  async listSkills(
    options: { signal?: AbortSignal } = {},
  ): Promise<SkillSnapshot> {
    return this.development.listSkills(options);
  }

  /** `DELETE /skills/:id` */
  async removeSkill(
    id: string,
    input: { expectedContent: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<SkillSnapshot> {
    return this.development.removeSkill(id, input, options);
  }

  /** `GET /agent-personas` */
  async listAgentPersonas(
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentPersonaInfo[]> {
    return this.development.listAgentPersonas(options);
  }

  /** `GET /hooks?cwd=&sessionId=` */
  async listHooks(options: {
    cwd: string;
    sessionId?: string;
    signal?: AbortSignal;
  }): Promise<HookInfo[]> {
    return this.development.listHooks(options);
  }

  /** `GET /git/diff?cwd=&full=` */
  async getGitDiff(options: {
    cwd: string;
    full?: boolean;
    signal?: AbortSignal;
  }): Promise<string> {
    return this.development.getGitDiff(options);
  }

  /** `GET /git/branch?cwd=&list=` */
  async getGitBranch(options: {
    cwd: string;
    list?: boolean;
    signal?: AbortSignal;
  }): Promise<string> {
    return this.development.getGitBranch(options);
  }

  /** `GET /git/status?cwd=` */
  async getGitStatus(options: {
    cwd: string;
    signal?: AbortSignal;
  }): Promise<string> {
    return this.development.getGitStatus(options);
  }

  /** `POST /git/commit` */
  async gitCommit(
    input: { cwd: string; message: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    return this.development.gitCommit(input, options);
  }

  /** `GET /sessions/:id/usage` */
  async getSessionUsage(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionUsageResponse> {
    return this.sessions.getUsage(sessionId, options);
  }

  /** `POST /sessions/:id/export` */
  async exportSession(
    sessionId: string,
    input: { filename?: string; json?: boolean } = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionExportResponse> {
    return this.sessions.export(sessionId, input, options);
  }

  /** `GET /sessions` */
  async listSessions(
    options: ListSessionsOptions & { signal?: AbortSignal } = {},
  ): Promise<SessionRecord[]> {
    return this.sessions.list(options);
  }

  async listProjects(
    options: ListProjectsOptions & { signal?: AbortSignal } = {},
  ): Promise<ProjectRecord[]> {
    return this.projects.list(options);
  }

  async inspectProject(path: string): Promise<ProjectRecord> {
    return this.projects.inspect(path);
  }

  async renameProject(projectId: string, name: string): Promise<ProjectRecord> {
    return this.projects.rename(projectId, name);
  }

  async setProjectPinned(
    projectId: string,
    pinned: boolean,
  ): Promise<ProjectRecord> {
    return this.projects.setPinned(projectId, pinned);
  }

  async setProjectDefaultShell(
    projectId: string,
    defaultShell: string | null,
  ): Promise<ProjectRecord> {
    return this.projects.setDefaultShell(projectId, defaultShell);
  }

  async rebindProject(projectId: string, path: string): Promise<ProjectRecord> {
    return this.projects.rebind(projectId, path);
  }

  async archiveProject(projectId: string): Promise<ProjectRecord> {
    return this.projects.archive(projectId);
  }

  /** `POST /sessions` */
  async createSession(
    input: CreateClientSessionInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionRecord> {
    return this.sessions.create(input, options);
  }

  /** `GET /sessions/:id` */
  async getSession(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionRecord> {
    return this.sessions.get(sessionId, options);
  }

  /** `POST /sessions/:id/fork` */
  async forkSession(
    sessionId: string,
    input: ForkClientSessionInput = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionRecord> {
    return this.sessions.fork(sessionId, input, options);
  }

  /** `GET /sessions/:id/state` - atomic attach snapshot plus SSE cursor. */
  async getSessionState(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionStateSnapshot> {
    return this.sessions.getState(sessionId, options);
  }

  /** `DELETE /sessions/:id` */
  async archiveSession(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionRecord> {
    return this.sessions.archive(sessionId, options);
  }

  /** `DELETE /sessions/:id/hard` */
  async deleteSession(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string[]> {
    return this.sessions.delete(sessionId, options);
  }

  /** `PATCH /sessions/:id` - update title, agent, or metadata.runtime fields. */
  async updateSession(
    sessionId: string,
    input: UpdateClientSessionInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionRecord> {
    return this.sessions.update(sessionId, input, options);
  }

  /** `GET /sessions/:id/messages` */
  async listMessages(
    sessionId: string,
    options: ListMessagesOptions & { signal?: AbortSignal } = {},
  ): Promise<SessionMessageRecord[]> {
    return this.sessions.listMessages(sessionId, options);
  }

  /** `GET /sessions/:id/parts` */
  async listMessageParts(
    sessionId: string,
    options: ListClientMessagePartsOptions & { signal?: AbortSignal } = {},
  ): Promise<SessionMessagePartRecord[]> {
    return this.sessions.listMessageParts(sessionId, options);
  }

  /** `POST /sessions/:id/prompts` — 提交用户输入并触发/排队一次 run。 */
  async admitPrompt(
    sessionId: string,
    input: AdmitClientPromptInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PromptResponse> {
    return this.sessions.admitPrompt(sessionId, input, options);
  }

  /** `POST /sessions/:id/prompts/latest/edit` */
  async editLatestPrompt(
    sessionId: string,
    input: EditLatestClientPromptInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PromptResponse> {
    return this.sessions.editLatestPrompt(sessionId, input, options);
  }

  /** Promote one durable queued prompt into the exact active run. */
  async promoteQueuedPrompt(
    sessionId: string,
    inputId: string,
    input: PromoteQueuedClientPromptInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PromoteQueuedPromptResponse> {
    return this.sessions.promoteQueuedPrompt(sessionId, inputId, input, options);
  }

  /** Cancel one durable prompt that is still waiting in the run queue. */
  async cancelQueuedPrompt(
    sessionId: string,
    inputId: string,
    input: CancelQueuedClientPromptInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<CancelQueuedPromptResponse> {
    return this.sessions.cancelQueuedPrompt(sessionId, inputId, input, options);
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
    return this.sessions.resumeInterruptedRun(sessionId, runId, input, options);
  }

  /** `POST /sessions/:id/interrupt` — 中断当前/排队中的 run。 */
  async interruptSession(
    sessionId: string,
    options: { signal?: AbortSignal; expectedRunId?: string } = {},
  ): Promise<InterruptSessionResponse> {
    return this.sessions.interrupt(sessionId, options);
  }

  /** `GET /events` — 用于 attach 时的历史 replay。 */
  async listEvents(
    options: ListEventsOptions & { signal?: AbortSignal } = {},
  ): Promise<SessionEventRecord[]> {
    return this.events.list(options);
  }

  /** `GET /permissions` */
  async listPermissions(
    options: ListPermissionsOptions & { signal?: AbortSignal } = {},
  ): Promise<PermissionRequestRecord[]> {
    return this.permissions.list(options);
  }

  /** `POST /permissions/:id/reply` — 批准/拒绝工具权限请求。 */
  async replyPermission(
    requestId: string,
    input: ReplyPermissionInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PermissionRequestRecord> {
    return this.permissions.reply(requestId, input, options);
  }

  async getScheduledTaskStatus(
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduledTaskStatusSummary> {
    return this.schedules.getStatus(options);
  }

  async listScheduledTasks(
    options: {
      status?: ScheduledTaskRecord["status"];
      signal?: AbortSignal;
    } = {},
  ): Promise<ScheduledTaskRecord[]> {
    return this.schedules.listTasks(options);
  }

  async getScheduledTask(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduledTaskRecord> {
    return this.schedules.getTask(id, options);
  }

  async createScheduledTask(
    input: CreateScheduledTaskInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduledTaskRecord> {
    return this.schedules.createTask(input, options);
  }

  async updateScheduledTask(
    id: string,
    input: UpdateScheduledTaskInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduledTaskRecord> {
    return this.schedules.updateTask(id, input, options);
  }

  async removeScheduledTask(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.schedules.removeTask(id, options);
  }

  async triggerScheduledTask(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduledRunRecord> {
    return this.schedules.triggerTask(id, options);
  }

  async listScheduledRuns(
    options: {
      taskId?: string;
      unread?: boolean;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ScheduledRunRecord[]> {
    return this.schedules.listRuns(options);
  }

  async setScheduledRunUnread(
    id: string,
    unread: boolean,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduledRunRecord> {
    return this.schedules.setRunUnread(id, unread, options);
  }

  async createTerminal(
    input: TerminalCreateRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<TerminalSessionInfo> {
    return this.terminals.create(input, options);
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
    return this.jobs.list(options);
  }

  async createBackgroundShell(
    input: CreateBackgroundShellInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<CreateBackgroundShellResult> {
    return this.jobs.createBackgroundShell(input, options);
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
    return this.jobs.read(jobId, options);
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
    return this.jobs.wait(jobId, input, options);
  }

  async sendJob(
    jobId: string,
    input: { sessionId: string; data: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.jobs.send(jobId, input, options);
  }

  async cancelJob(
    jobId: string,
    input: { sessionId: string; reason?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<JobSnapshot> {
    return this.jobs.cancel(jobId, input, options);
  }

  async listTerminals(
    options: {
      projectId?: string;
      sessionId?: string;
      source?: TerminalSource;
      signal?: AbortSignal;
    } = {},
  ): Promise<TerminalSessionInfo[]> {
    return this.terminals.list(options);
  }

  async getTerminal(
    terminalId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TerminalSessionInfo> {
    return this.terminals.get(terminalId, options);
  }

  async readTerminal(
    terminalId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TerminalReadResult> {
    return this.terminals.read(terminalId, options);
  }

  async writeTerminal(
    input: TerminalWriteRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.terminals.write(input, options);
  }

  async resizeTerminal(
    input: TerminalResizeRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.terminals.resize(input, options);
  }

  async signalTerminal(
    terminalId: string,
    signal: TerminalSignal,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.terminals.signal(terminalId, signal, options);
  }

  async closeTerminal(
    terminalId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.terminals.close(terminalId, options);
  }

  streamTerminalEvents(
    options: { signal?: AbortSignal } = {},
  ): AsyncIterable<TerminalEvent> {
    return this.terminals.streamEvents(options);
  }

  streamEvents(
    options: EventSyncOptions = {},
  ): AsyncIterable<SessionEventRecord> {
    return this.events.stream(options);
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
