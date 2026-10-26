import { createNoteApplicationService, type NoteApplicationService } from "./notes/note-application-service.js";
import { createProjectFactsService, type ProjectFactsService } from "./personalization/project-facts-service.js";
import { createMaintenanceApplicationService, type MaintenanceApplicationContext } from "./maintenance/maintenance-application-service.js";
import { ToolOperationReviewService } from "./session/execution/tool-operation-review-service.js";
import { ToolOperationService } from "./session/execution/tool-operation-service.js";
import { ToolResultService } from "./session/execution/tool-result-service.js";
import { isTrustedReadOnlyTool, markTrustedReadOnlyTool } from "@vykor/agent-runtime";
import { GoalModelAttemptService } from "./goals/goal-model-attempt-service.js";
import {hostedContextUsageAgent} from "./context-usage/assemble-session-context-usage.js";
import { ToolAppOriginProjector } from "./agent/tool-app-origin-projector.js";
import { ExecutionRuntimeOwner } from "@vykor/execution-node";
import { WorkflowHost } from "@vykor/agent-runtime/node/workflow";
import { PluginUiHistoryService } from "./session/plugins/plugin-ui-history-service.js";
import { retirePluginUiActions } from "./recovery/retire-plugin-ui-actions.js";
import type { PluginLifecycle } from "./session/plugins/plugin-lifecycle.js";
import { randomUUID } from "node:crypto";
import { assemblePluginApps } from "./session/plugins/plugin-app-assembly.js";
import { PluginAppConversationService } from "./session/plugins/plugin-app-conversation-service.js";

import type { AgentBackgroundShellHost } from "@vykor/tools";
import type { Settings } from "@vykor/host-config";
import type { ChannelConfigStore } from "@vykor/auth";
import { createModelCatalogService } from "@vykor/api";
import { fileReadTool } from "@vykor/tools";
import { computePluginBehaviorDigest } from "@vykor/plugins";
import {
  type ObservableJobProducer,
} from "@vykor/agent-runtime";
import type { AgentTerminalHost } from "@vykor/terminal";
import { readSessionRuntimeConfig } from "./session/configuration/runtime-configuration.js";
import type { AttachmentLimits } from "@vykor/domain-contracts/attachments";
import type { SessionRecord } from "@vykor/domain-contracts/sessions";
import {
  AttachmentIntegrityService,
  type LocalOcrService,
  executeAutoDream,
  getSessionMemoryContent,
  getSessionMemoryPath,
  readLastConsolidatedAt,
  sessionMemoryToCompactText,
  updateSessionMemoryFile,
  type SessionStore,
  type ApplicationOwnerLease,
} from "@vykor/services";
import {
} from "@vykor/execution-node";

import { AttachmentService } from "./attachments/attachment-service.js";
import { createDaemonAttachmentServices } from "./attachments/daemon-attachment-services.js";
import { createModelMetadataResolvers } from "./default-services/models/model-limit-resolution.js";
import { validateRequestSelection } from "./session/interactions/request-selection-validation.js";
import { createDaemonAgentLoader, type CreateDaemonAgent } from "../daemon/daemon-agent.js";
import { McpRuntimeConnectionCoordinator } from "./mcp/mcp-runtime-connection-coordinator.js";
import { McpOAuthApplicationService } from "./mcp/mcp-oauth-application-service.js";
import { McpOAuthOperationService } from "./mcp/mcp-oauth-operation-service.js";
import { ScheduledTaskService } from "../daemon/scheduled-task-service.js";
import { ScheduledTaskExecutor } from "./schedule/scheduled-task-executor.js";
import { DaemonJobService, readPersistedChildActivity } from "../jobs/daemon-job-service.js";
import type { ObservabilityEvent } from "../shared/observability.js";
import { DaemonTerminalService } from "../terminal/daemon-terminal-service.js";
import { createSessionEnvironmentAcquirer } from "../runtime/session-execution-environment.js";
import { sessionSettingsRoot } from "../runtime/session-settings-root.js";
import { sessionPermissionRequest } from "../permissions/session-approval.js";
import { StorePermissionBroker } from "../permissions/permission-broker.js";
import {
  DAEMON_RESTART_PERMISSION_REASON,
  DAEMON_RESTART_INPUT_REASON,
  DAEMON_RESTART_RUN_REASON,
  DAEMON_RESTART_TASK_REASON,
  normalizeTraceId,
} from "./support.js";
import { AgentPool } from "./agent/agent-pool.js";
import { DaemonAgentEventProjector } from "./agent/daemon-agent-event-projector.js";
import {
  DAEMON_AGENT_PROJECTOR,
  recoverProjectionSettlements,
} from "./agent/projection-settlement-recovery.js";
import { DaemonControlService } from "./control/daemon-control-service.js";
import {
  DaemonOperationGate,
  DaemonOperationUnavailableError,
} from "./control/daemon-operation-gate.js";
import { LiveChildAgentDirectory } from "./agent/live-child-agent-directory.js";
import { SessionInteractionService } from "./session/interactions/session-interaction-service.js";
import { SessionOperationRunner } from "./session/session-operation-runner.js";
import { SessionCommandService } from "./session/session-command-service.js";
import { SessionGoalService } from "./session/goals/session-goal-service.js";
import { GoalWaitVerifier } from "./session/goals/goal-wait-verifier.js";
import { SessionEventPublisher } from "./session/transcript/session-event-publisher.js";
import { SessionMaintenanceService } from "./session/maintenance/session-maintenance-service.js";
import { SessionQueryService } from "./session/session-query-service.js";
import { SessionRunEngine } from "./session/execution/session-run-engine.js";
import { assembleSessionRunServices } from "./session/execution/session-run-assembly.js";
import { assembleSessionRunExecutor } from "./session/execution/session-run-executor-assembly.js";
import { SessionAutoReviewService } from "./auto-review/session-auto-review-service.js";
import { createGitRunChangeInspector } from "./auto-review/git-run-change-inspector.js";
import { SessionWorkspaceChanges } from "./session/execution/session-workspace-changes.js";
import { createSessionRuntimeDiscovery } from "./session/configuration/session-runtime-discovery.js";
import { RunAdmissionService } from "./session/execution/run-admission-service.js";
import { RunControlService } from "./session/execution/run-control-service.js";
import { SessionPluginCapabilityService } from "./session/plugins/session-plugin-capability-service.js";
import { SessionPostRunMaintenance } from "./session/maintenance/session-post-run-maintenance.js";
import { SessionExecutionProjector } from "./session/transcript/session-execution-projector.js";
import { BackgroundShellService } from "./session/execution/background-shell-service.js";
import { ApplicationError } from "../shared/application-error.js";
import { SessionTranscriptProjection } from "./session/transcript/transcript-projection.js";
import { recoverInterruptedWorkflows } from "./session/maintenance/workflow-recovery.js";
import { StartupRecoveryService } from "./recovery/startup-recovery-service.js";
import { ApplicationEventService } from "./events/application-event-service.js";
import { ProjectApplicationService } from "./projects/project-application-service.js";
import { ChannelApplicationService } from "./channel/channel-application-service.js";
import type { ChannelOnboardingService } from "./channel/channel-onboarding-service.js";
import type { ChannelRuntimeService } from "../daemon/channel-runtime-service.js";
import { createDaemonChannelRuntime } from "./channel/channel-runtime-assembly.js";
import { SessionWorkflowRunRepository } from "./workflow/session-workflow-run-repository.js";
import { ExecutionObservationService } from "./observability/execution-observation-service.js";
import { readSessionExecutionObservations } from "./observability/session-execution-observation-reader.js";
import { readWorkflowExecutionObservations } from "./observability/workflow-execution-observation-reader.js";
import { ApplicationRetentionService } from "./retention/application-retention-service.js";
import { buildCompactAttachmentSection } from "./attachments/resources/compact-attachment-catalog.js";
import { SessionAttachmentResources } from "./attachments/resources/session-attachment-resources.js";
import { sharedContextUsageCache } from "./context-usage/context-usage-cache.js";
import {
  assembleSessionContextUsage,
  tryAssembleSessionContextUsageLive,
  type SessionContextUsageAgent,
} from "./context-usage/assemble-session-context-usage.js";
import { bindContextUsageLiveAssembler } from "./context-usage/context-usage-live-binder.js";
import {
  createAttachmentAuthorizationSessionResolver,
  createAttachmentOcrService,
  createAttachmentTextReader,
} from "./attachments/tools/attachment-access.js";
import { createAttachmentReadTool } from "./attachments/tools/attachment-read-tool.js";
import { supportsNativeImageInput } from "./attachments/routing/attachment-capabilities.js";
import {
  createDaemonImageGenerationTool,
  createDaemonImageToTextTool,
} from "./visual-tools/index.js";
import { createBrowserDeveloperTool, createBrowserTool, type BrowserHost } from "./browser-tools/index.js";
import { createDefaultPluginService } from "./default-services/extensions/plugin-service.js";
import { createPluginInstallTool } from "./plugins/plugin-install-tool.js";
import { createMcpConfigureTool } from "./mcp/mcp-configure-tool.js";
import { McpConfigApplicationService } from "./mcp/mcp-config-application-service.js";

