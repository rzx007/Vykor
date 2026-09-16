import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";

import {
  SessionStore,
  type AttachmentApplicationService,
} from "@openharness/services";
import type { Settings } from "@openharness/core";
import type { AttachmentLimits } from "@openharness/protocol";

import type { CommandCatalogProvider } from "../commands/commands.js";
import type { DurableAgentApplication } from "../application/daemon-application.js";
import { createDefaultNodeApplication } from "../application/default-node-application.js";
import type { CreateDaemonAgent } from "../daemon/daemon-agent.js";
import type {
  AgentPersonaService,
  AuthService,
  ContextService,
  DreamService,
  GitService,
  HooksService,
  MemoryService,
  ModelService,
  OutputStyleService,
  PluginService,
  ProfileService,
  ProjectInitService,
  ProviderService,
  SettingsService,
  SkillService,
} from "../application/settings-api.js";
import { createSkillManagementService } from "../application/skill-management-service.js";
import {
  TRACE_ID_HEADER,
  writeStructuredLog,
  type ObservabilityEvent,
  type StructuredLogger,
} from "../shared/observability.js";
import {
  CORS_HEADERS,
  CORS_EXPOSE_HEADERS,
  CORS_METHODS,
  errorResponse,
  normalizeAllowedOrigins,
  type JsonRecord,
} from "./support.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createAttachmentRoutes } from "./routes/attachment.js";
import { createBackgroundShellRoutes } from "./routes/background-shell.js";
import { createChannelRoutes } from "./routes/channel.js";
import { createScheduleRoutes } from "./routes/schedules.js";
import { HttpEventHub } from "./routes/events.js";
import { createGitRoutes } from "./routes/git.js";
import { createJobRoutes } from "./routes/job.js";
import { createMemoryRoutes } from "./routes/memory.js";
import { createPermissionRoutes } from "./routes/permission.js";
import { createProjectRoutes } from "./routes/project.js";
import { createRunExecutionRoutes } from "./routes/run-execution.js";
import { createServiceRoutes } from "./routes/service.js";
import { createSessionRoutes } from "./routes/session.js";
import { createSessionGoalRoutes } from "./routes/session-goal.js";
import { createSessionUtilityRoutes } from "./routes/session-utility.js";
import { createSystemRoutes } from "./routes/system.js";
import { RequestTraceRegistry } from "./control/request-trace-registry.js";
import {
  createTerminalRoutes,
  TerminalHttpEventHub,
} from "./routes/terminal.js";
import type { DaemonTerminalService } from "../terminal/index.js";
import type { DaemonJobService } from "../jobs/index.js";

export interface OpenHarnessServerServices {
  commandCatalog?: CommandCatalogProvider;
  settings?: SettingsService;
  provider?: ProviderService;
  model?: ModelService;
  memory?: MemoryService;
  auth?: AuthService;
  context?: ContextService;
  dream?: DreamService;
  profile?: ProfileService;
  outputStyle?: OutputStyleService;
  projectInit?: ProjectInitService;
  plugin?: PluginService;
  agentPersona?: AgentPersonaService;
  hooks?: HooksService;
  git?: GitService;
  skill?: SkillService;
}

export interface OpenHarnessServerOptions {
  host?: string;
  port?: number;
  token?: string;
  /** Exact browser origins permitted to call this daemon. Empty means native/same-origin clients only. */
  allowedOrigins?: string[];
  store?: SessionStore;
  storePath?: string;
  attachmentRoot?: string;
  attachmentLimits?: Partial<AttachmentLimits>;
  attachments?: AttachmentApplicationService;
  /** 已组装好的应用。传入后，HTTP Server 默认不负责关闭它。 */
  application?: DurableAgentApplication;
  /** 仅在传入 application 时生效；明确让 HTTP Server 随自身一起关闭应用。 */
  closeApplication?: boolean;
  settings?: Settings;
  getSettings?: () => Settings;
  getSettingsForCwd?: (cwd: string) => Promise<Settings>;
  executionSurface?: "desktop_managed" | "cli_advanced";
  outsideProjectWorkspaceRoot?: string;
  /** Test/embedding seam. Production daemon creation uses createDefaultNodeAgent directly. */
  createAgent?: CreateDaemonAgent;
  services?: OpenHarnessServerServices;
  version?: string;
  logger?: StructuredLogger;
}

