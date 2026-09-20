import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { resolveChannelWorkspaceRoot } from "@openharness/core";
import type { AgentBackgroundShellHost, Settings } from "@openharness/core";
import type { ChannelConfigStore } from "@openharness/auth";
import { createModelCatalogService } from "@openharness/api";
import { fileReadTool } from "@openharness/tools";
import {
  type ObservableJobProducer,
} from "@openharness/agent-runtime";
import type { AgentTerminalHost } from "@openharness/terminal";
import {
  readSessionRuntimeConfig,
  type AttachmentLimits,
  type SessionRecord,
} from "@openharness/protocol";
import {
  AttachmentBlobStore,
  AttachmentIntegrityService,
  LightOcrEngine,
  LocalOcrService,
  closeExecutionRuntimes,
  executeAutoDream,
  getChildAgentExecutionRegistry,
  getDetachedProcessSupervisor,
  getSessionMemoryContent,
  getSessionMemoryPath,
  readLastConsolidatedAt,
  sessionMemoryToCompactText,
  updateSessionMemoryFile,
  type SessionStore,
  type ApplicationOwnerLease,
} from "@openharness/services";

import { AttachmentService } from "./attachments/attachment-service.js";
import { catalogModelReasoningEfforts } from "./default-services/catalog-provider-mapping.js";
import { createDaemonAgentLoader, type CreateDaemonAgent } from "../daemon/daemon-agent.js";
import { ScheduledTaskService } from "../daemon/scheduled-task-service.js";
import { ScheduledTaskExecutor } from "./schedule/scheduled-task-executor.js";
import { DaemonJobService } from "../jobs/daemon-job-service.js";
import type { ObservabilityEvent } from "../shared/observability.js";
import { DaemonTerminalService } from "../terminal/daemon-terminal-service.js";
import { createSessionEnvironmentAcquirer } from "../runtime/session-execution-environment.js";
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
import { SessionInteractionService } from "./session/session-interaction-service.js";
import { SessionOperationRunner } from "./session/session-operation-runner.js";
import { SessionCommandService } from "./session/session-command-service.js";
import { SessionGoalService } from "./session/session-goal-service.js";
import { GoalWaitVerifier } from "./session/goal-wait-verifier.js";
import { SessionEventPublisher } from "./session/session-event-publisher.js";
import { SessionMaintenanceService } from "./session/session-maintenance-service.js";
import { SessionQueryService } from "./session/session-query-service.js";
import { SessionRunEngine } from "./session/session-run-engine.js";
import { assembleSessionRunServices } from "./session/session-run-assembly.js";
import { assembleSessionRunExecutor } from "./session/session-run-executor-assembly.js";
import { createSessionRuntimeDiscovery } from "./session/session-runtime-discovery.js";
import { RunAdmissionService } from "./session/run-admission-service.js";
import { RunControlService } from "./session/run-control-service.js";
import { SessionPluginCapabilityService } from "./session/session-plugin-capability-service.js";
import { SessionPostRunMaintenance } from "./session/session-post-run-maintenance.js";
import { SessionExecutionProjector } from "./session/session-execution-projector.js";
import { BackgroundShellService } from "./session/background-shell-service.js";
import { SessionTranscriptProjection } from "./session/transcript-projection.js";
import { recoverInterruptedWorkflows } from "./session/workflow-recovery.js";
import { StartupRecoveryService } from "./recovery/startup-recovery-service.js";
import { ApplicationEventService } from "./events/application-event-service.js";
import { ProjectApplicationService } from "./project-application-service.js";
import { ChannelApplicationService } from "./channel/channel-application-service.js";
import { ChannelOnboardingService } from "./channel/channel-onboarding-service.js";
import { ChannelRuntimeService } from "../daemon/channel-runtime-service.js";
import { SessionWorkflowRunRepository } from "./workflow/session-workflow-run-repository.js";
import { ApplicationRetentionService } from "./retention/application-retention-service.js";
import { buildCompactAttachmentSection } from "./attachments/resources/compact-attachment-catalog.js";
import { SessionAttachmentResources } from "./attachments/resources/session-attachment-resources.js";
import { sharedContextUsageCache } from "./context-usage-cache.js";
import {
  assembleSessionContextUsage,
  tryAssembleSessionContextUsageLive,
  type SessionContextUsageAgent,
} from "./assemble-session-context-usage.js";
import { bindContextUsageLiveAssembler } from "./context-usage-live-binder.js";
import {
  createAttachmentAuthorizationSessionResolver,
  createAttachmentOcrService,
  createAttachmentTextReader,
} from "./attachments/tools/attachment-access.js";
import { createAttachmentReadTool } from "./attachments/tools/attachment-read-tool.js";
import {
  createDaemonImageGenerationTool,
  createDaemonImageToTextTool,
} from "./visual-tools/index.js";