export interface DaemonApplicationOptions {
  /** Transferred to the application and closed with it; omitted means a private owner. */
  executionOwner?: ExecutionRuntimeOwner;
  store: SessionStore;
  attachmentRoot?: string;
  attachmentLimits?: Partial<AttachmentLimits>;
  attachments?: AttachmentService;
  /** 只有默认 Node 组装应设为 true；外部注入的 Store 默认由调用方关闭。 */
  ownsStore?: boolean;
  settings?: Settings;
  getSettings?: () => Settings;
  getSettingsForCwd?: (cwd: string) => Promise<Settings>;
  executionSurface?: "desktop_managed" | "cli_advanced";
  /** Root used for scheduled conversations that intentionally run outside a project. */
  outsideProjectWorkspaceRoot?: string;
  createAgent?: CreateDaemonAgent;
  /** Browser control is supplied by an embedding desktop host; the server builds the agent tool. */
  browserHost?: BrowserHost;
  /** 提供后 daemon 才构造渠道运行时与接入服务；未提供时渠道路由返回 503。 */
  channelConfigStore?: ChannelConfigStore;
  createTerminal?(session: SessionRecord): ObservableJobProducer<AgentTerminalHost>;
  createBackgroundShell?(session: SessionRecord): ObservableJobProducer<AgentBackgroundShellHost>;
  log(event: ObservabilityEvent): void;
  ownerId?: string;
  ownerHeartbeatMs?: number;
  ownerStaleAfterMs?: number;
  ownerProcessAlive?: (pid: number) => boolean;
}

/**
 * daemon 对外暴露的能力面。HTTP 路由只调这些，不自己造 Agent、不自己写会话记录。
 */
export interface DurableAgentApplication {
  createMaintenanceService?(host?: Pick<MaintenanceApplicationContext, "logs" | "settings"> & { beforeClose?(): void }): ReturnType<typeof createMaintenanceApplicationService>;
  readonly diagnosticState?: { phase: "starting" | "ready" | "failed" | "closing" | "closed"; accepting: boolean };
  readonly pluginUiHistory?: PluginUiHistoryService;
  readonly pluginLifecycle?: PluginLifecycle;
  readonly pluginApps?: ReturnType<typeof assemblePluginApps>;
  readonly pluginAppConversation?: PluginAppConversationService;
  readonly store: SessionStore;
  readonly notes: NoteApplicationService;
  readonly facts: ProjectFactsService;
  readonly attachments: AttachmentService;
  readonly interactions: SessionInteractionService;
  readonly goals: SessionGoalService;
  readonly queries: SessionQueryService;
  readonly commands: SessionCommandService;
  readonly runControl: RunControlService;
  readonly permissions: StorePermissionBroker;
  /** Optional for custom embedders; the production Daemon always provides manual review. */
  readonly toolOperationReview?: Pick<ToolOperationReviewService, "list" | "get" | "reconcile">;
  readonly backgroundShells: BackgroundShellService;
  readonly maintenance: SessionMaintenanceService;
  readonly control: DaemonControlService;
  readonly schedules: ScheduledTaskService;
  readonly jobs: DaemonJobService;
  readonly terminals: DaemonTerminalService;
  readonly projects: ProjectApplicationService;
  readonly events: ApplicationEventService;
  readonly channels: ChannelApplicationService;
  readonly channelRuntime?: ChannelRuntimeService;
  readonly channelOnboarding?: ChannelOnboardingService;
  readonly workflows: SessionWorkflowRunRepository;
  readonly retention: ApplicationRetentionService;
  /** Process-wide coordinator for OAuth-driven MCP Runtime reconnects. */
  readonly mcpRuntimes: McpRuntimeConnectionCoordinator;
  /** MCP OAuth credential operations (login/logout) for this daemon. */
  readonly mcpOAuth: McpOAuthApplicationService;
  /** Bounded, in-memory OAuth login operations owned by this daemon instance. */
  readonly mcpOAuthOperations: McpOAuthOperationService;
  ready(): Promise<void>;
  close(): Promise<void>;
}

function failMissingSettings(): never {
  throw new Error("Agent settings are not configured");
}

/**
 * daemon 的装配根：把「会话记录、活 Agent、投影、跑 prompt 的车道」接成一张图。
 * 不管听端口、不管路由；`POST /prompts` 最终会进这里的 sessions.admitPrompt。
 *
 * 一条用户消息大概走：
 * sessions 收下 → runEngine 排队 → runExecutor 调 Agent
 * → onEvent 进投影 → 写成会话记录 → events 推给窗口。
 */