export type {
  OpenHarnessRuntimeSnapshot,
  OpenHarnessServerHealth,
} from "./support.js";

export interface ListenResult {
  host: string;
  port: number;
  url: string;
}

type Listener = ReturnType<typeof serve>;

export class OpenHarnessHttpServer {
  readonly app: Hono;
  readonly store: SessionStore;
  readonly token?: string;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly services: OpenHarnessServerServices;
  private readonly version?: string;
  private readonly logger: StructuredLogger;
  private readonly eventHub: HttpEventHub;
  readonly application: DurableAgentApplication;
  private readonly ownsApplication: boolean;
  private readonly terminals: DaemonTerminalService;
  private readonly jobs: DaemonJobService;
  private readonly terminalEvents: TerminalHttpEventHub;
  private readonly requestTraces = new RequestTraceRegistry();
  private listener?: Listener;
  private listenResult?: ListenResult;
  private closePromise?: Promise<void>;

  constructor(options: OpenHarnessServerOptions = {}) {
    this.app = new Hono();
    this.token = options.token;
    this.allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins ?? []);
    this.services = options.services ?? {};
    this.version = options.version;
    this.logger = options.logger ?? writeStructuredLog;
    this.application =
      options.application ??
      createDefaultNodeApplication({
        store: options.store,
        storePath: options.storePath,
        attachmentRoot: options.attachmentRoot,
        attachmentLimits: options.attachmentLimits,
        attachments: options.attachments,
        ownsStore: true,
        settings: options.settings,
        getSettings: options.getSettings,
        getSettingsForCwd: options.getSettingsForCwd,
        executionSurface: options.executionSurface,
        outsideProjectWorkspaceRoot: options.outsideProjectWorkspaceRoot,
        createAgent: options.createAgent,
        log: (event) => this.log(event),
      });
    this.ownsApplication = options.application
      ? (options.closeApplication ?? false)
      : true;
    this.store = this.application.store;
    this.terminals = this.application.terminals;
    this.jobs = this.application.jobs;
    this.eventHub = new HttpEventHub(this.application.events);
    this.terminalEvents = new TerminalHttpEventHub(this.terminals);
    this.mountRoutes();
  }

  get url(): string | undefined {
    return this.listenResult?.url;
  }

  async listen(
    options: Pick<OpenHarnessServerOptions, "host" | "port"> = {},
  ): Promise<ListenResult> {
    await this.application.ready();
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 0;
    return await new Promise<ListenResult>((resolve, reject) => {
      const listener = serve(
        {
          fetch: this.app.fetch,
          hostname: host,
          port,
        },
        (info) => {
          this.listener = listener;
          this.listenResult = {
            host,
            port: info.port,
            url: `http://${host}:${info.port}`,
          };
          resolve(this.listenResult);
        },
      );
      listener.once("error", reject);
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const closing = this.closeWork();
    this.closePromise = closing;
    return closing;
  }

  private async closeWork(): Promise<void> {
    const shutdown = this.ownsApplication
      ? this.application.close()
      : Promise.resolve();
    const failures: unknown[] = [];
    try {
      this.eventHub.closeClients();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.terminalEvents.closeClients();
    } catch (error) {
      failures.push(error);
    }
    const listener = this.listener;
    this.listener = undefined;
    const listenerClosed = listener
      ? new Promise<void>((resolve, reject) => {
          listener.close((error?: Error) => {
            if (error) reject(error);
            else resolve();
          });
        })
      : Promise.resolve();
    const settled = await Promise.allSettled([shutdown, listenerClosed]);
    for (const result of settled) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    throwFailures(failures, "OpenHarness server shutdown failed");
  }

  private mountRoutes(): void {
    this.app.onError((error) =>
      errorResponse(
        500,
        error instanceof Error ? error.message : String(error),
      ),
    );

    this.app.use("*", async (c, next) => {
      const traceId = this.requestTraces.assign(
        c.req.raw,
        c.req.header(TRACE_ID_HEADER),
      );
      const startedAt = Date.now();
      try {
        await next();
      } finally {
        c.res.headers.set(TRACE_ID_HEADER, traceId);
        this.log({
          level: "info",
          event: "http.request.completed",
          traceId,
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          durationMs: Date.now() - startedAt,
        });
      }
    });

    this.app.use("*", async (c, next) => {
      const origin = c.req.header("origin");
      if (!origin) {
        await next();
        return;
      }
      if (!this.allowedOrigins.has(origin))
        return errorResponse(403, "Origin is not allowed");
      const headers = {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": CORS_METHODS,
        "access-control-allow-headers": CORS_HEADERS,
        "access-control-expose-headers": CORS_EXPOSE_HEADERS,
        "access-control-max-age": "600",
        vary: "Origin",
      };
      if (c.req.method === "OPTIONS")
        return new Response(null, { status: 204, headers });
      await next();
      for (const [name, value] of Object.entries(headers))
        c.res.headers.set(name, value);
    });

    this.app.use("*", async (c, next) => {
      if (
        c.req.method === "GET" &&
        (c.req.path === "/health" || c.req.path === "/capabilities")
      ) {
        await next();
        return;
      }
      if (!this.authorized(c)) return errorResponse(401, "Unauthorized");
      await next();
    });

    this.app.route(
      "/",
      createSystemRoutes({
        version: this.version,
        commandCatalog: this.services.commandCatalog,
        settingsService: this.services.settings,
        providerService: this.services.provider,
        modelService: this.services.model,
        control: this.application.control,
        retention: this.application.retention,
        attachmentLimits: this.application.attachments.limits,
      }),
    );
    this.app.route(
      "/attachments",
      createAttachmentRoutes(this.application.attachments),
    );
    this.app.route(
      "/memory",
      createMemoryRoutes({
        memoryService: this.services.memory,
        control: this.application.control,
      }),
    );
    this.app.route(
      "/auth",
      createAuthRoutes({
        authService: this.services.auth,
        control: this.application.control,
      }),
    );
    this.app.route(
      "/",
      createServiceRoutes({
        contextService: this.services.context,
        dreamService: this.services.dream,
        profileService: this.services.profile,
        outputStyleService: this.services.outputStyle,
        projectInitService: this.services.projectInit,
        pluginService: this.services.plugin,
        skillService:
          this.services.skill ??
          createSkillManagementService({ projects: this.application.projects }),
        agentPersonaService: this.services.agentPersona,
        hooksService: this.services.hooks,
        control: this.application.control,
      }),
    );
    this.app.route("/git", createGitRoutes({ gitService: this.services.git }));
    this.app.route("/channels", createChannelRoutes(this.application.channels));
    this.app.route(
      "/schedules",
      createScheduleRoutes({ schedules: this.application.schedules }),
    );
    this.app.route(
      "/background-shells",
      createBackgroundShellRoutes({
        backgroundShells: this.application.backgroundShells,
        jobs: this.jobs,
      }),
    );
    this.app.route("/jobs", createJobRoutes(this.jobs));
    this.app.route(
      "/permissions",
      createPermissionRoutes({
        permissions: this.application.permissions,
        traces: this.requestTraces,
      }),
    );
    this.app.route(
      "/terminals",
      createTerminalRoutes(this.terminals, this.terminalEvents),
    );
    this.app.route("/projects", createProjectRoutes(this.application.projects));
    this.app.route(
      "/sessions",
      createSessionUtilityRoutes({
        maintenance: this.application.maintenance,
      }),
    );
    this.app.route(
      "/sessions",
      createSessionRoutes({
        queries: this.application.queries,
        commands: this.application.commands,
        interactions: this.application.interactions,
        traces: this.requestTraces,
      }),
    );
    this.app.route("/sessions", createSessionGoalRoutes(this.application.goals));
    this.app.route(
      "/sessions",
      createRunExecutionRoutes({
        application: this.application.interactions,
        traces: this.requestTraces,
      }),
    );
    this.app.route("/events", this.eventHub.createRoutes());
  }

  private authorized(c: Context): boolean {
    if (!this.token) return true;
    return c.req.header("authorization") === `Bearer ${this.token}`;
  }

  private log(event: ObservabilityEvent): void {
    this.logger(event);
  }
}

export async function startOpenHarnessServer(
  options: OpenHarnessServerOptions = {},
): Promise<{
  server: OpenHarnessHttpServer;
  listen: ListenResult;
}> {
  const server = new OpenHarnessHttpServer(options);
  try {
    const listen = await server.listen(options);
    return { server, listen };
  } catch (error) {
    try {
      await server.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "OpenHarness server startup and cleanup failed",
      );
    }
    throw error;
  }
}

function throwFailures(failures: unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}