export interface DaemonApplicationOptions {
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
  readonly store: SessionStore;
  readonly attachments: AttachmentService;
  readonly interactions: SessionInteractionService;
  readonly goals: SessionGoalService;
  readonly queries: SessionQueryService;
  readonly commands: SessionCommandService;
  readonly runControl: RunControlService;
  readonly permissions: StorePermissionBroker;
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
  readonly store: SessionStore;
  readonly attachments: AttachmentService;
  readonly permissions: StorePermissionBroker;
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
  readonly retention: ApplicationRetentionService;
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
  private closePromise?: Promise<void>;
  private readyState: "starting" | "ready" | "failed" | "closing" | "closed" = "starting";
  private ownerLease: ApplicationOwnerLease;
  private readonly ownerHeartbeat: ReturnType<typeof setInterval>;

  constructor(private readonly options: DaemonApplicationOptions) {
    const { store } = options;
    this.store = store;
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
    try {
      const attachmentBlobs = new AttachmentBlobStore({
        root: options.attachmentRoot ?? join(dirname(store.path), "attachments"),
      });
      this.attachments =
        options.attachments ??
        new AttachmentService({
          store: store.attachments,
          blobs: attachmentBlobs,
          limits: options.attachmentLimits,
        });
      this.attachmentResources = new SessionAttachmentResources({
        root: join(dirname(store.path), "attachment-session-resources"),
        attachments: this.attachments,
      });
      const ocrEngine = new LightOcrEngine();
      this.localOcr = new LocalOcrService({
        engine: ocrEngine,
        resolveAsset: async (assetId, signal) => {
          signal?.throwIfAborted();
          const opened = await this.attachments.openContent(assetId);
          return {
            assetId,
            sha256: opened.sha256,
            mediaType: opened.mediaType,
            sizeBytes: opened.sizeBytes,
            bytes: await readAttachmentBytes(opened.content, opened.sizeBytes, signal),
          };
        },
        repository: {
          findCompleted: (assetId, cacheKey) =>
            store.attachments.findCompletedAttachmentRepresentation(assetId, "ocr_text", cacheKey),
          begin: (input) => store.attachments.createAttachmentRepresentation(input),
          complete: (id, output) => store.attachments.completeAttachmentRepresentation(id, output),
          fail: (id, error) => {
            store.attachments.failAttachmentRepresentation(id, error);
          },
        },
      });
      // 上次进程可能是被杀掉的：内存里的 Agent/进程都没了，store 里却还挂着 running。
      // 先把这些半截状态结掉，再对外服务，免得窗口以为还在跑。
      // events：窗口订的 SSE。eventPublisher：各处写完 store 后，把增量广播出去。
      this.events = new ApplicationEventService(store.conversations);
      this.eventPublisher = new SessionEventPublisher(store.conversations, this.events);
      this.workflows = new SessionWorkflowRunRepository({
        workflows: store.workflows,
        events: {
          latestEventSeq: () => store.conversations.latestEventSeq(),
          appendEvent: (input) => store.conversations.appendEvent(input),
        },
        path: store.path,
        onDurableEvent: (previousEventSeq) =>
          this.eventPublisher.publishSince(previousEventSeq),
      });
      this.retention = new ApplicationRetentionService(
        store,
        new AttachmentIntegrityService({
          store,
          attachments: store.attachments,
          blobs: attachmentBlobs,
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
          getSettingsForCwd: async (cwd) =>
            options.getSettingsForCwd
              ? await options.getSettingsForCwd(cwd)
              : (options.getSettings?.() ?? options.settings ?? failMissingSettings()),
          acquireEnvironment: acquireSessionEnvironment,
        },
      );
      this.projects = new ProjectApplicationService(store.projects);
      this.permissions = new StorePermissionBroker({
        permissions: store.permissions,
        getSession: (sessionId) => store.sessions.get(sessionId),
        latestEventSeq: () => store.conversations.latestEventSeq(),
        onChange: (previousEventSeq) => this.eventPublisher.publishSince(previousEventSeq),
        logger: options.log,
      });
      // transcript：把模型吐出的字/工具块写成消息。
      // executionProjector：子 Agent、后台 shell 在会话里的那条「任务」记录。
      this.transcriptProjection = new SessionTranscriptProjection({
        conversations: store.conversations,
        incrementalOutput: store.incrementalOutput,
        runs: store.runs,
      });
      this.executionProjector = new SessionExecutionProjector({
        store,
        getChildAgentExecutionRegistry: (scope) => getChildAgentExecutionRegistry(scope),
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
      };
      this.backgroundShells = new BackgroundShellService({
        store: taskStore,
        executionProjector: this.executionProjector,
        getDetachedProcessSupervisor: (scope) => getDetachedProcessSupervisor(scope),
        events: this.eventPublisher,
        getSettingsForCwd: async (cwd) =>
          options.getSettingsForCwd
            ? await options.getSettingsForCwd(cwd)
            : (options.getSettings?.() ?? options.settings ?? failMissingSettings()),
        acquireEnvironment: acquireSessionEnvironment,
      });
      // JobWait / JobList 走这里：终端、后台 shell、子 Agent、workflow 合成一张本会话任务表。
      this.jobs = new DaemonJobService(
        taskStore,
        this.terminals,
        (scope) => getDetachedProcessSupervisor(scope),
        (scope) => getChildAgentExecutionRegistry(scope),
        this.workflows,
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
      });
      const imageGenerationTool = createDaemonImageGenerationTool({
        attachments: this.attachments,
      });

      // 每个会话第一次用时，在这里造活 Agent，并接上投影。
      const loadAgent = createDaemonAgentLoader({
        executionSurface: options.executionSurface,
        settings: options.settings,
        getSettings: options.getSettings,
        getSettingsForCwd: options.getSettingsForCwd,
        resolveReasoningEfforts: async ({ provider, model }) => {
          if (!provider || !model) return undefined;
          const catalog = await this.modelCatalog.load();
          return catalogModelReasoningEfforts(catalog, provider, model);
        },
        createAgent: options.createAgent,
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
                  origin: "tool",
                });
                return { jobId: execution.id, label: execution.description };
              },
            },
            jobs: this.jobs.createDetachedProcessAgentHost(session),
          })),
        workflowRepository: this.workflows,
        tools: async () => [imageToTextTool, imageGenerationTool],
        toolOverrides: [
          createAttachmentReadTool({
            defaultTool: fileReadTool,
            authorizationSessions: attachmentAuthorizationSessions,
            attachmentReader,
          }),
        ],
        trustedToolOverrides: ["Read"],
        requestPermission: async (request, context) => {
          // 工具要写文件时，弹到会话的权限请求里，等人点允许。没有宿主就在 loader 里默认拒绝。
          return await this.permissions.ask({
            sessionId: context.sessionId,
            runId: context.runId,
            traceId: context.traceId,
            toolName: request.toolName,
            reason: request.reason,
            input: request.input,
            signal: context.signal,
          });
        },
        schedules: {
          create: async (input) => this.schedules.createTask({ ...input, createdBy: "agent" }),
          update: async (id, patch) => this.schedules.updateTask(id, patch),
          remove: async (id) => this.schedules.removeTask(id),
          list: async () => this.schedules.listTasks(),
          trigger: async (id) => this.schedules.trigger(id),
          listRuns: async (taskId) => this.schedules.listRuns({ taskId }),
        },
        // 这就是投影：Agent 的 onEvent 进这里，写成会话记录再推给窗口。
        createEventSink: (agent, session) => {
          const projector = new DaemonAgentEventProjector({
            projectorId: `${DAEMON_AGENT_PROJECTOR}:${agent.id}`,
            rootSessionId: session.id,
            rootAgent: agent,
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
        data: { conversations: store.conversations, runs: store.runs, sessions: store.sessions },
        getSettings: async (cwd) =>
          options.getSettingsForCwd
            ? await options.getSettingsForCwd(cwd)
            : (options.getSettings?.() ?? options.settings),
        log: options.log,
        sessionMemoryWriter: (cwd, messages, sessionId) =>
          updateSessionMemoryFile(cwd, messages, { sessionId }),
        lastConsolidatedAt: readLastConsolidatedAt,
        autoDream: executeAutoDream,
      });

      const contextUsageCache = sharedContextUsageCache;
      const runtimeDiscovery = createSessionRuntimeDiscovery(options);
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
            const warm = await this.agentPool.get(sessionId);
            if (warm) return warm;
            try {
              return await this.agentPool.acquireSession(sessionId);
            } catch {
              return undefined;
            }
          },
        });
      });

      const runExecution = assembleSessionRunExecutor({
        store, attachmentService: this.attachments, goals: store.goals,
        agentPool: this.agentPool, events: this.eventPublisher, transcriptProjection: this.transcriptProjection,
        traceIdForRun: (runId) => this.traceIdForRun(runId), log: options.log, postRunMaintenance,
        attachmentResources: this.attachmentResources, attachmentOcrAvailable: true, contextUsageCache, refreshContextUsage,
        resolveSessionSettings,
      });
      const runExecutor = runExecution.executor;
      const materializeSteerInput = runExecution.materializeSteerInput;
      const runServices = assembleSessionRunServices({
        store, goals: store.goals, agentPool: this.agentPool, runExecutor, events: this.eventPublisher,
        attachmentLimits: this.attachments.limits, materializeSteerInput,
        assertReady: () => this.assertReady(),
        settleGoalRun: (sessionId, runId) => this.goals.settleRun(sessionId, runId),
      });
      this.runAdmission = runServices.admission;
      this.runControl = runServices.control;
      this.runEngine = runServices.engine;
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
      const pluginCapabilities = new SessionPluginCapabilityService({
        resolveInventory: runtimeDiscovery.resolvePluginInventory,
      });
      this.queries = new SessionQueryService({
        getSession: (id) => store.sessions.get(id),
        listSessions: (input) => store.sessions.list(input),
        getSessionState: (id) => store.conversationTransactions.getSessionState(id),
        listMessages: (id, input) => store.conversations.listMessages(id, input),
        listMessageParts: (id, input) => store.conversations.listMessageParts(id, input),
        resolveSessionListTitle: (id) => store["resolveSessionListTitle"](id),
      });
      this.commands = new SessionCommandService({
        sessions: {
          createSession: (input) => store.sessions.create(input),
          getSession: (id) => store.sessions.get(id),
          updateSession: (id, input) => store.sessions.update(id, input),
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
      this.operationRunner = new SessionOperationRunner({
        sessions: store.sessions,
        operationGate: this.operationGate,
        events: this.eventPublisher,
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
      this.goals = new SessionGoalService({
        transaction: store,
        sessions: store.sessions,
        runs: store.runs,
        conversations: store.conversations,
        permissions: store.permissions,
        goals: store.goals,
        operationRunner: this.operationRunner,
        admission: this.runAdmission,
        control: this.runControl,
        events: this.eventPublisher,
        pluginCapabilities,
        waitVerifier: new GoalWaitVerifier({
          store,
          liveChildren: this.liveChildren,
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
        downloadChannelAttachment: (messageId, attachment) =>
          this.channelRuntime?.downloadAttachment(messageId, attachment),
      });
      if (options.channelConfigStore) {
        const channelConfig = options.channelConfigStore;
        this.channelRuntime = new ChannelRuntimeService({
          application: {
            handleMessage: (input) => this.channels.handleMessage(input),
            pendingDeliveries: async (listOptions) =>
              this.channels.pendingDeliveries(listOptions),
            recordDelivery: async (id, input) =>
              this.channels.recordDelivery(id, input),
          },
          config: { getFeishu: () => channelConfig.getFeishu() },
          getSettings: () => options.getSettings?.() ?? options.settings,
          workspaceRoot: resolveChannelWorkspaceRoot({
            envDir: process.env.OPENHARNESS_CHANNELS_DIR,
            outsideProjectWorkspaceRoot: options.outsideProjectWorkspaceRoot,
            homedir: homedir(),
          }),
          logger: options.log,
        });
        this.channelOnboarding = new ChannelOnboardingService({
          config: channelConfig,
          onConfigChanged: async () => {
            await this.channelRuntime?.applyFeishuConfig(
              await channelConfig.getFeishu(),
            );
          },
          readBotName: () =>
            this.channelRuntime
              ?.status()
              .connectors.find((connector) => connector.connector === "feishu")
              ?.botName,
          logger: options.log,
        });
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
        recoverProjectionSettlements: () => { recoverProjectionSettlements(store); },
        interruptActiveRuns: () => { store.interruptActiveRuns(DAEMON_RESTART_RUN_REASON); },
        pauseActiveGoals: () => { store.goals.pauseActiveGoalsOnStartup(); },
        terminalizeUnownedInputs: () => { store.terminalizeUnownedInputs(DAEMON_RESTART_INPUT_REASON); },
        expirePendingPermissions: () => { store.permissions.expirePending(DAEMON_RESTART_PERMISSION_REASON); },
        finalizeClosingSessions: () => { store.finalizeClosingSessions(); },
        recoverAttachments: () => this.attachments.recover(),
        reconcileBackgroundTasks: () => this.backgroundShells.reconcileActiveTasks(DAEMON_RESTART_TASK_REASON),
        recoverWorkflows: () => recoverInterruptedWorkflows({ workflows: this.workflows }),
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
      await closeExecutionRuntimes();
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

async function readAttachmentBytes(
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > expectedBytes) throw new Error("attachment content exceeded recorded size");
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (size !== expectedBytes) throw new Error("attachment content size did not match its record");
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
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