export class DaemonApplication implements DurableAgentApplication {
  private readonly executionOwner: ExecutionRuntimeOwner;
  readonly pluginUiHistory: PluginUiHistoryService;
  readonly pluginLifecycle: PluginLifecycle;
  readonly pluginApps: ReturnType<typeof assemblePluginApps>;
  readonly pluginAppConversation: PluginAppConversationService;
  readonly store: SessionStore;
  readonly notes: NoteApplicationService;
  readonly facts: ProjectFactsService;
  readonly attachments: AttachmentService;
  readonly permissions: StorePermissionBroker;
  readonly toolOperationReview: Pick<ToolOperationReviewService, "list" | "get" | "reconcile">;
  readonly backgroundShells: BackgroundShellService;
  readonly interactions: SessionInteractionService;
  readonly goals: SessionGoalService;
  readonly maintenance: SessionMaintenanceService;
  readonly queries: SessionQueryService;
  readonly commands: SessionCommandService;
  readonly control: DaemonControlService;
  readonly schedules: ScheduledTaskService;
  readonly jobs: DaemonJobService;
  readonly terminals: DaemonTerminalService;
  readonly projects: ProjectApplicationService;
  readonly events: ApplicationEventService;
  readonly channels: ChannelApplicationService;
  readonly channelRuntime?: ChannelRuntimeService;
  readonly channelOnboarding?: ChannelOnboardingService;
  readonly workflows: SessionWorkflowRunRepository;
  readonly workflowHost: WorkflowHost;
  readonly retention: ApplicationRetentionService;
  readonly mcpRuntimes: McpRuntimeConnectionCoordinator;
  readonly mcpOAuth: McpOAuthApplicationService;
  readonly mcpOAuthOperations: McpOAuthOperationService;
  private readonly attachmentResources: SessionAttachmentResources;
  private readonly modelCatalog: ReturnType<typeof createModelCatalogService>;

  private readonly eventPublisher: SessionEventPublisher;
  private readonly transcriptProjection: SessionTranscriptProjection;
  private readonly executionProjector: SessionExecutionProjector;
  /** 正在跑的子 Agent 会话。主会话池不能把它们再当成普通会话 acquire。 */
  private readonly liveChildren = new LiveChildAgentDirectory();
  private readonly operationGate = new DaemonOperationGate();
  private readonly operationRunner: SessionOperationRunner;
  private readonly agentPool: AgentPool;
  private readonly runEngine: SessionRunEngine;
  readonly runAdmission: RunAdmissionService;
  readonly runControl: RunControlService;
  private readonly localOcr: LocalOcrService;
  private readonly startupRecovery: Promise<void>;
  createMaintenanceService(host: Pick<MaintenanceApplicationContext, "logs" | "settings"> & { beforeClose?(): void } = {}) {
    return createMaintenanceApplicationService({ store: this.store, control: this.control, commands: this.commands, terminals: this.terminals, ...host, readiness: () => this.diagnosticState, closeApplication: () => { host.beforeClose?.(); return this.close(); } });
  }
  private closePromise?: Promise<void>;
  private readyState: "starting" | "ready" | "failed" | "closing" | "closed" = "starting";
  get diagnosticState() { return { phase: this.readyState, accepting: this.readyState === "ready" && this.operationGate.accepting }; }
  private ownerLease: ApplicationOwnerLease;
  private readonly ownerHeartbeat: ReturnType<typeof setInterval>;

  constructor(private readonly options: DaemonApplicationOptions) {
    const { store } = options;
    this.store = store;
    const executionOwner = options.executionOwner ?? new ExecutionRuntimeOwner();
    this.executionOwner = executionOwner;
    this.notes = createNoteApplicationService({ notes: store.notes, readiness: () => this.diagnosticState });
    this.mcpRuntimes = new McpRuntimeConnectionCoordinator();
    this.mcpOAuth = new McpOAuthApplicationService({ coordinator: this.mcpRuntimes });
    this.mcpOAuthOperations = new McpOAuthOperationService({ application: this.mcpOAuth });
    this.modelCatalog = createModelCatalogService();
    // 同一份会话库同时只允许一个 daemon 当主人。心跳断了，别人才能接管。
    this.ownerLease = store.acquireApplicationOwner({
      ownerId: options.ownerId ?? `daemon:${process.pid}:${randomUUID()}`,
      pid: process.pid,
      staleAfterMs: options.ownerStaleAfterMs ?? 30_000,
      canTakeOver: (current) => !(options.ownerProcessAlive ?? isProcessAlive)(current.pid),
    });
    this.ownerHeartbeat = setInterval(() => {
      try {
        this.ownerLease = store.heartbeatApplicationOwner(this.ownerLease);
      } catch (error) {
        clearInterval(this.ownerHeartbeat);
        this.readyState = "failed";
        options.log({
          level: "error",
          event: "application.owner_lost",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, options.ownerHeartbeatMs ?? 5_000);
    this.ownerHeartbeat.unref?.();
    let createdWorkflowHost: WorkflowHost | undefined;
    try {
      const attachmentServices = createDaemonAttachmentServices({
        store,
        attachmentRoot: options.attachmentRoot,
        attachmentLimits: options.attachmentLimits,
        attachments: options.attachments,
      });
      this.attachments = attachmentServices.attachments;
      this.attachmentResources = attachmentServices.resources;
      this.localOcr = attachmentServices.localOcr;
      // 上次进程可能是被杀掉的：内存里的 Agent/进程都没了，store 里却还挂着 running。
      // 先把这些半截状态结掉，再对外服务，免得窗口以为还在跑。
      // events：窗口订的 SSE。eventPublisher：各处写完 store 后，把增量广播出去。
      this.events = new ApplicationEventService(store.conversations);
      this.eventPublisher = new SessionEventPublisher(store.conversations, this.events);
      this.workflows = new SessionWorkflowRunRepository({
        workflows: store.workflows,
        sessionExists: (sessionId) => !!store.sessions.get(sessionId),
        events: {
          latestEventSeq: () => store.conversations.latestEventSeq(),
          appendEvent: (input) => store.conversations.appendEvent(input),
        },
        path: store.path,
        onDurableEvent: (previousEventSeq) =>
          this.eventPublisher.publishSince(previousEventSeq),
      });
      this.workflowHost = createdWorkflowHost = new WorkflowHost(this.workflows);
      this.retention = new ApplicationRetentionService(
        store,
        new AttachmentIntegrityService({
          store,
          attachments: store.attachments,
          blobs: attachmentServices.blobs,
          operationGate: this.attachments.operationGate,
        }),
      );
      const acquireSessionEnvironment =
        options.executionSurface === "desktop_managed"
          ? createSessionEnvironmentAcquirer()
          : undefined;
      this.terminals = new DaemonTerminalService(
        {
          getProject: (projectId) => store.projects.get(projectId),
          getSession: (sessionId) => store.sessions.get(sessionId),
        },
        {
          operationGate: this.operationGate,
          getSettingsForCwd: async (cwd) =>
            options.getSettingsForCwd
              ? await options.getSettingsForCwd(cwd)
              : (options.getSettings?.() ?? options.settings ?? failMissingSettings()),
          acquireEnvironment: acquireSessionEnvironment,
        },
      );
      this.projects = new ProjectApplicationService(store.projects, {
        listSessions: () => store.sessions.list({ includeArchived: true }),
        hasWork: (id) => this.runControl.hasWork(id) || this.liveChildren.has(id) || store.runs.listSessionTasks(id).some(task => task.status === "pending" || task.status === "running"),
        hasActiveTerminals: (projectId) => this.terminals.hasActive({ projectId }),
        closeAgent: (id) => this.agentPool.close(id),
        enterRebind: (isIdle) => this.operationGate.tryEnterBarrier({ kind: "global" }, isIdle),
        events: this.eventPublisher,
      });
      this.permissions = new StorePermissionBroker({
        permissions: store.permissions,
        getSession: (sessionId) => store.sessions.get(sessionId),
        latestEventSeq: () => store.conversations.latestEventSeq(),
        onChange: (previousEventSeq) => this.eventPublisher.publishSince(previousEventSeq),
        logger: options.log,
      });
      // transcript：把模型吐出的字/工具块写成消息。
      // executionProjector：子 Agent、后台 shell 在会话里的那条「任务」记录。
      this.operationRunner = new SessionOperationRunner({
        sessions: store.sessions, operationGate: this.operationGate, events: this.eventPublisher,
        assertReady: () => this.assertReady(),
      });
      const application = this;
      const runtimeDiscovery = createSessionRuntimeDiscovery(options);
      const pluginCapabilities = new SessionPluginCapabilityService({
        store,
        resolveInventory: runtimeDiscovery.resolvePluginInventory,
      });
      this.pluginUiHistory = new PluginUiHistoryService({ store });
      this.pluginLifecycle = { withMutation: async (scope, work) => {
        const release = await this.pluginApps.revokeScope(scope);
        try { return await work(); } finally { release(); }
      } };
      this.transcriptProjection = new SessionTranscriptProjection({
        conversations: store.conversations,
        incrementalOutput: store.incrementalOutput,
        runs: store.runs,
      });
      this.executionProjector = new SessionExecutionProjector({
        store,
        getChildAgentExecutionRegistry: (scope) => this.executionOwner.getChildAgentExecutionRegistry(scope),
        events: this.eventPublisher,
        traceIdForRun: (runId) => this.traceIdForRun(runId),
        log: options.log,
      });
      const taskStore = {
        getSession: (id: string) => store.sessions.get(id),
        listSessions: (input?: { includeArchived?: boolean }) => store.sessions.list(input),
        createSessionTask: store.createSessionTask.bind(store),
        reserveSessionTask: store.reserveSessionTask.bind(store),
        transitionPendingSessionTask: store.transitionPendingSessionTask.bind(store),
        updateSessionTask: store.updateSessionTask.bind(store),
        getSessionTask: store.getSessionTask.bind(store),
        listSessionTasks: store.listSessionTasks.bind(store),
        waitForSessionTaskChange: store.waitForSessionTaskChange.bind(store),
        readChildActivity: (input: { parentSessionId: string; childSessionId: string; runId?: string }) =>
          readPersistedChildActivity({
            getSession: (id) => store.sessions.get(id),
            listMessages: (id) => store.conversations.listMessages(id),
            listMessageParts: (id) => store.conversations.listMessageParts(id),
            getRun: (id) => store.runs.getRun(id),
            listRunAttempts: (id) => store.runs.listRunAttempts(id),
          }, input),
      };
      const jobOperationGate = {
        enter: (scope: { sessionId: string; cwd: string }) => {
          try { return this.operationGate.enter(scope); }
          catch (error) {
            if (error instanceof DaemonOperationUnavailableError) throw new ApplicationError(409, error.message);
            throw error;
          }
        },
      };
      this.backgroundShells = new BackgroundShellService({
        operationGate: jobOperationGate,
        store: taskStore,
        executionProjector: this.executionProjector,
        getDetachedProcessSupervisor: (scope) => this.executionOwner.getDetachedProcessSupervisor(scope),
        events: this.eventPublisher,
        getSettingsForCwd: async (cwd) =>
          options.getSettingsForCwd
            ? await options.getSettingsForCwd(cwd)
            : (options.getSettings?.() ?? options.settings ?? failMissingSettings()),
        acquireEnvironment: acquireSessionEnvironment,
      });
      // JobWait / JobList 走这里：终端、后台 shell、子 Agent、workflow 合成一张本会话任务表。
      const toolAppOrigins = new ToolAppOriginProjector();
      this.jobs = new DaemonJobService(
        taskStore,
        this.terminals,
        (scope) => this.executionOwner.getDetachedProcessSupervisor(scope),
        (scope) => this.executionOwner.getChildAgentExecutionRegistry(scope),
        this.workflowHost,
        this.executionProjector,
        jobOperationGate,
      );

      const attachmentAuthorizationSessions = createAttachmentAuthorizationSessionResolver({
        store: { getSession: (id) => store.sessions.get(id) },
        liveChildren: this.liveChildren,
      });
      const attachmentReader = createAttachmentTextReader({
        store: { listSessionInputAttachments: (id) => store.conversations.listSessionInputAttachments(id) },
        attachments: this.attachments,
      });
      const attachmentOcr = createAttachmentOcrService({
        store: { listSessionInputAttachments: (id) => store.conversations.listSessionInputAttachments(id) },
        recognize: (input) => this.localOcr.recognize(input),
      });
      const imageToTextTool = createDaemonImageToTextTool({
        authorizationSessions: attachmentAuthorizationSessions,
        attachmentOcr,
        getSettings: async context => {const session=context.sessionId ? store.sessions.get(context.sessionId) : undefined;return session && options.getSettingsForCwd ? await options.getSettingsForCwd(sessionSettingsRoot(session)) : options.getSettings?.() ?? options.settings;},
      });
      const imageGenerationTool = createDaemonImageGenerationTool({
        attachments: this.attachments,
      });

      // 每个会话第一次用时，在这里造活 Agent，并接上投影。
      const modelAttempts = new GoalModelAttemptService({ store, events: this.eventPublisher,
        requestBudgetStop: (goalId) => this.goals.requestBudgetStop(goalId) });
      const toolSafety = new ToolOperationService({ store, ownerLease: () => this.ownerLease,
        accepting: () => this.readyState === "ready" && this.operationGate.accepting,
        describe: ({ binding }) => binding?.source?.kind === "builtin"
          && isTrustedReadOnlyTool(binding.definition, binding.definitionIdentity) ? { kind: "read_only" } : undefined });
      this.toolOperationReview = new ToolOperationReviewService({ store, ownerLease: () => this.ownerLease,
        accepting: () => this.readyState === "ready" && this.operationGate.accepting, reconcile: input => toolSafety.reconcile(input) });
      const toolResults = new ToolResultService({ store, ownerLease: () => this.ownerLease,
        accepting: () => this.readyState === "ready" && this.operationGate.accepting });
      const loadAgent = createDaemonAgentLoader({
        toolSafety,
        toolResults: (scope, tools) => toolResults.forRun(scope, tools),
        modelAttempts,
        executionOwner: this.executionOwner,
        executionSurface: options.executionSurface,
        settings: options.settings,
        getSettings: options.getSettings,
        getSettingsForCwd: options.getSettingsForCwd,
        onSettingsReloadError: (sessionId, error) => options.log({
          level: "warn",
          event: "settings.reload.failed",
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        }),
        getSession: (id) => store.sessions.get(id),
        prepareModelMetadata: async settings =>
          createModelMetadataResolvers(settings, await this.modelCatalog.load()),
        createAgent: options.createAgent,
        mcpRuntimeRegistry: this.mcpRuntimes,
        acquireEnvironment: acquireSessionEnvironment,
        createTerminal:
          options.createTerminal ??
          ((session) => ({
            value: this.terminals.createAgentHost(session),
            jobs: this.jobs.createTerminalAgentHost(session),
          })),
        createBackgroundShell:
          options.createBackgroundShell ??
          ((session) => ({
            value: {
              create: async (input) => {
                const owner = store.sessions.get(input.sessionId);
                if (
                  !owner ||
                  owner.status === "archived" ||
                  !isSessionInTree({ getSession: (id) => store.sessions.get(id) }, session.id, owner.id)
                ) {
                  throw new Error("Background shell owner session mismatch.");
                }
                if (input.cwd !== owner.cwd) throw new Error("Background shell cwd mismatch.");
                const { execution } = await this.backgroundShells.create({
                  sessionId: owner.id,
                  requestId: input.requestId,
                  command: input.command,
                  description: input.description,
                  settings: input.settings,
                  shellDescriptor: input.shellDescriptor,
                  executionCwd: input.executionCwd,
                  origin: "tool",
                });
                return { jobId: execution.id, label: execution.description };
              },
            },
            jobs: this.jobs.createDetachedProcessAgentHost(session),
          })),
        workflowRepository: this.workflows,
        workflowHost: this.workflowHost,
        tools: async ({ session,settings }) => {
          const pluginSettings = options.getSettings?.() ?? options.settings;
          return [
            createMcpConfigureTool(new McpConfigApplicationService({ coordinator: this.mcpRuntimes }), session.id, {settings,canConfigure:context=>{const id=context.agent?.scope.runId;const run=id?store.runs.getRun(id):undefined;return !!run && run.sessionId===session.id && typeof run.metadata.pluginId!=="string";}}),
            ...(pluginSettings
              ? [
                  createPluginInstallTool(
                    createDefaultPluginService({ current: pluginSettings }),
                    () => this.agentPool.invalidateWarmAgents(),
                  ),
                ]
              : []),
            imageToTextTool,
            imageGenerationTool,
            createBrowserTool(options.browserHost, async ({ bytes }) => {
              const asset = await this.attachments.import({
                displayName: `browser-${randomUUID()}.png`,
                declaredMediaType: "image/png",
                content: new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(bytes)
                    controller.close()
                  },
                }),
              })
              return (await this.attachments.resolveReadyContentPath(asset.id)).path
            }, () => this.modelCatalog.load()),
            createBrowserDeveloperTool(options.browserHost),
          ]
        },
        toolDecorators: [{ name: "Read", decorate: base => {
          const decorated = createAttachmentReadTool({
            defaultTool: base,
            authorizationSessions: attachmentAuthorizationSessions,
            attachmentReader,
            supportsImageInput: async (context) =>
              supportsNativeImageInput(context, await this.modelCatalog.load()),
            localOcr: this.localOcr,
          });
          // Only this host-owned read wrapper may inherit the verified builtin promise.
          return isTrustedReadOnlyTool(base) ? markTrustedReadOnlyTool(decorated) : decorated;
        } }],
        requestPermission: async (request, context) => {
          const owner = store.sessions.get(context.sessionId);
          const settings = owner && options.getSettingsForCwd
            ? await options.getSettingsForCwd(sessionSettingsRoot(owner))
            : options.getSettings?.() ?? options.settings;
          return this.permissions.ask(sessionPermissionRequest({ store, settings, request, context }));
        },
        askUserPrompt: async (question, context) => {
          let input: Record<string, unknown> = { kind: "question", question };
          try {
            const parsed = JSON.parse(question) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              const record = parsed as Record<string, unknown>;
              if (record.kind === "question" && Array.isArray(record.questions)) {
                input = record;
              }
            }
          } catch {
            // Plain text question; keep the fallback payload.
          }
          const decision = await this.permissions.ask({
            sessionId: context.sessionId,
            runId: context.runId,
            traceId: context.traceId,
            toolName: "AskUser",
            reason: typeof input.question === "string" ? input.question : "请回答问题",
            input,
            signal: context.signal,
          });
          if (decision.status !== "approved") {
            throw new Error(decision.reason ?? "用户未回答问题");
          }
          return decision.answer ?? "";
        },
        schedules: {
          create: async (input) => this.schedules.createTask({ ...input, createdBy: "agent" }),
          update: async (id, patch) => this.schedules.updateTask(id, patch),
          remove: async (id) => this.schedules.removeTask(id),
          list: async () => this.schedules.listTasks(),
          trigger: async (id) => this.schedules.trigger(id),
          listRuns: async (taskId) => this.schedules.listRuns({ taskId }),
        },
        onRunCapabilities: snapshot => {
          const releaseToolSafety = toolSafety.onRunCapabilities(snapshot);
          try {
            pluginCapabilities.authorizeRun(snapshot);
            const releaseOrigins = toolAppOrigins.capture(snapshot);
            return () => { try { releaseOrigins(); } finally { releaseToolSafety(); } };
          } catch (error) { releaseToolSafety(); throw error; }
        },
        // 这就是投影：Agent 的 onEvent 进这里，写成会话记录再推给窗口。
        createEventSink: (agent, session) => {
          const projector = new DaemonAgentEventProjector({
            projectorId: `${DAEMON_AGENT_PROJECTOR}:${agent.id}`,
            rootSessionId: session.id,
            rootAgent: agent,
            toolAppOrigins,
            store,
            transcriptProjection: this.transcriptProjection,
            executionProjector: this.executionProjector,
            liveChildren: this.liveChildren,
            events: this.eventPublisher,
            log: options.log,
          });
          return (event) => projector.apply(event);
        },
      });
      // 一个会话一个热着的 Agent。子 Agent 自己占会话，不要被这个池子抢去。
      this.agentPool = new AgentPool({
        sessionQueries: {
          getSession: (id) => store.sessions.get(id),
          listSessions: (input) => store.sessions.list(input),
          listMessages: (id) => store.conversations.listMessages(id),
          listMessageParts: (id) => store.conversations.listMessageParts(id),
        },
        loadAgent,
        supplementalSections: (sessionId) => {
          const section = buildCompactAttachmentSection({
            listSessionInputAttachments: (id) => store.conversations.listSessionInputAttachments(id),
            attachments: store.attachments,
          }, sessionId);
          return section ? [section] : [];
        },
        sessionMemory: (sessionId) => {
          const session = store.sessions.get(sessionId);
          return session
            ? sessionMemoryToCompactText(
                getSessionMemoryContent(getSessionMemoryPath(session.cwd, sessionId)),
              )
            : "";
        },
        isSessionExternallyOwned: (sessionId) => this.liveChildren.has(sessionId),
      });

      // 一次 prompt 跑完才做：写记忆、个性化、auto-dream。失败的半截对话不写进去。
      const postRunMaintenance = new SessionPostRunMaintenance({
        data: { conversations: store.conversations, runs: store.runs, sessions: store.sessions, goals: store.goals },
        getSettings: async (cwd) =>
          options.getSettingsForCwd
            ? await options.getSettingsForCwd(cwd)
            : (options.getSettings?.() ?? options.settings),
        log: options.log,
        sessionMemoryWriter: (cwd, messages, sessionId, goal) =>
          updateSessionMemoryFile(cwd, messages, {
            sessionId,
            ...(goal ? { toolMetadata: { task_focus_state: { goal } } } : {}),
          }),
        lastConsolidatedAt: readLastConsolidatedAt,
        autoDream: (input) => executeAutoDream({
          ...input, taskRunner: this.executionOwner.getDetachedProcessSupervisor(input.cwd),
        }),
      });

      const contextUsageCache = sharedContextUsageCache;
      const resolveSessionSettings = runtimeDiscovery.resolveSettings;
      const resolveSessionModelLimits = runtimeDiscovery.resolveModelLimits;
      const resolveSessionSkillsList = runtimeDiscovery.resolveSkillsList;
      const refreshContextUsage = async (sessionId: string, agent: SessionContextUsageAgent) => {
        const session = store.sessions.get(sessionId);
        if (!session) return;
        const settings = await resolveSessionSettings(session.cwd);
        if (!settings) return;
        const runtime = readSessionRuntimeConfig(session, {
          provider: settings.provider,
        });
        const limits = await resolveSessionModelLimits(session, settings);
        const skillsList = await resolveSessionSkillsList(session.cwd, settings);
        await assembleSessionContextUsage({
          sessionId,
          cwd: session.cwd,
          model: runtime.model,
          settings,
          agent,
          cache: contextUsageCache,
          contextWindow: limits.contextWindow,
          outputLimit: limits.outputLimit,
          skillsList,
        });
      };
      bindContextUsageLiveAssembler(async ({ sessionId, cwd, previousContextWindow }) => {
        if (!this.agentPool.configured) return null;
        const session = store.sessions.get(sessionId);
        if (!session) return null;
        const settings = await resolveSessionSettings(session.cwd || cwd);
        if (!settings) return null;
        const runtime = readSessionRuntimeConfig(session, {
          provider: settings.provider,
        });
        const limits = await resolveSessionModelLimits(session, settings);
        const sessionCwd = session.cwd || cwd;
        const skillsList = await resolveSessionSkillsList(sessionCwd, settings);
        return await tryAssembleSessionContextUsageLive({
          sessionId,
          cwd: sessionCwd,
          model: runtime.model,
          settings,
          cache: contextUsageCache,
          previousContextWindow,
          contextWindow: limits.contextWindow,
          outputLimit: limits.outputLimit,
          skillsList,
          getAgent: async () => {
            const warm = await this.agentPool.getHosted(sessionId);
            if (warm) return hostedContextUsageAgent(warm);
            try {
              return hostedContextUsageAgent(await this.agentPool.acquireHostedSession(sessionId));
            } catch {
              return undefined;
            }
          },
        });
      });

      const gitInspector = createGitRunChangeInspector();
      const workspaceChanges = new SessionWorkspaceChanges({
        session: store, events: this.eventPublisher, inspector: gitInspector,
        log: (entry) => options.log({ level: "warn", event: "workspace_changes.failed", runId: String(entry.runId), error: String(entry.error) }),
      });
      const autoReview = new SessionAutoReviewService({
        session: store,
        events: this.eventPublisher,
        inspector: gitInspector,
        hasUserWork: (sessionId) => this.runControl.hasUserWork(sessionId),
        log: (entry) => {
          options.log({
            level: "warn",
            event: typeof entry.event === "string" ? entry.event : "auto_review.error",
            ...(typeof entry.sessionId === "string" ? { sessionId: entry.sessionId } : {}),
            ...(typeof entry.runId === "string" ? { runId: entry.runId } : {}),
            ...(typeof entry.error === "string" ? { error: entry.error } : {}),
          });
        },
      });

      const runExecution = assembleSessionRunExecutor({
        store, attachmentService: this.attachments, goals: store.goals,
        checkGoalExecution: (goalId, version) => this.goals.checkExecution(goalId, version),
        checkGoalRunExecution: (goalId, version, runId, boundary, tool) => this.goals.checkRunExecution(goalId, version, runId, boundary, tool),
        readGoalSnapshot: (goalId, version, runId) => this.goals.readSnapshot(goalId, version, runId),
        submitGoalUpdate: (goalId, version, runId, input) => this.goals.submitRunUpdate(goalId, version, runId, input),
        agentPool: this.agentPool, events: this.eventPublisher, transcriptProjection: this.transcriptProjection,
        traceIdForRun: (runId) => this.traceIdForRun(runId), log: options.log, postRunMaintenance,
        attachmentResources: this.attachmentResources, attachmentOcrAvailable: true, contextUsageCache, refreshContextUsage,
        resolveSessionSettings, autoReview, workspaceChanges,
      });
      const runExecutor = runExecution.executor;
      const materializeSteerInput = runExecution.materializeSteerInput;
      const runServices = assembleSessionRunServices({
        materializePluginAppContexts: (sessionId, value) => this.pluginApps.apps.materializeComposerContexts(sessionId, value),
        children: this.liveChildren,
        pendingPermissionId: (sessionId) => store.permissions.list({ sessionId, status: "pending" })[0]?.id,
        store, goals: store.goals, agentPool: this.agentPool, runExecutor, events: this.eventPublisher,
        preemptAutoReview: (sessionId) => autoReview.preemptForUserInput(sessionId),
        attachmentLimits: this.attachments.limits, materializeSteerInput,
        assertReady: () => this.assertReady(),
        settleGoalRun: (sessionId, runId) => this.goals.settleRun(sessionId, runId),
        settleQueuedGoalResume: (sessionId, failed) => this.goals.settleQueuedResume(sessionId, failed),
        checkGoalExecution: (goalId, version) => this.goals.checkExecution(goalId, version),
      });
      this.runAdmission = runServices.admission;
      this.runControl = runServices.control;
      this.runEngine = runServices.engine;
      this.pluginApps = assemblePluginApps({ store, operations: this.operationRunner, engine: this.runEngine,
        acquireSession: id => this.agentPool.acquireHostedSession(id), operationGate: this.operationGate, events: this.eventPublisher,
        settings: async cwd => await resolveSessionSettings(cwd),
        interrupt: (sessionId, runId) => { this.runControl.interruptRun(sessionId, runId, "plugin_app_cancelled"); },
        waitForRuns: ids => this.runControl.waitForRuns(ids),
      });
      const pluginAppModelAvailable = async (sessionId: string) => {
          if (!this.agentPool.configured) return false;
          const session = store.sessions.get(sessionId);
          if (!session) return false;
          const settings = await resolveSessionSettings(session.cwd);
          if (!settings) return false;
          const runtime = readSessionRuntimeConfig(session, { provider: settings.provider });
          validateRequestSelection({ catalog: await this.modelCatalog.load(), provider: runtime.provider,
            model: runtime.model, effort: runtime.effort, explicitEffort: false, customProviders: settings.customProviders });
          return true;
      };
      this.pluginAppConversation = new PluginAppConversationService({ store, apps: this.pluginApps.apps, actions: this.pluginApps.actions,
        operations: this.operationRunner, admission: this.runAdmission, pluginCapabilities, modelAvailable: pluginAppModelAvailable });
      /**
       * 控制服务：
       * 1. 接收控制命令（如停止、重启）
       * 2. 管理会话状态（如暂停、恢复）
       * 3. 处理会话生命周期事件
       * 4. 与其他服务交互（如会话管理、日志记录）
       */
      this.control = new DaemonControlService({
        store: {
          sessions: store.sessions,
          runs: store.runs,
          conversations: store.conversations,
          listSessionTasks: (id) => store.runs.listSessionTasks(id),
          listProjectionSettlements: (input) => store["listProjectionSettlements"](input),
        },
        permissions: store.permissions,
        workflows: store.workflows,
        executionObservations: new ExecutionObservationService({
          readSessions: () => readSessionExecutionObservations({
            listSessions: () => store.sessions.list({ includeArchived: true }),
            listRuns: (sessionId) => store.runs.listRuns(sessionId),
            listRunAttempts: (runId) => store.runs.listRunAttempts(runId),
            listSessionTasks: (sessionId) => store.runs.listSessionTasks(sessionId),
          }),
          readWorkflows: (backing) => readWorkflowExecutionObservations(this.workflows, backing),
        }),
        runControl: this.runControl,
        agentPool: this.agentPool,
        operationGate: this.operationGate,
        startedAt: Date.now(),
        sseClientCount: () => this.events.subscriberCount,
      });
      /**
       * 维护服务：
       * 1. 定期检查和清理会话数据
       * 2. 处理会话的自动维护任务
       * 3. 与其他服务交互（如会话管理、日志记录）
       */
      this.maintenance = new SessionMaintenanceService({
        data: {
          runs: store.runs,
          conversations: store.conversations,
          conversationTransactions: store.conversationTransactions,
          sessions: store.sessions,
        },
        runControl: this.runControl,
        agentPool: this.agentPool,
        liveChildren: this.liveChildren,
        operationGate: this.operationGate,
        events: this.eventPublisher,
        contextUsageCache,
        refreshContextUsage,
      });
      /**
       * 会话服务：
       * 1. 管理会话的生命周期（创建、销毁、状态管理）
       * 2. 处理会话的输入和输出（如消息接收、发送）
       * 3. 与其他服务交互（如控制服务、维护服务）
       * 4. 提供会话相关的查询和操作接口
       */
      this.queries = new SessionQueryService({
        getSession: (id) => store.sessions.get(id),
        listSessions: (input) => store.sessions.list(input),
        getSessionState: (id) => store.conversationTransactions.getSessionState(id),
        listMessages: (id, input) => store.conversations.listMessages(id, input),
        listMessageParts: (id, input) => store.conversations.listMessageParts(id, input),
        resolveSessionListTitle: (id) => store["resolveSessionListTitle"](id),
      });
      this.commands = new SessionCommandService({
        pluginLifecycle: this.pluginLifecycle,
        validateRequestSelection: async ({ session, next, explicitEffort }) => {
          const settings = options.getSettingsForCwd
            ? await options.getSettingsForCwd(session.cwd)
            : (options.getSettings?.() ?? options.settings);
          return validateRequestSelection({
            catalog: await this.modelCatalog.load(),
            provider: next.provider ?? settings?.provider,
            model: next.model,
            effort: next.effort,
            explicitEffort,
            customProviders: settings?.customProviders,
          });
        },
        sessions: {
          createSession: (input) => store.sessions.create(input),
          getSession: (id) => store.sessions.get(id),
          updateSession: (id, input) => store.sessions.update(id, input),
          clearWorktreeBinding: (id, input) => store.sessions.clearWorktreeBinding(id, input),
          archiveSession: (id) => store.sessions.archive(id),
          beginArchive: (id) => store.sessions.beginArchive(id),
          listChildSessions: (id, input) => store.sessions.listChildren(id, input),
          deleteSessionTree: (id) => store.conversationTransactions.deleteSessionTree(id),
          forkSessionWithHistory: (input) => store.conversationTransactions.forkSessionWithHistory(input),
        },
        transactions: {
          transaction: (work) => store.transaction(work),
          createMessage: (input) => store.conversations.createMessage(input),
          upsertMessagePart: (input) => store.conversations.upsertMessagePart(input),
        },
        runtimeControl: {
          closeAgent: (id) => this.agentPool.close(id),
          hasActiveWorkForSession: (id) => this.agentPool.hasActiveWorkForSession(id),
          interruptSession: (id) => this.runControl.interruptSession(id),
          waitForRuns: (ids) => this.runControl.waitForRuns(ids),
          hasRunWork: (id) => this.runControl.hasWork(id),
          interruptLiveChild: (id, reason) => this.liveChildren.interrupt(id, reason),
          hasLiveChild: (id) => this.liveChildren.has(id),
          warmSession: (session) => {
            let lease;
            try {
              lease = this.operationGate.enter({
                sessionId: session.id,
                cwd: session.cwd,
              });
            } catch (error) {
              if (error instanceof DaemonOperationUnavailableError) return;
              throw error;
            }
            void this.agentPool.warm(session.id).finally(() => lease.release());
          },
        },
        operationGate: this.operationGate,
        events: this.eventPublisher,
        contextUsageCache,
        assertReady: () => this.assertReady(),
      });
      this.interactions = new SessionInteractionService({
        sessions: store.sessions,
        conversations: store.conversations,
        runs: store.runs,
        admission: this.runAdmission,
        control: this.runControl,
        operationRunner: this.operationRunner,
        agentPool: this.agentPool,
        liveChildren: this.liveChildren,
        operationGate: this.operationGate,
        resolveSkillCatalog: runtimeDiscovery.resolveSkillCatalog,
        pluginCapabilities,
      });
      this.facts = createProjectFactsService({ control: this.control, sessions: store.sessions, readiness: () => this.diagnosticState });
      this.goals = new SessionGoalService({
        transaction: store,
        sessions: store.sessions,
        runs: store.runs,
        permissions: store.permissions,
        goals: store.goals,
        operationRunner: this.operationRunner,
        admission: this.runAdmission,
        control: this.runControl,
        events: this.eventPublisher,
        pluginCapabilities,
        waitVerifier: new GoalWaitVerifier({
          store,
        }),
      });
      /**
       * 通道服务：
       * 1. 管理会话的通信通道（如 SSE、WebSocket）
       * 2. 处理消息的传递和路由
       * 3. 与其他服务交互（如会话管理、日志记录）
       * 4. 提供通道相关的管理和监控功能
       */
      this.channels = new ChannelApplicationService({
        sessionQueries: {
          getInput: (inputId) => store.conversations.getInput(inputId),
          getSession: (sessionId) => store.sessions.get(sessionId),
        },
        channels: store.channels,
        sessionCommands: this.commands,
        sessionInteractions: this.interactions,
        runControl: this.runControl,
        log: options.log,
        attachments: this.attachments,
        downloadChannelAttachment: (messageId, attachment, signal) =>
          this.channelRuntime?.downloadAttachment(messageId, attachment, signal),
      });
      if (options.channelConfigStore) {
        const channelServices = createDaemonChannelRuntime({
          channelConfig: options.channelConfigStore,
          channels: this.channels,
          getSettings: options.getSettings,
          settings: options.settings,
          outsideProjectWorkspaceRoot: options.outsideProjectWorkspaceRoot,
          log: options.log,
        });
        this.channelRuntime = channelServices.runtime;
        this.channelOnboarding = channelServices.onboarding;
      }
      /**
       * 定时任务服务：
       * 1. 管理定时任务的创建、更新和删除
       * 2. 处理定时任务的执行和调度
       * 3. 与其他服务交互（如会话管理、日志记录）
       * 4. 提供定时任务相关的查询和操作接口
       */
      const scheduledExecutor = new ScheduledTaskExecutor({
        sessionQueries: this.queries,
        sessionCommands: this.commands,
        sessionInteractions: this.interactions,
        runControl: this.runControl,
        outsideProjectWorkspaceRoot: options.outsideProjectWorkspaceRoot,
        settings: options.settings,
        getSettings: options.getSettings,
        getSettingsForCwd: options.getSettingsForCwd,
      });
      this.schedules = new ScheduledTaskService({
        schedules: store.schedules,
        latestEventSeq: () => store.conversations.latestEventSeq(),
        onDurableEvent: (previousEventSeq) => this.eventPublisher.publishSince(previousEventSeq),
        execute: (task, run, onSessionReady) => scheduledExecutor.execute(task, run, onSessionReady),
      });
      /**
       * 后台进程服务：
       * 1. 管理后台进程的生命周期（创建、销毁、状态管理）
       * 2. 处理后台进程的输入和输出（如消息接收、发送）
       * 3. 与其他服务交互（如会话管理、日志记录）
       * 4. 提供后台进程相关的查询和操作接口
       */
      // 构造可以立刻返回；workflow 恢复跑完才算 ready，避免一上来就对半截工作流动手。
      const recovery = new StartupRecoveryService({
        recoverPluginUiActions: () => { retirePluginUiActions(store); this.pluginApps.actions.recover(); },
        recoverProjectionSettlements: () => { recoverProjectionSettlements(store); },
        recoverToolOperations: () => { toolSafety.recoverDispatching(); },
        interruptActiveRuns: () => { store.interruptActiveRuns(DAEMON_RESTART_RUN_REASON); },
        reconcileGoalModelAttempts: () => { store.goals.reconcileGoalModelAttempts(); },
        failIncompleteReviewsOnStartup: () => { workspaceChanges.failIncompleteOnStartup(); return autoReview.failIncompleteReviewsOnStartup(); },
        pauseActiveGoals: () => { store.goals.pauseActiveGoalsOnStartup(); },
        terminalizeUnownedInputs: () => { store.terminalizeUnownedInputs(DAEMON_RESTART_INPUT_REASON); },
        expirePendingPermissions: () => { store.permissions.expirePending(DAEMON_RESTART_PERMISSION_REASON); },
        finalizeClosingSessions: () => { store.finalizeClosingSessions(); },
        recoverAttachments: () => this.attachments.recover(),
        reconcileBackgroundTasks: () => this.backgroundShells.reconcileActiveTasks(DAEMON_RESTART_TASK_REASON),
        recoverGoalWaits: () => { this.goals.recoverExternalWaits(); },
        recoverWorkflows: () => recoverInterruptedWorkflows({ workflowHost: this.workflowHost }),
      });
      this.startupRecovery = recovery.run()
        .then(
          () => {
            if (this.readyState === "starting") this.readyState = "ready";
          },
          (error) => {
            this.readyState = "failed";
            clearInterval(this.ownerHeartbeat);
            store.releaseApplicationOwner(this.ownerLease);
            throw error;
          },
        );
      void this.startupRecovery.catch(() => {});
    } catch (error) {
      void (async () => {
        try { await createdWorkflowHost?.close(); }
        finally { await executionOwner.close(); }
      })().catch(() => {});
      clearInterval(this.ownerHeartbeat);
      store.releaseApplicationOwner(this.ownerLease);
      throw error;
    }
  }

  async ready(): Promise<void> {
    await this.startupRecovery;
    // 后台自动连接 enabled 渠道：不阻塞 listen，也不 reject。
    void this.channelRuntime?.startEnabled();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.readyState = "closing";
    this.closePromise = this.closeWork();
    return this.closePromise;
  }

  /**
   * 关机顺序有意为之：先停新活（定时、control），再拆终端和后台进程，
   * 最后放掉主人锁、关 store。中途失败都攒着，尽量拆干净再一起报。
   */
  private async closeWork(): Promise<void> {
    bindContextUsageLiveAssembler(undefined);
    const failures: unknown[] = [];
    // Stop accepting OAuth logins, abort uncommitted ones and let commit
    // regions settle before the store is released.
    try {
      await this.mcpOAuthOperations.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.startupRecovery;
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.schedules.shutdown();
    } catch (error) {
      failures.push(error);
    }
    // 先有界排空渠道（断入站 + 等 drain），再中断/排空 Run。
    try {
      await this.channelRuntime?.shutdown();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.control.shutdown();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.localOcr.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.terminals.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.workflowHost.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.executionOwner.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.attachmentResources.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      const settlementRecovery = recoverProjectionSettlements(this.options.store);
      if (settlementRecovery.pending > 0) {
        throw new Error(
          `Daemon shutdown left ${settlementRecovery.pending} projection settlement(s) pending`,
        );
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      this.events.close();
    } catch (error) {
      failures.push(error);
    }
    clearInterval(this.ownerHeartbeat);
    try {
      this.store.releaseApplicationOwner(this.ownerLease);
    } catch (error) {
      failures.push(error);
    }
    if (this.options.ownsStore) {
      try {
        this.store.close();
      } catch (error) {
        failures.push(error);
      }
    }
    this.readyState = "closed";
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Daemon application shutdown failed");
  }

  /** 启动没完或已经在关，会话 API 直接拒绝，避免半套图还在对外收 prompt。 */
  private assertReady(): void {
    if (this.readyState === "ready") return;
    if (this.readyState === "failed") {
      throw new Error("Durable Agent Application failed to start");
    }
    if (this.readyState === "closing" || this.readyState === "closed") {
      throw new Error("Durable Agent Application is closing or closed");
    }
    throw new Error("Durable Agent Application is not ready");
  }

  /** 一次 run 全程用同一个 traceId，日志和投影才能对上。没有就补一个写回 store。 */
  private traceIdForRun(runId: string): string {
    const run = this.options.store.runs.getRun(runId);
    const traceId = normalizeTraceId(run?.metadata.traceId);
    if (traceId) return traceId;
    const generated = randomUUID();
    if (run) this.options.store.runs.updateRun(runId, { metadata: { traceId: generated } });
    return generated;
  }
}

function isSessionInTree(
  store: { getSession(sessionId: string): SessionRecord | undefined },
  rootSessionId: string,
  candidateSessionId: string,
): boolean {
  let current = store.getSession(candidateSessionId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (current.id === rootSessionId) return true;
    visited.add(current.id);
    current = current.parentId ? store.getSession(current.parentId) : undefined;
  }
  return false;
}

/**
 * signal 0 不会终止进程，只检查 PID 是否存在。EPERM 表示进程存在但当前用户无权发信号，
 * 这种情况必须按“仍存活”处理，不能冒险启动第二个 daemon。
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // 只有 ESRCH 能确认 PID 不存在；权限错误和未知错误都保守地视为仍存活。
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
