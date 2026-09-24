import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createWorkflowPlan,
  createWorkflowRunSnapshot,
} from "@vykor/coordinator";
import type { JobSnapshot } from "@vykor/jobs";
import type {
  AgentChildInput,
  AgentChildDirectory,
  AgentChildHandle,
  AgentEvent,
  AgentEventContext,
  AgentEventInput,
  AgentEventListener,
  AgentPermissionRequest,
  AgentPermissionDecision,
  AgentRunHandle,
  AgentRunResult,
  Message,
} from "@vykor/core";
import type {
  AgentCapabilitySnapshot,
  AgentCompactResult,
  AgentInspection,
  AgentRememberResult,
  VykorAgent,
} from "@vykor/agent-runtime";
import type { CommandCatalogProvider } from "../../commands/commands.js";
import {
  getDetachedProcessSupervisor,
  SessionStore,
} from "@vykor/services";
import { DEFAULT_ATTACHMENT_LIMITS } from "@vykor/protocol";
import type {
  CreateDaemonAgent,
  CreateDaemonAgentContext,
} from "../../daemon/daemon-agent.js";
import { VykorHttpServer, startVykorServer } from "../server.js";
import { getDefaultSessionStorePath } from "../../daemon/paths.js";
import type {
  VykorServerOptions,
  VykorServerServices,
} from "../server.js";
import type { ObservabilityEvent } from "../../shared/observability.js";
import { projectionSettlementInput } from "../../application/agent/projection-settlement-recovery.js";

const serverTestConfigDir = mkdtempSync(join(tmpdir(), "oh-server-config-"));
// HTTP fixtures represent current clients; version rejection has dedicated middleware tests.
const fetch: typeof globalThis.fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("x-vykor-protocol-version", "4");
  return globalThis.fetch(input, { ...init, headers });
};
let previousConfigDir: string | undefined;

beforeAll(() => {
  previousConfigDir = process.env.VYKOR_CONFIG_DIR;
  process.env.VYKOR_CONFIG_DIR = serverTestConfigDir;
});

afterAll(() => {
  if (previousConfigDir === undefined)
    delete process.env.VYKOR_CONFIG_DIR;
  else process.env.VYKOR_CONFIG_DIR = previousConfigDir;
  rmSync(serverTestConfigDir, { recursive: true, force: true });
});

interface TestAgentProgram {
  runPrompt(input: any, run: TestAgentRunContext): Promise<unknown>;
  close(): Promise<void>;
  children?: AgentChildDirectory;
  inspect?(): AgentInspection;
  compact?(): Promise<{
    messageCount: number;
    transcript: Array<{ role: string; parts: Array<Record<string, any>> }>;
  }>;
  remember?(): Promise<AgentRememberResult>;
  getUsage?(): ReturnType<VykorAgent["getUsage"]> & {
    messageCount?: number;
  };
}

interface TestAgentRunContext {
  emit(
    event: AgentEventInput,
    context?: Partial<AgentEventContext>,
  ): Promise<void>;
  requestPermission(
    request: AgentPermissionRequest,
  ): Promise<AgentPermissionDecision>;
}

interface TestAgentProgramFactory {
  createRuntime(context: CreateDaemonAgentContext): Promise<TestAgentProgram>;
}

function adaptTestAgentFactory(
  factory: TestAgentProgramFactory,
): CreateDaemonAgent {
  return async (context) => {
    const program = await factory.createRuntime(context);
    let history: Message[] = [];
    const listeners = new Set<AgentEventListener>();
    let sequence = 0;
    let state: VykorAgent["state"] = "idle";
    let activeHandle: AgentRunHandle | undefined;
    let closePromise: Promise<void> | undefined;
    const emit = async (
      input: AgentEventInput,
      eventContext: AgentEventContext,
    ): Promise<void> => {
      const event = {
        ...input,
        id: `test-event-${++sequence}`,
        sequence,
        occurredAt: new Date().toISOString(),
        context: eventContext,
      } as AgentEvent;
      await context.options.onEvent?.(event);
      for (const listener of listeners) await listener(event);
    };
    return {
      id: context.session.id,
      get state() {
        return state;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      children: program.children ?? {
        get: () => undefined,
        getBySessionId: () => undefined,
        list: () => [],
      },
      submitMessage(content, options = {}) {
        if (state !== "idle") throw new Error(`Agent is ${state}`);
        state = "running";
        const ids = options.ids ?? {
          inputId: "test-input",
          runId: "test-run",
          traceId: "test-trace",
        };
        const controller = new AbortController();
        const pending: AgentChildInput[] = [];
        const steerWaiters: Array<(input: AgentChildInput) => void> = [];
        const onAbort = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        const eventContext: AgentEventContext = {
          agentId: context.session.id,
          sessionId: context.session.id,
          inputId: ids.inputId,
          runId: ids.runId,
          traceId: ids.traceId,
        };
        let output = "";
        let handle!: AgentRunHandle;
        const result = Promise.resolve().then(
          async (): Promise<AgentRunResult> => {
            try {
              await emit(
                {
                  type: "input.accepted",
                  data: {
                    content,
                    delivery: options.delivery ?? "queue",
                    ...(options.metadata ? { metadata: options.metadata } : {}),
                  },
                },
                eventContext,
              );
              await emit({ type: "run.started", data: {} }, eventContext);
              const runContext: TestAgentRunContext = {
                emit: async (event, override = {}) => {
                  if (event.type === "output.text.delta")
                    output += event.data.delta;
                  await emit(event, { ...eventContext, ...override });
                },
                requestPermission: async (request) => {
                  const requestId = `permission-${sequence + 1}`;
                  await emit(
                    {
                      type: "permission.requested",
                      data: { requestId, request },
                    },
                    eventContext,
                  );
                  const requestPermission =
                    context.options.effects?.requestPermission;
                  if (!requestPermission)
                    throw new Error("Permission effect is not configured");
                  const decision = await requestPermission(request, {
                    agentId: context.session.id,
                    sessionId: context.session.id,
                    inputId: ids.inputId,
                    runId: ids.runId,
                    traceId: ids.traceId,
                    cwd: context.session.cwd,
                    signal: controller.signal,
                  });
                  await emit(
                    {
                      type: "permission.resolved",
                      data: { requestId, decision },
                    },
                    eventContext,
                  );
                  return decision;
                },
              };
              await program.runPrompt(
                {
                  session: context.session,
                  input: { content },
                  history: context.history,
                  parts: context.parts,
                  signal: controller.signal,
                  waitForSteer: async () =>
                    pending.shift() ??
                    (await new Promise<AgentChildInput>((resolve) =>
                      steerWaiters.push(resolve),
                    )),
                  drainSteeredInputs: () => pending.splice(0),
                },
                runContext,
              );
              if (controller.signal.aborted)
                throw new Error(
                  String(controller.signal.reason ?? "Run interrupted"),
                );
              await emit(
                { type: "run.completed", data: { output } },
                eventContext,
              );
              return {
                status: "completed",
                output,
                history,
                usage: { inputTokens: 0, outputTokens: 0 },
              };
            } catch (error) {
              const serialized = {
                name: "Error",
                message: error instanceof Error ? error.message : String(error),
              };
              await emit(
                {
                  type: controller.signal.aborted
                    ? "run.interrupted"
                    : "run.failed",
                  data: { error: serialized, ...(output ? { output } : {}) },
                },
                eventContext,
              );
              throw error;
            } finally {
              options.signal?.removeEventListener("abort", onAbort);
              if (activeHandle === handle) activeHandle = undefined;
              if (state === "running") state = "idle";
            }
          },
        );
        handle = {
          id: ids.runId,
          inputId: ids.inputId,
          sessionId: context.session.id,
          traceId: ids.traceId,
          started: Promise.resolve({
            sessionId: context.session.id,
            inputId: ids.inputId,
            runId: ids.runId,
          }),
          result,
          steer: async (input) => {
            const accepted = {
              ...input,
              id: input.id ?? `steer-${sequence + 1}`,
              traceId: input.traceId ?? ids.traceId,
            };
            await emit(
              {
                type: "input.accepted",
                data: {
                  content: accepted.content,
                  delivery: "steer",
                  ...(accepted.metadata ? { metadata: accepted.metadata } : {}),
                },
              },
              {
                ...eventContext,
                inputId: accepted.id,
                traceId: accepted.traceId,
              },
            );
            const waiter = steerWaiters.shift();
            if (waiter) waiter(accepted);
            else pending.push(accepted);
            return {
              sessionId: context.session.id,
              inputId: accepted.id,
              runId: ids.runId,
            };
          },
          interrupt: async (reason) => {
            controller.abort(reason ?? "Run interrupted");
            await result.catch(() => {});
          },
        };
        activeHandle = handle;
        return handle;
      },
      async runMessage(content, options) {
        return await this.submitMessage(content, options).result;
      },
      getHistory: () => [...history],
      loadHistory: (messages) => {
        history = [...messages];
      },
      clear: () => {
        history = [];
      },
      setModel: () => {},
      setCompactContextProvider: () => {},
      compact: async (): Promise<AgentCompactResult> => {
        if (state !== "idle") throw new Error(`Agent is ${state}`);
        state = "maintaining";
        try {
          const beforeMessageCount = history.length;
          const result = await program.compact?.();
          if (result) history = testTranscriptToMessages(result.transcript);
          return {
            history: [...history],
            beforeMessageCount,
            afterMessageCount: result?.messageCount ?? history.length,
          };
        } finally {
          if (state === "maintaining") state = "idle";
        }
      },
      remember: async () => {
        if (state !== "idle") throw new Error(`Agent is ${state}`);
        state = "maintaining";
        try {
          return (
            (await program.remember?.()) ?? {
              skipped: true,
              writtenIds: [],
              titles: [],
            }
          );
        } finally {
          if (state === "maintaining") state = "idle";
        }
      },
      getUsage: () =>
        program.getUsage?.() ?? { inputTokens: 0, outputTokens: 0 },
      getCapabilities: () =>
        program.inspect?.().capabilities ?? disabledCapabilities(),
      inspect: () =>
        program.inspect?.() ?? {
          model: context.session.model,
          tools: [],
          hooks: [],
          mcpServers: [],
          childBudget: {
            maxDepth: 4,
            maxActiveChildren: 4,
            maxTotalChildren: 16,
            activeChildren: 0,
            totalChildren: 0,
          },
          capabilities: disabledCapabilities(),
        },
      close: () => {
        if (closePromise) return closePromise;
        state = "closing";
        closePromise = (async () => {
          await activeHandle?.interrupt("Agent closed");
          await program.close();
          state = "closed";
        })();
        return closePromise;
      },
    };
  };
}

function disabledCapabilities(): AgentCapabilitySnapshot {
  return {
    terminal: { status: "disabled" },
    backgroundShell: { status: "disabled" },
    jobs: { status: "disabled" },
    memory: { status: "disabled" },
    childEnvironment: { status: "disabled" },
    workflowRepository: { status: "disabled" },
    schedules: { status: "disabled" },
  };
}

function testTranscriptToMessages(
  transcript: Array<{ role: string; parts: Array<Record<string, any>> }>,
): Message[] {
  return transcript.flatMap((row): Message[] => {
    const text = row.parts
      .filter((part) => part.type === "text")
      .map((part) => String(part.text ?? ""))
      .join("");
    if (row.role === "user") return [{ type: "user", content: text }];
    if (row.role === "system") return [{ type: "system", content: text }];
    return [{ type: "assistant", content: text }];
  });
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function withServer(
  test: (ctx: {
    baseUrl: string;
    token: string;
    storePath: string;
    server: VykorHttpServer;
  }) => Promise<void>,
  options: TestServerOptions = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "vk-server-"));
  const token = "test-token";
  const server = new VykorHttpServer({
    token,
    allowedOrigins: options.allowedOrigins,
    storePath: join(dir, "sessions.db"),
    createAgent:
      options.createAgent ??
      (options.runtimeFactory
        ? adaptTestAgentFactory(options.runtimeFactory)
        : undefined),
    services: {
      commandCatalog: options.commandCatalog,
      settings: options.settingsService,
      provider: options.providerService,
      memory: options.memoryService,
      auth: options.authService,
      context: options.contextService,
      dream: options.dreamService,
      profile: options.profileService,
      outputStyle: options.outputStyleService,
      projectInit: options.projectInitService,
      plugin: options.pluginService,
      agentPersona: options.agentPersonaService,
      hooks: options.hooksService,
      git: options.gitService,
    },
    logger: options.logger ?? (() => {}),
  });
  const listen = await server.listen();
  try {
    await test({
      baseUrl: listen.url,
      token,
      storePath: join(dir, "sessions.db"),
      server,
    });
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

interface TestServerOptions extends Pick<
  VykorServerOptions,
  "allowedOrigins" | "logger"
> {
  runtimeFactory?: TestAgentProgramFactory;
  createAgent?: CreateDaemonAgent;
  commandCatalog?: VykorServerServices["commandCatalog"];
  settingsService?: VykorServerServices["settings"];
  providerService?: VykorServerServices["provider"];
  memoryService?: VykorServerServices["memory"];
  authService?: VykorServerServices["auth"];
  contextService?: VykorServerServices["context"];
  dreamService?: VykorServerServices["dream"];
  profileService?: VykorServerServices["profile"];
  outputStyleService?: VykorServerServices["outputStyle"];
  projectInitService?: VykorServerServices["projectInit"];
  pluginService?: VykorServerServices["plugin"];
  agentPersonaService?: VykorServerServices["agentPersona"];
  hooksService?: VykorServerServices["hooks"];
  gitService?: VykorServerServices["git"];
}

function auth(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForEvent(
  baseUrl: string,
  token: string,
  predicate: (event: {
    type: string;
    payload?: Record<string, unknown>;
  }) => boolean,
): Promise<Array<{ type: string; payload?: Record<string, unknown> }>> {
  let lastEvents: Array<{ type: string; payload?: Record<string, unknown> }> =
    [];
  for (let i = 0; i < 50; i++) {
    const body = (await (
      await fetch(`${baseUrl}/events`, { headers: auth(token) })
    ).json()) as {
      events: Array<{ type: string; payload?: Record<string, unknown> }>;
    };
    lastEvents = body.events;
    if (body.events.some(predicate)) return body.events;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Timed out waiting for event; observed: ${lastEvents.map((event) => event.type).join(", ")}; tail: ${JSON.stringify(lastEvents.slice(-5))}`,
  );
}

describe("VykorHttpServer", () => {
  it("can use an injected application without creating or closing its resources", async () => {
    const ready = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const runtimeSnapshot = vi.fn(() => ({
      startedAt: 1,
      uptimeMs: 2,
      sessions: { total: 0, byStatus: {} },
      runs: { total: 0, byStatus: {} },
      tasks: { total: 0, byStatus: {} },
      permissions: { total: 0, byStatus: {} },
      projectionSettlements: { total: 0, pending: 0, byStatus: {} },
      sseClientCount: 0,
      warmAgentCount: 0,
      coordinator: { activeRunCount: 0, queuedRunCount: 0 },
      metrics: { counters: {}, gauges: {}, histograms: {} },
    }));
    const application = {
      ready,
      close,
      store: {},
      events: {},
      terminals: {},
      jobs: {},
      projects: {},
      sessions: {},
      queries: {},
      permissions: {},
      backgroundShells: {},
      attachments: {
        limits: DEFAULT_ATTACHMENT_LIMITS,
        import: vi.fn(),
        get: vi.fn(),
        openContent: vi.fn(),
        delete: vi.fn(),
      },
      maintenance: {},
      schedules: {},
      control: { runtimeSnapshot },
    } as any;
    const server = new VykorHttpServer({ application, logger: () => {} });

    const response = await server.app.request("/health");
    expect(response.status).toBe(200);
    expect(runtimeSnapshot).toHaveBeenCalledOnce();
    await server.close();
    expect(close).not.toHaveBeenCalled();
  });

  it("serves protocol capabilities without bearer authentication", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-capabilities-"));
    const server = new VykorHttpServer({
      storePath: join(dir, "sessions.db"),
      token: "secret",
      version: "0.4.0",
      logger: () => {},
    });
    const response = await server.app.request("/capabilities");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      serverVersion: "0.4.0",
      protocol: { version: 4 },
      features: { jobs: 2, workflow: 2, pluginCapabilities: 1 },
    });
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("guards MCP runtime control routes with bearer auth and returns unavailable without runtimes", async () => {
    await withServer(async ({ baseUrl, token }) => {
      const fingerprint = "A".repeat(43);
      const unauthorized = await fetch(`${baseUrl}/mcp/linear/runtime-status?fingerprint=${fingerprint}`);
      expect(unauthorized.status).toBe(401);

      const status = await fetch(`${baseUrl}/mcp/linear/runtime-status?fingerprint=${fingerprint}`, {
        headers: auth(token),
      });
      expect(status.status).toBe(200);
      await expect(status.json()).resolves.toEqual({ status: "unavailable", affectedRuntimes: 0, failures: [] });

      const sync = await fetch(`${baseUrl}/mcp/linear/synchronize`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ fingerprint }),
      });
      expect(sync.status).toBe(200);
      await expect(sync.json()).resolves.toEqual({ status: "unavailable", affectedRuntimes: 0, failures: [] });

      const unauthorizedReconcile = await fetch(`${baseUrl}/mcp/linear/reconcile-global`, { method: "POST" });
      expect(unauthorizedReconcile.status).toBe(401);

      const reconcile = await fetch(`${baseUrl}/mcp/linear/reconcile-global`, {
        method: "POST",
        headers: auth(token),
      });
      expect(reconcile.status).toBe(200);
      await expect(reconcile.json()).resolves.toEqual({ status: "unavailable", affectedRuntimes: 0, failures: [] });
    });
  });

  it("serves durable authenticated attachments and recovers interrupted imports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-attachments-e2e-"));
    const storePath = join(dir, "sessions.db");
    const token = "attachment-secret";
    const attachmentLimits = {
      ...DEFAULT_ATTACHMENT_LIMITS,
      maxBytesPerFile: 1_024,
      resumableThresholdBytes: 512,
    };
    const interruptedStore = new SessionStore({ path: storePath });
    interruptedStore.attachments.createImportingAttachment({
      id: "att_interrupted",
      displayName: "interrupted.bin",
      stagingName: "att_interrupted.part",
      createdAt: 1,
    });
    interruptedStore.close();

    let first: VykorHttpServer | undefined;
    let second: VykorHttpServer | undefined;
    try {
      first = new VykorHttpServer({
        storePath,
        token,
        attachmentLimits,
        logger: () => {},
      });
      const firstListen = await first.listen();

      const capabilities = await fetch(`${firstListen.url}/capabilities`);
      expect(capabilities.status).toBe(200);
      await expect(capabilities.json()).resolves.toMatchObject({
        features: { attachments: 1 },
        attachments: {
          limits: attachmentLimits,
          uploadModes: ["single"],
        },
      });
      expect(first.store.attachments.getAttachment("att_interrupted")).toMatchObject({
        status: "failed",
        failureCode: "attachment_storage_failed",
      });

      const pdf = new TextEncoder().encode("%PDF-1.7\nsame bytes");
      const unauthorizedUpload = await fetch(`${firstListen.url}/attachments`, {
        method: "POST",
        headers: { "x-vykor-filename": "report.pdf" },
        body: pdf,
      });
      expect(unauthorizedUpload.status).toBe(401);

      const upload = async (displayName: string) => {
        const response = await fetch(`${firstListen.url}/attachments`, {
          method: "POST",
          headers: {
            ...auth(token),
            "content-type": "image/png",
            "x-vykor-filename": encodeURIComponent(displayName),
          },
          body: pdf,
        });
        expect(response.status).toBe(201);
        return (await response.json()) as {
          id: string;
          displayName: string;
          mediaType: string;
          sizeBytes: number;
          sha256: string;
          status: string;
        };
      };
      const uploaded = await upload("C:\\private\\报告.pdf");
      const duplicate = await upload("副本.pdf");
      expect(uploaded).toMatchObject({
        displayName: "报告.pdf",
        mediaType: "application/pdf",
        sizeBytes: pdf.byteLength,
        status: "ready",
      });
      expect(duplicate.sha256).toBe(uploaded.sha256);
      expect(JSON.stringify(uploaded)).not.toContain("C:\\private");
      expect(JSON.stringify(uploaded)).not.toMatch(/staging|storage|blob/i);
      expect(
        existsSync(
          join(
            dir,
            "attachments",
            "blobs",
            uploaded.sha256.slice(0, 2),
            uploaded.sha256,
          ),
        ),
      ).toBe(true);

      const unauthorizedRead = await fetch(
        `${firstListen.url}/attachments/${uploaded.id}`,
      );
      expect(unauthorizedRead.status).toBe(401);

      const ranged = await fetch(
        `${firstListen.url}/attachments/${uploaded.id}/content`,
        { headers: { ...auth(token), range: "bytes=1-3" } },
      );
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get("content-range")).toBe(
        `bytes 1-3/${pdf.byteLength}`,
      );
      expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(
        pdf.subarray(1, 4),
      );

      const deleted = await fetch(
        `${firstListen.url}/attachments/${uploaded.id}`,
        { method: "DELETE", headers: auth(token) },
      );
      expect(deleted.status).toBe(200);
      const deletedMetadata = await fetch(
        `${firstListen.url}/attachments/${uploaded.id}`,
        { headers: auth(token) },
      );
      expect(deletedMetadata.status).toBe(404);
      const deletedContent = await fetch(
        `${firstListen.url}/attachments/${uploaded.id}/content`,
        { headers: auth(token) },
      );
      expect(deletedContent.status).toBe(404);
      expect(
        existsSync(
          join(
            dir,
            "attachments",
            "blobs",
            uploaded.sha256.slice(0, 2),
            uploaded.sha256,
          ),
        ),
      ).toBe(true);

      await first.close();
      first = undefined;
      second = new VykorHttpServer({
        storePath,
        token,
        attachmentLimits,
        logger: () => {},
      });
      const secondListen = await second.listen();
      const restored = await fetch(
        `${secondListen.url}/attachments/${duplicate.id}`,
        { headers: auth(token) },
      );
      expect(restored.status).toBe(200);
      await expect(restored.json()).resolves.toMatchObject({
        id: duplicate.id,
        sha256: uploaded.sha256,
        status: "ready",
      });
    } finally {
      await first?.close();
      await second?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps prompt attachment references through restart, replay, fork, and branch deletion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-attachment-lifecycle-"));
    const storePath = join(dir, "sessions.db");
    const token = "attachment-lifecycle-secret";
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt() {
            return { messages: [] };
          },
          async close() {},
        };
      },
    };
    let first: VykorHttpServer | undefined;
    let second: VykorHttpServer | undefined;
    try {
      first = new VykorHttpServer({
        storePath,
        token,
        createAgent: adaptTestAgentFactory(runtimeFactory),
        logger: () => {},
      });
      const firstListen = await first.listen();
      const upload = async (name: string, body: string) => {
        const response = await fetch(`${firstListen.url}/attachments`, {
          method: "POST",
          headers: {
            ...auth(token),
            "content-type": "application/pdf",
            "x-vykor-filename": encodeURIComponent(name),
          },
          body,
        });
        expect(response.status).toBe(201);
        return (await response.json()) as { id: string };
      };
      const firstAsset = await upload("first.pdf", "%PDF-1.7\nfirst");
      const secondAsset = await upload("second.pdf", "%PDF-1.7\nsecond");

      const created = await fetch(`${firstListen.url}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "attachment-session", cwd: process.cwd(), model: "m" }),
      });
      expect(created.status).toBe(201);
      const admitted = await fetch(`${firstListen.url}/sessions/attachment-session/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({
          id: "attachment-input",
          content: "",
          attachments: [
            { assetId: secondAsset.id, intent: "auto" },
            { assetId: firstAsset.id, intent: "ocr", displayName: "scan.pdf" },
          ],
        }),
      });
      expect(admitted.status).toBe(202);
      await expect(admitted.json()).resolves.toMatchObject({
        input: {
          id: "attachment-input",
          attachments: [
            { assetId: secondAsset.id, seq: 0, intent: "auto" },
            { assetId: firstAsset.id, seq: 1, intent: "ocr", displayName: "scan.pdf" },
          ],
        },
      });
      const beforeRestart = (await (
        await fetch(`${firstListen.url}/sessions/attachment-session/state`, { headers: auth(token) })
      ).json()) as { inputs: Array<{ id: string; attachments: Array<{ assetId: string }> }> };
      expect(beforeRestart.inputs[0]?.attachments.map((row) => row.assetId)).toEqual([
        secondAsset.id,
        firstAsset.id,
      ]);

      await fetch(`${firstListen.url}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "concurrent-admission", cwd: process.cwd(), model: "m" }),
      });
      const duplicateRequest = () => fetch(`${firstListen.url}/sessions/concurrent-admission/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({
          id: "same-attachment-input",
          content: "inspect",
          attachments: [{ assetId: secondAsset.id, intent: "auto" }],
        }),
      });
      const duplicateResponses = await Promise.all([duplicateRequest(), duplicateRequest()]);
      expect(duplicateResponses.map((response) => response.status)).toEqual([202, 202]);
      expect(first.store.conversations.listInputs("concurrent-admission")).toHaveLength(1);
      expect(first.store.conversations.listInputAttachments("same-attachment-input")).toHaveLength(1);
      expect(first.store.runs.listRuns("concurrent-admission")).toHaveLength(1);

      const recoverySession = await fetch(`${firstListen.url}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "publish-recovery", cwd: process.cwd(), model: "m" }),
      });
      expect(recoverySession.status).toBe(201);
      const publisher = (first.application as any).eventPublisher;
      const originalPublishSince = publisher.publishSince.bind(publisher);
      publisher.publishSince = () => {
        throw new Error("publish failed after commit");
      };
      const publishFailed = await fetch(`${firstListen.url}/sessions/publish-recovery/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({
          id: "committed-before-publish",
          content: "",
          attachments: [{ assetId: firstAsset.id, intent: "auto" }],
        }),
      });
      expect(publishFailed.status).toBe(404);
      publisher.publishSince = originalPublishSince;

      await first.close();
      first = undefined;
      second = new VykorHttpServer({
        storePath,
        token,
        createAgent: adaptTestAgentFactory(runtimeFactory),
        logger: () => {},
      });
      const secondListen = await second.listen();
      const afterRestart = (await (
        await fetch(`${secondListen.url}/sessions/attachment-session/state`, { headers: auth(token) })
      ).json()) as {
        inputs: Array<{ id: string; attachments: Array<{ assetId: string }> }>;
        parts: Array<{ type: string; assetId?: string }>;
      };
      expect(afterRestart.inputs[0]?.attachments.map((row) => row.assetId)).toEqual([
        secondAsset.id,
        firstAsset.id,
      ]);
      expect(afterRestart.parts.filter((part) => part.type === "attachment").map((part) => part.assetId)).toEqual([
        secondAsset.id,
        firstAsset.id,
      ]);
      const replay = (await (
        await fetch(`${secondListen.url}/events?sessionId=attachment-session`, { headers: auth(token) })
      ).json()) as { events: Array<{ type: string; payload: Record<string, any> }> };
      expect(replay.events.find((event) => event.type === "session.input.admitted")?.payload.input.attachments)
        .toHaveLength(2);
      const abortReplay = new AbortController();
      const sseReplay = await fetch(
        `${secondListen.url}/events/stream?sessionId=attachment-session`,
        { headers: auth(token), signal: abortReplay.signal },
      );
      const replayReader = sseReplay.body!.getReader();
      const replayDecoder = new TextDecoder();
      let replayText = "";
      for (let index = 0; index < 20 && !replayText.includes("attachment-input"); index++) {
        const chunk = await replayReader.read();
        if (chunk.done) break;
        replayText += replayDecoder.decode(chunk.value, { stream: true });
      }
      await replayReader.cancel();
      abortReplay.abort();
      expect(replayText).toContain("session.input.admitted");
      expect(replayText).toContain(secondAsset.id);
      expect(replayText).toContain(firstAsset.id);
      const recoveredAfterPublishFailure = (await (
        await fetch(`${secondListen.url}/sessions/publish-recovery/state`, { headers: auth(token) })
      ).json()) as {
        inputs: Array<{ id: string; attachments: Array<{ assetId: string }> }>;
        runs: Array<{ inputId?: string }>;
      };
      expect(recoveredAfterPublishFailure.inputs).toEqual([
        expect.objectContaining({
          id: "committed-before-publish",
          attachments: [expect.objectContaining({ assetId: firstAsset.id })],
        }),
      ]);
      expect(recoveredAfterPublishFailure.runs).toEqual([
        expect.objectContaining({ inputId: "committed-before-publish" }),
      ]);

      const forkedResponse = await fetch(`${secondListen.url}/sessions/attachment-session/fork`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(forkedResponse.status).toBe(201);
      const forked = (await forkedResponse.json()) as { session: { id: string } };
      const removedFork = await fetch(`${secondListen.url}/sessions/${forked.session.id}/hard`, {
        method: "DELETE",
        headers: auth(token),
      });
      expect(removedFork.status).toBe(200);
      const stillReadable = await fetch(`${secondListen.url}/attachments/${firstAsset.id}/content`, {
        headers: auth(token),
      });
      expect(stillReadable.status).toBe(200);
      const stillProtected = await fetch(`${secondListen.url}/attachments/${firstAsset.id}`, {
        method: "DELETE",
        headers: auth(token),
      });
      expect(stillProtected.status).toBe(409);

      const removedParent = await fetch(`${secondListen.url}/sessions/attachment-session/hard`, {
        method: "DELETE",
        headers: auth(token),
      });
      expect(removedParent.status).toBe(200);
      const removedRecovery = await fetch(`${secondListen.url}/sessions/publish-recovery/hard`, {
        method: "DELETE",
        headers: auth(token),
      });
      expect(removedRecovery.status).toBe(200);
      const removedConcurrent = await fetch(`${secondListen.url}/sessions/concurrent-admission/hard`, {
        method: "DELETE",
        headers: auth(token),
      });
      expect(removedConcurrent.status).toBe(200);
      for (const asset of [firstAsset, secondAsset]) {
        const deleted = await fetch(`${secondListen.url}/attachments/${asset.id}`, {
          method: "DELETE",
          headers: auth(token),
        });
        expect(deleted.status).toBe(200);
      }
    } finally {
      await first?.close();
      await second?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes real text uploads and blocks document or disguised binary bytes before the agent runs", async () => {
    const received: Array<{ sessionId: string; content: unknown }> = [];
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt(input) {
            received.push({
              sessionId: input.session.id,
              content: input.input.content,
            });
            return { messages: [] };
          },
          async close() {},
        };
      },
    };

    await withServer(
      async ({ baseUrl, token, server }) => {
        const upload = async (
          displayName: string,
          mediaType: string,
          body: BodyInit,
        ): Promise<string> => {
          const response = await fetch(`${baseUrl}/attachments`, {
            method: "POST",
            headers: {
              ...auth(token),
              "content-type": mediaType,
              "x-vykor-filename": encodeURIComponent(displayName),
            },
            body,
          });
          expect(response.status).toBe(201);
          return ((await response.json()) as { id: string }).id;
        };
        const submit = async (
          suffix: string,
          assetId: string,
        ): Promise<ReturnType<SessionStore["runs"]["getRun"]>> => {
          const sessionId = `text-routing-${suffix}`;
          const inputId = `input-${suffix}`;
          const created = await fetch(`${baseUrl}/sessions`, {
            method: "POST",
            headers: { ...auth(token), "content-type": "application/json" },
            body: JSON.stringify({ id: sessionId, cwd: process.cwd(), model: "m" }),
          });
          expect(created.status).toBe(201);
          const admitted = await fetch(`${baseUrl}/sessions/${sessionId}/prompts`, {
            method: "POST",
            headers: { ...auth(token), "content-type": "application/json" },
            body: JSON.stringify({
              id: inputId,
              content: "inspect",
              attachments: [{ assetId, intent: "auto" }],
            }),
          });
          expect(admitted.status).toBe(202);
          const runId = ((await admitted.json()) as { run: { id: string } }).run.id;
          await waitUntil(() => {
            const status = server.store.runs.getRun(runId)?.status;
            return status === "completed" || status === "failed" || status === "interrupted";
          }, 30_000);
          return server.store.runs.getRun(runId);
        };

        const utf8 = await upload("notes.txt", "text/plain", "第一行\r\n第二行");
        const utf8Bom = await upload(
          "bom.md",
          "text/markdown",
          new Blob([new Uint8Array([0xef, 0xbb, 0xbf]), "# 标题"]),
        );
        const utf16le = await upload(
          "windows.log",
          "text/plain",
          new Blob([new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x0a, 0x00, 0x42, 0x00])]),
        );
        const large = await upload(
          "large.log",
          "text/plain",
          new Blob([new Uint8Array(5 * 1024 * 1024).fill(0x61)]),
        );
        const pdf = await upload("manual.pdf", "application/pdf", "%PDF-1.7\ncontent");
        const docx = await upload(
          "report.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])]),
        );
        const disguisedBinary = await upload(
          "fake.txt",
          "text/plain",
          new Blob([new Uint8Array([0x00, 0x01, 0x02, 0x03])]),
        );

        const inlineRuns = await Promise.all([
          submit("utf8", utf8),
          submit("bom", utf8Bom),
          submit("utf16", utf16le),
          submit("large", large),
        ]);
        expect(inlineRuns.every((run) => run?.status === "completed")).toBe(true);
        const blockedRuns = await Promise.all([
          submit("pdf", pdf),
          submit("docx", docx),
          submit("binary", disguisedBinary),
        ]);
        expect(blockedRuns.map((run) => run?.status)).toEqual([
          "failed",
          "failed",
          "failed",
        ]);
        expect(blockedRuns.map((run) => (run?.metadata.attachmentRouting as any)?.code)).toEqual([
          "attachment_document_unsupported",
          "attachment_document_unsupported",
          "attachment_text_encoding_unsupported",
        ]);

        expect(received).toHaveLength(4);
        const contentFor = (sessionId: string) =>
          JSON.stringify(received.find((item) => item.sessionId === sessionId)?.content);
        expect(contentFor("text-routing-utf8")).toContain("第一行\\n第二行");
        expect(contentFor("text-routing-bom")).toContain("# 标题");
        expect(contentFor("text-routing-utf16")).toContain("A\\nB");
        const largeContent = contentFor("text-routing-large");
        expect(largeContent).toContain(`attachment://${large}/large.log`);
        expect(largeContent.length).toBeLessThan(10_000);
      },
      { runtimeFactory },
    );
  }, 45_000);

  it("aggregates application, listener, and SSE close failures after attempting every stage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-server-close-matrix-"));
    const server = new VykorHttpServer({
      storePath: join(dir, "sessions.db"),
    });
    await server.application.ready();
    const daemonError = new Error("daemon shutdown failed");
    const listenerError = new Error("listener close failed");
    const sseError = new Error("SSE close failed");
    const originalStoreClose = server.store.close.bind(server.store);
    const applicationClose = vi.fn(async () => {
      throw daemonError;
    });
    const closeClients = vi.fn(() => {
      throw sseError;
    });
    const listenerClose = vi.fn((callback: (error?: Error) => void) =>
      callback(listenerError),
    );
    (server.application as any).close = applicationClose;
    (server as any).eventHub.closeClients = closeClients;
    (server as any).listener = { close: listenerClose };

    try {
      const firstFailure = await server.close().catch((error) => error);
      expect(firstFailure).toBeInstanceOf(AggregateError);
      expect((firstFailure as AggregateError).errors).toEqual([
        sseError,
        daemonError,
        listenerError,
      ]);
      const secondFailure = await server.close().catch((error) => error);
      expect(secondFailure).toBe(firstFailure);
      expect(applicationClose).toHaveBeenCalledOnce();
      expect(closeClients).toHaveBeenCalledOnce();
      expect(listenerClose).toHaveBeenCalledOnce();
    } finally {
      originalStoreClose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes the durable store even when daemon shutdown fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-close-"));
    const server = new VykorHttpServer({
      storePath: join(dir, "sessions.db"),
      logger: () => {},
    });
    const failure = new Error("shutdown failed");
    const closeStore = vi.spyOn(server.store, "close");
    (server.application as any).close = vi.fn(async () => {
      server.store.close();
      throw failure;
    });

    try {
      await expect(server.close()).rejects.toBe(failure);
      expect(closeStore).toHaveBeenCalledOnce();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits for background process trees to exit before shutdown completes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-process-shutdown-"));
    const pidFile = join(dir, "child.pid");
    const server = new VykorHttpServer({
      storePath: join(dir, "sessions.db"),
      logger: () => {},
    });
    const supervisor = getDetachedProcessSupervisor({
      cwd: dir,
      sessionId: "shutdown-session",
    });

    try {
      await supervisor.startShellExecution({
        argv: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1_000)`,
        ],
        cwd: dir,
        description: "long-running shutdown probe",
        sessionId: "shutdown-session",
      });
      await waitUntil(() => existsSync(pidFile));
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(isProcessAlive(pid)).toBe(true);

      await server.close();

      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      await server.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes a provided durable store when the HTTP listener cannot start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-listen-failure-"));
    const blocker = new VykorHttpServer({
      storePath: join(dir, "blocker.db"),
      logger: () => {},
    });
    const occupied = await blocker.listen();
    const store = new SessionStore({ path: join(dir, "failed.db") });
    const closeStore = vi.spyOn(store, "close");

    try {
      await expect(
        startVykorServer({
          host: occupied.host,
          port: occupied.port,
          store,
          logger: () => {},
        }),
      ).rejects.toBeDefined();
      expect(closeStore).toHaveBeenCalledOnce();
    } finally {
      await blocker.close();
      if (!closeStore.mock.calls.length) store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("projects framework-owned child execution into durable child sessions", async () => {
    const closed: string[] = [];
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime({ session }) {
        let runContext: TestAgentRunContext | undefined;
        let runCount = 0;
        const childContext = () => ({
          agentId: "child-invocation",
          sessionId: "child-session",
          childId: "child-invocation",
          parentSessionId: session.id,
          parentRunId: "parent-run",
        });
        const send = async (input: AgentChildInput) => {
          const suffix = ++runCount;
          const inputId = input.id ?? `child-input-${suffix}`;
          const runId = `child-run-${suffix}`;
          await runContext!.emit(
            {
              type: "input.accepted",
              data: {
                content: input.content,
                delivery: input.delivery ?? "queue",
              },
            },
            {
              ...childContext(),
              inputId,
              runId,
              traceId: `child-trace-${suffix}`,
            },
          );
          await runContext!.emit(
            { type: "run.started", data: {} },
            {
              ...childContext(),
              inputId,
              runId,
              traceId: `child-trace-${suffix}`,
            },
          );
          await runContext!.emit(
            { type: "output.text.delta", data: { delta: "child output" } },
            {
              ...childContext(),
              inputId,
              runId,
              traceId: `child-trace-${suffix}`,
            },
          );
          await runContext!.emit(
            { type: "run.completed", data: { output: "child output" } },
            {
              ...childContext(),
              inputId,
              runId,
              traceId: `child-trace-${suffix}`,
            },
          );
          return { sessionId: "child-session", inputId, runId };
        };
        const child: AgentChildHandle = {
          id: "child-invocation",
          sessionId: "child-session",
          state: "idle",
          result: Promise.resolve({
            status: "completed",
            output: "child output",
          }),
          send,
          interrupt: async () => {},
          close: async () => {},
        };
        return {
          children: {
            get: (id) => (id === child.id ? child : undefined),
            getBySessionId: (id) =>
              id === child.sessionId ? child : undefined,
            list: () => [child],
          },
          async runPrompt(_input, run) {
            runContext = run;
            await run.emit({
              type: "child.created",
              data: {
                childId: child.id,
                sessionId: child.sessionId,
                spawn: {
                  description: "Explore@default",
                  prompt: "inspect",
                  agent: "Explore",
                  cwd: session.cwd,
                },
                cwd: session.cwd,
              },
            });
            await child.send({ content: "inspect" });
            await run.emit({
              type: "output.text.delta",
              data: { delta: "child output" },
            });
          },
          async close() {
            closed.push(session.id);
          },
        };
      },
    };

    await withServer(
      async ({ baseUrl, token, server }) => {
        const response = await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            id: "parent",
            cwd: process.cwd(),
            model: "m",
          }),
        });
        expect(response.status).toBe(201);
        const prompt = await fetch(`${baseUrl}/sessions/parent/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "start child" }),
        });
        expect(prompt.status).toBe(202);
        await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (
              event.payload?.run as
                { sessionId?: string; status?: string } | undefined
            )?.sessionId === "parent" &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "completed",
        );
        const child = server.store
          .sessions.list({ includeArchived: true })
          .find((session) => session.parentId === "parent");
        expect(child).toMatchObject({ model: "m", parentId: "parent" });
        const task = server.store.listSessionTasks("parent")[0];
        expect(task).toMatchObject({
          childSessionId: child!.id,
          runId: expect.any(String),
          status: "completed",
        });
        const closeRuntime = await fetch(`${baseUrl}/sessions/${child!.id}`, {
          method: "PATCH",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            metadata: { runtime: { permissionMode: "plan" } },
          }),
        });
        expect(closeRuntime.status).toBe(409);
        expect(closed).not.toContain(child!.id);

        const followUp = await fetch(
          `${baseUrl}/sessions/${child!.id}/prompts`,
          {
            method: "POST",
            headers: { ...auth(token), "content-type": "application/json" },
            body: JSON.stringify({ content: "follow up" }),
          },
        );
        expect(followUp.status).toBe(202);
        await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (
              event.payload?.run as
                { sessionId?: string; status?: string } | undefined
            )?.sessionId === child!.id &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "completed",
        );
        expect(server.store.sessions.get(child!.id)?.status).not.toBe("archived");
      },
      { runtimeFactory },
    );
  });

  it("uses the canonical session runtime store", () => {
    expect(getDefaultSessionStorePath()).toMatch(
      /[\\/]session-runtime[\\/]sessions\.db$/,
    );
  });

  it("serves health without bearer auth and protects other routes", async () => {
    await withServer(async ({ baseUrl, token }) => {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        startedAt: expect.any(Number),
        uptimeMs: expect.any(Number),
        sessionCount: 0,
        activeRunCount: 0,
        queuedRunCount: 0,
      });

      expect((await fetch(`${baseUrl}/debug/runtime`)).status).toBe(401);
      const runtime = await fetch(`${baseUrl}/debug/runtime`, {
        headers: auth(token),
      });
      expect(runtime.status).toBe(200);
      expect(await runtime.json()).toMatchObject({
        startedAt: expect.any(Number),
        uptimeMs: expect.any(Number),
        sessions: { total: 0, byStatus: {} },
        runs: { total: 0, byStatus: {} },
        tasks: { total: 0, byStatus: {} },
        permissions: { total: 0, byStatus: {} },
        projectionSettlements: { total: 0, pending: 0, byStatus: {} },
        sseClientCount: 0,
        warmAgentCount: 0,
        coordinator: { activeRunCount: 0, queuedRunCount: 0 },
      });
    });
  });

  it("reports aggregate running and queued work without transcript content", async () => {
    const releaseFirst = deferred();
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt(input) {
            if (input.input.content === "private first prompt")
              await releaseFirst.promise;
            return { messages: [] };
          },
          async close() {},
        };
      },
    };

    await withServer(
      async ({ baseUrl, token }) => {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
        });
        await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "private first prompt" }),
        });
        await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "running",
        );
        await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "private queued prompt" }),
        });

        const response = await fetch(`${baseUrl}/debug/runtime`, {
          headers: auth(token),
        });
        expect(response.status).toBe(200);
        const snapshot = (await response.json()) as {
          sessions: { total: number; byStatus: Record<string, number> };
          runs: { total: number; byStatus: Record<string, number> };
          sseClientCount: number;
          warmAgentCount: number;
          coordinator: { activeRunCount: number; queuedRunCount: number };
        };
        expect(snapshot).toMatchObject({
          sessions: { total: 1, byStatus: { running: 1 } },
          runs: { total: 2, byStatus: { running: 1, pending: 1 } },
          sseClientCount: 0,
          warmAgentCount: 1,
          coordinator: { activeRunCount: 1, queuedRunCount: 1 },
        });
        expect(JSON.stringify(snapshot)).not.toContain("private");

        releaseFirst.resolve();
        await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "completed",
        );
      },
      { runtimeFactory },
    );
  });

  it("propagates a trace ID through HTTP, persisted prompt/run, and tool lifecycle logs", async () => {
    const events: ObservabilityEvent[] = [];
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt(_input, run) {
            await run.emit({
              type: "tool.started",
              data: {
                toolUse: {
                  type: "tool_use",
                  id: "tool-1",
                  name: "Read",
                  input: { path: "README.md" },
                },
              },
            });
            await run.emit({
              type: "tool.completed",
              data: {
                toolUseId: "tool-1",
                result: { content: [{ type: "text", text: "ok" }] },
              },
            });
            return { messages: [] };
          },
          async close() {},
        };
      },
    };

    await withServer(
      async ({ baseUrl, token, server }) => {
        const traceId = "trace-e2e-001";
        const created = await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ cwd: process.cwd(), model: "m" }),
        });
        const session = ((await created.json()) as { session: { id: string } })
          .session;
        const response = await fetch(
          `${baseUrl}/sessions/${session.id}/prompts`,
          {
            method: "POST",
            headers: {
              ...auth(token),
              "content-type": "application/json",
              "x-vykor-trace-id": traceId,
            },
            body: JSON.stringify({ id: "prompt-trace-1", content: "inspect" }),
          },
        );
        expect(response.status).toBe(202);
        expect(response.headers.get("x-vykor-trace-id")).toBe(traceId);
        const admitted = (await response.json()) as {
          input: { metadata: Record<string, unknown> };
          run: { id: string; metadata: Record<string, unknown> };
        };
        expect(admitted.input.metadata.traceId).toBe(traceId);
        expect(admitted.run.metadata.traceId).toBe(traceId);

        for (
          let i = 0;
          i < 20 &&
          server.store.runs.getRun(admitted.run.id)?.status !== "completed";
          i += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(server.store.runs.getRun(admitted.run.id)?.status).toBe("completed");
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: "http.request.completed",
              traceId,
              path: `/sessions/${session.id}/prompts`,
            }),
            expect.objectContaining({
              event: "session.run.started",
              traceId,
              sessionId: session.id,
              runId: admitted.run.id,
            }),
            expect.objectContaining({
              event: "session.tool.started",
              traceId,
              toolName: "Read",
            }),
            expect.objectContaining({
              event: "session.tool.completed",
              traceId,
              toolName: "Read",
            }),
            expect.objectContaining({
              event: "session.run.completed",
              traceId,
              sessionId: session.id,
              runId: admitted.run.id,
            }),
          ]),
        );
      },
      { runtimeFactory, logger: (event) => events.push(event) },
    );
  });

  it("permits only configured browser origins and handles unauthenticated preflight", async () => {
    await withServer(
      async ({ baseUrl }) => {
        const preflight = await fetch(`${baseUrl}/sessions`, {
          method: "OPTIONS",
          headers: {
            origin: "https://desk.example",
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization",
          },
        });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-origin")).toBe(
          "https://desk.example",
        );
        expect(preflight.headers.get("access-control-allow-headers")).toContain(
          "authorization",
        );
        expect(preflight.headers.get("access-control-allow-headers")).toContain(
          "x-vykor-trace-id",
        );
        expect(preflight.headers.get("access-control-allow-headers")).toContain(
          "x-vykor-filename",
        );
        expect(preflight.headers.get("access-control-allow-headers")).toContain(
          "range",
        );

        const allowed = await fetch(`${baseUrl}/health`, {
          headers: { origin: "https://desk.example" },
        });
        expect(allowed.status).toBe(200);
        expect(allowed.headers.get("access-control-allow-origin")).toBe(
          "https://desk.example",
        );
        expect(allowed.headers.get("access-control-expose-headers")).toContain(
          "x-vykor-trace-id",
        );
        expect(allowed.headers.get("access-control-expose-headers")).toContain(
          "content-range",
        );
        expect(allowed.headers.get("access-control-expose-headers")).toContain(
          "content-disposition",
        );
        expect(allowed.headers.get("access-control-expose-headers")).toContain(
          "etag",
        );

        const denied = await fetch(`${baseUrl}/health`, {
          headers: { origin: "https://untrusted.example" },
        });
        expect(denied.status).toBe(403);
      },
      { allowedOrigins: ["https://desk.example"] },
    );
  });

  it("reloads sessions/messages/events after a daemon restart and interrupts leftover runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-server-restart-"));
    const storePath = join(dir, "sessions.db");
    const token = "test-token";
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt() {
            return { messages: [] };
          },
          async close() {},
          async compact() {
            return {
              messageCount: 1,
              transcript: [
                {
                  role: "user",
                  parts: [
                    {
                      type: "text",
                      status: "completed",
                      text: "survived restart",
                    },
                  ],
                },
              ],
            };
          },
        };
      },
    };
    try {
      const first = new VykorHttpServer({
        token,
        storePath,
        createAgent: adaptTestAgentFactory(runtimeFactory),
      });
      const listen1 = await first.listen();
      try {
        await fetch(`${listen1.url}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            id: "s1",
            cwd: process.cwd(),
            model: "m",
            title: "Keep me",
          }),
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        await fetch(`${listen1.url}/sessions/s1/compact`, {
          method: "POST",
          headers: auth(token),
        });
        // Simulate a previous daemon crash leaving an active run on disk.
        first.store.runs.createRun({ id: "r-stale", sessionId: "s1" });
        first.store.runs.updateRun("r-stale", { status: "running" });
        const staleMessage = first.store.conversations.createMessage({
          id: "m-stale",
          sessionId: "s1",
          role: "assistant",
          runId: "r-stale",
        });
        first.store.conversations.upsertMessagePart({
          id: "part-stale",
          sessionId: "s1",
          messageId: staleMessage.id,
          type: "text",
          status: "running",
          text: "unfinished",
        });
        first.store.permissions.create({
          id: "permission-stale",
          sessionId: "s1",
          runId: "r-stale",
          toolName: "Write",
        });
        first.store.createSessionTask({
          id: "task-stale",
          sessionId: "s1",
          type: "agent",
          description: "stale child",
          cwd: process.cwd(),
        });
        first.store.sessions.create({
          id: "child-settlement-session",
          parentId: "s1",
          cwd: process.cwd(),
          model: "m",
        });
        first.store.createSessionTask({
          id: "child-settlement",
          sessionId: "s1",
          childSessionId: "child-settlement-session",
          type: "agent",
          description: "terminal child awaiting projection repair",
          cwd: process.cwd(),
        });
        first.store.createProjectionSettlement(
          projectionSettlementInput(
            "daemon-agent:crashed-agent",
            "s1",
            {
              id: "child-close-before-crash",
              sequence: 17,
              occurredAt: new Date().toISOString(),
              type: "child.closed",
              data: {
                childId: "child-settlement",
                sessionId: "child-settlement-session",
                result: {
                  status: "completed",
                  output: "recovered child output",
                },
              },
              context: {
                agentId: "crashed-agent",
                sessionId: "s1",
                childId: "child-settlement",
                traceId: "trace-child-settlement",
              },
            },
            "retry-terminal-projection",
            new Error("daemon crashed before child task completion persisted"),
          ),
        );
        first.store.conversationTransactions.admitPrompt({
          id: "input-orphaned-before-restart",
          sessionId: "s1",
          delivery: "steer",
          content: "not yet delivered",
          metadata: { traceId: "trace-orphaned" },
        });
      } finally {
        await first.close();
      }

      const second = new VykorHttpServer({ token, storePath });
      const listen2 = await second.listen();
      try {
        const sessions = (await (
          await fetch(`${listen2.url}/sessions`, { headers: auth(token) })
        ).json()) as {
          sessions: Array<{ id: string; title: string }>;
        };
        expect(sessions.sessions.map((row) => row.id)).toEqual(["s1"]);
        expect(sessions.sessions[0]?.title).toBe("Keep me");

        const state = (await (
          await fetch(`${listen2.url}/sessions/s1/state`, {
            headers: auth(token),
          })
        ).json()) as {
          messages: Array<{ role: string }>;
          parts: Array<{ id: string; text?: string; status: string }>;
          runs: Array<{
            id: string;
            inputId?: string;
            status: string;
            error?: string;
            metadata: Record<string, unknown>;
          }>;
          tasks: Array<{ id: string; status: string }>;
          permissions: Array<{ id: string; status: string; decision?: string }>;
        };
        expect(state.messages).toHaveLength(3);
        expect(state.parts[0]?.text).toBe("survived restart");
        expect(state.parts.some((part) => part.text === "已压缩上下文")).toBe(true);
        expect(
          state.parts.find((part) => part.id === "part-stale")?.status,
        ).toBe("interrupted");
        expect(state.runs.find((run) => run.id === "r-stale")?.status).toBe(
          "interrupted",
        );
        expect(
          state.runs.find(
            (run) => run.inputId === "input-orphaned-before-restart",
          ),
        ).toMatchObject({
          status: "interrupted",
          error: "Daemon restarted before the input was assigned to a run",
          metadata: {
            traceId: "trace-orphaned",
            recovery: expect.objectContaining({ kind: "orphan_input" }),
          },
        });
        expect(
          state.tasks.find((task) => task.id === "task-stale")?.status,
        ).toBe("interrupted");
        expect(
          state.tasks.find((task) => task.id === "child-settlement"),
        ).toMatchObject({
          status: "completed",
          output: "recovered child output",
        });
        expect(
          state.permissions.find(
            (request) => request.id === "permission-stale",
          ),
        ).toMatchObject({
          status: "expired",
          decision: "Daemon restarted before the permission was resolved",
        });

        const events = (await (
          await fetch(`${listen2.url}/events`, { headers: auth(token) })
        ).json()) as {
          events: Array<{ type: string }>;
        };
        expect(events.events.map((event) => event.type)).toContain(
          "session.transcript.replaced",
        );
        expect(events.events.map((event) => event.type)).toContain(
          "session.run.updated",
        );
        expect(events.events.map((event) => event.type)).toContain(
          "session.task.updated",
        );
        expect(events.events.map((event) => event.type)).toContain(
          "permission.replied",
        );
        expect(events.events.map((event) => event.type)).toContain(
          "agent.child.closed",
        );

        const runtime = (await (
          await fetch(`${listen2.url}/debug/runtime`, { headers: auth(token) })
        ).json()) as {
          projectionSettlements: {
            total: number;
            pending: number;
            byStatus: Record<string, number>;
          };
        };
        expect(runtime.projectionSettlements).toMatchObject({
          total: 1,
          pending: 0,
          byStatus: { resolved: 1 },
        });
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays an interrupted prompt only after an explicit, idempotent recovery request", async () => {
    const prompts: string[] = [];
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt(input) {
            prompts.push(input.input.content);
            return { messages: [] };
          },
          async close() {},
        };
      },
    };

    await withServer(
      async ({ baseUrl, token, server }) => {
        const session = server.store.sessions.create({
          id: "s1",
          cwd: process.cwd(),
          model: "m",
          metadata: { runtime: { model: "m" } },
        });
        const input = server.store.conversationTransactions.admitPrompt({
          id: "input-before-restart",
          sessionId: session.id,
          content: "finish the report",
        });
        const interrupted = server.store.runs.createRun({
          id: "run-before-restart",
          sessionId: session.id,
          inputId: input.id,
        });
        server.store.runs.updateRun(interrupted.id, {
          status: "interrupted",
          error: "Daemon restarted before the run completed",
        });

        const first = await fetch(
          `${baseUrl}/sessions/s1/runs/run-before-restart/resume`,
          {
            method: "POST",
            headers: { ...auth(token), "content-type": "application/json" },
            body: JSON.stringify({ id: "recovery-request-1" }),
          },
        );
        expect(first.status).toBe(202);
        const recovered = (await first.json()) as {
          input: {
            id: string;
            content: string;
            metadata: Record<string, unknown>;
          };
          run?: { id: string; metadata: Record<string, unknown> };
          source_run: { id: string; status: string };
        };
        expect(recovered).toMatchObject({
          input: {
            id: "input-before-restart",
            content: "finish the report",
            metadata: {},
          },
          run: {
            id: "recovery-request-1",
            metadata: { recovery: { sourceRunId: "run-before-restart" } },
          },
          source_run: { id: "run-before-restart", status: "interrupted" },
        });
        expect(recovered.run?.id).toBeTruthy();

        await waitForEvent(
          baseUrl,
          token,
          (event) => event.type === "session.run.recovery_requested",
        );
        expect(prompts).toEqual(["finish the report"]);

        const retry = await fetch(
          `${baseUrl}/sessions/s1/runs/run-before-restart/resume`,
          {
            method: "POST",
            headers: { ...auth(token), "content-type": "application/json" },
            body: JSON.stringify({ id: "recovery-request-1" }),
          },
        );
        expect(retry.status).toBe(202);
        expect(((await retry.json()) as { run?: { id: string } }).run?.id).toBe(
          recovered.run?.id,
        );
        expect(
          server.store
            .conversations.listEvents({ sessionId: "s1" })
            .filter((event) => event.type === "session.run.recovery_requested"),
        ).toHaveLength(1);

        const duplicate = await fetch(
          `${baseUrl}/sessions/s1/runs/run-before-restart/resume`,
          {
            method: "POST",
            headers: { ...auth(token), "content-type": "application/json" },
            body: JSON.stringify({ id: "different-recovery-request" }),
          },
        );
        expect(duplicate.status).toBe(409);
        expect(server.store.runs.getRun("run-before-restart")?.status).toBe(
          "interrupted",
        );
      },
      { runtimeFactory },
    );
  });

  it("keeps traced recovery, permission, SSE replay, and another session independent after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-server-e2e-recovery-"));
    const storePath = join(dir, "sessions.db");
    const token = "test-token";
    const recoveryTraceId = "trace-recovery-e2e-001";
    const parallelTraceId = "trace-parallel-e2e-001";
    const logs: ObservabilityEvent[] = [];
    let first: VykorHttpServer | undefined;
    let second: VykorHttpServer | undefined;

    try {
      first = new VykorHttpServer({
        token,
        storePath,
        logger: (event) => logs.push(event),
      });
      await first.listen();
      const recoverySession = first.store.sessions.create({
        id: "recover",
        cwd: process.cwd(),
        model: "m",
        metadata: { runtime: { model: "m" } },
      });
      first.store.sessions.create({
        id: "parallel",
        cwd: process.cwd(),
        model: "m",
        metadata: { runtime: { model: "m" } },
      });
      const sourceInput = first.store.conversationTransactions.admitPrompt({
        id: "source-input",
        sessionId: recoverySession.id,
        content: "recover after restart",
        metadata: { traceId: recoveryTraceId },
      });
      const sourceRun = first.store.runs.createRun({
        id: "source-run",
        sessionId: recoverySession.id,
        inputId: sourceInput.id,
        metadata: { traceId: recoveryTraceId },
      });
      first.store.runs.updateRun(sourceRun.id, {
        status: "interrupted",
        error: "Daemon restarted before the run completed",
      });
      await first.close();
      first = undefined;

      const runtimeFactory: TestAgentProgramFactory = {
        async createRuntime() {
          return {
            async runPrompt(input, run) {
              if (input.session.id === "recover") {
                const decision = await run.requestPermission({
                  toolName: "Write",
                  reason: "apply recovered change",
                  input: { path: "README.md" },
                });
                await run.emit({
                  type: "output.text.delta",
                  data: {
                    delta:
                      decision.status === "approved" ? "recovered" : "denied",
                  },
                });
              } else {
                await run.emit({
                  type: "output.text.delta",
                  data: { delta: "parallel completed" },
                });
              }
              return { messages: [] };
            },
            async close() {},
          };
        },
      };
      second = new VykorHttpServer({
        token,
        storePath,
        createAgent: adaptTestAgentFactory(runtimeFactory),
        logger: (event) => logs.push(event),
      });
      const listen = await second.listen();

      const streamAbort = new AbortController();
      const replay = await fetch(
        `${listen.url}/events/stream?sessionId=recover`,
        {
          headers: { ...auth(token), "last-event-id": "0" },
          signal: streamAbort.signal,
        },
      );
      const replayReader = replay.body!.getReader();
      const decoder = new TextDecoder();
      let replayText = "";
      for (
        let i = 0;
        i < 10 && !replayText.includes("session.run.updated");
        i += 1
      ) {
        const chunk = await replayReader.read();
        if (chunk.done) break;
        replayText += decoder.decode(chunk.value, { stream: true });
      }
      await replayReader.cancel();
      streamAbort.abort();
      expect(replayText).toContain("session.run.updated");
      expect(replayText).toContain(recoveryTraceId);

      const resumedResponse = await fetch(
        `${listen.url}/sessions/recover/runs/source-run/resume`,
        {
          method: "POST",
          headers: {
            ...auth(token),
            "content-type": "application/json",
            "x-vykor-trace-id": recoveryTraceId,
          },
          body: JSON.stringify({ id: "recover-request" }),
        },
      );
      expect(resumedResponse.status).toBe(202);
      expect(resumedResponse.headers.get("x-vykor-trace-id")).toBe(
        recoveryTraceId,
      );
      const resumed = (await resumedResponse.json()) as {
        run: { id: string; metadata: Record<string, unknown> };
      };
      expect(resumed.run.metadata.traceId).toBe(recoveryTraceId);

      await waitForEvent(
        listen.url,
        token,
        (event) => event.type === "permission.asked",
      );
      const pending = (await (
        await fetch(
          `${listen.url}/permissions?sessionId=recover&status=pending`,
          {
            headers: auth(token),
          },
        )
      ).json()) as {
        requests: Array<{ id: string; payload: Record<string, unknown> }>;
      };
      expect(pending.requests).toHaveLength(1);
      expect(pending.requests[0]?.payload.traceId).toBe(recoveryTraceId);

      const parallelResponse = await fetch(
        `${listen.url}/sessions/parallel/prompts`,
        {
          method: "POST",
          headers: {
            ...auth(token),
            "content-type": "application/json",
            "x-vykor-trace-id": parallelTraceId,
          },
          body: JSON.stringify({
            id: "parallel-input",
            content: "continue independently",
          }),
        },
      );
      expect(parallelResponse.status).toBe(202);
      const parallel = (await parallelResponse.json()) as {
        run: { id: string };
      };
      for (
        let i = 0;
        i < 20 && second.store.runs.getRun(parallel.run.id)?.status !== "completed";
        i += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(second.store.runs.getRun(parallel.run.id)?.status).toBe("completed");
      expect(second.store.runs.getRun(resumed.run.id)?.status).toBe("running");

      const reply = await fetch(
        `${listen.url}/permissions/${pending.requests[0]!.id}/reply`,
        {
          method: "POST",
          headers: {
            ...auth(token),
            "content-type": "application/json",
            "x-vykor-trace-id": recoveryTraceId,
          },
          body: JSON.stringify({
            status: "approved",
            decision: "once",
            clientId: "reconnected-client",
          }),
        },
      );
      expect(reply.status).toBe(200);
      for (
        let i = 0;
        i < 20 && second.store.runs.getRun(resumed.run.id)?.status !== "completed";
        i += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(second.store.runs.getRun(resumed.run.id)?.status).toBe("completed");
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "session.run.started",
            traceId: recoveryTraceId,
            runId: resumed.run.id,
          }),
          expect.objectContaining({
            event: "permission.requested",
            traceId: recoveryTraceId,
          }),
          expect.objectContaining({
            event: "permission.replied",
            traceId: recoveryTraceId,
          }),
          expect.objectContaining({
            event: "session.run.completed",
            traceId: recoveryTraceId,
            runId: resumed.run.id,
          }),
          expect.objectContaining({
            event: "session.run.completed",
            traceId: parallelTraceId,
            runId: parallel.run.id,
          }),
        ]),
      );
    } finally {
      await second?.close();
      await first?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("terminalizes durable running workflows after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-server-workflow-restart-"));
    const storePath = join(dir, "sessions.db");
    const projectCwd = join(dir, "project");
    const spec = {
      mode: "sequential" as const,
      tasks: [{ id: "child", prompt: "finish the child task" }],
    };
    const plan = createWorkflowPlan(spec);
    const now = Date.now();
    const createRunningSnapshot = (runId: string, ownerSession?: string) =>
      createWorkflowRunSnapshot({
        runId,
        ownerSession,
        status: "running",
        summary: "Workflow started",
        spec,
        plan,
        results: new Map(),
        running: new Set(["child"]),
        runningTasks: new Map([
          [
            "child",
            {
              taskId: "child",
              attempt: 1,
              dependencies: [],
              startedAt: now,
              summary: "Child session is running",
              metadata: { workerTaskId: "task-lost-with-daemon" },
            },
          ],
        ]),
        createdAt: now,
      });
    const daemonRunId = "wf-daemon-owned";
    try {
      const first = new VykorHttpServer({ storePath });
      await first.application.ready();
      const parent = first.store.sessions.create({
        id: "parent",
        cwd: projectCwd,
        model: "m",
        title: "parent",
        metadata: { runtime: { model: "m" } },
      });
      const child = first.store.sessions.create({
        id: "child",
        parentId: parent.id,
        cwd: projectCwd,
        model: "m",
        title: "child",
        metadata: { runtime: { model: "m" } },
      });
      const staleChildRun = first.store.runs.createRun({
        id: "child-run",
        sessionId: child.id,
      });
      first.store.runs.updateRun(staleChildRun.id, { status: "running" });
      first.application.workflows.save(
        createRunningSnapshot(daemonRunId, parent.id),
      );
      first.application.workflows.claim(daemonRunId);

      await first.close();
      const second = new VykorHttpServer({ storePath });
      await second.listen();
      try {
        const recovered = second.application.workflows.load(daemonRunId)!;
        expect(recovered.status).toBe("failed");
        expect(recovered.results.child).toMatchObject({
          status: "killed",
          summary: "Daemon restarted before the workflow completed",
        });
        expect(recovered.runningTaskIds).toEqual([]);
        expect(second.store.runs.getRun(staleChildRun.id)).toMatchObject({
          status: "interrupted",
        });
        expect(
          second.store
            .sessions.listChildren(parent.id)
            .map((session) => session.id),
        ).toEqual([child.id]);
        expect(
          second.store
            .conversations.listEvents({ sessionId: parent.id })
            .find((event) => event.type === "workflow.workflow_cancelled"),
        ).toMatchObject({ payload: { event: { runId: daemonRunId } } });
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists builtin session commands and provider template commands by cwd", async () => {
    const commandCatalog: CommandCatalogProvider = {
      async list({ cwd }) {
        expect(cwd).toBe(process.cwd());
        return [
          {
            name: "/pr",
            description: "Write a PR",
            kind: "template",
            source: "user",
          },
        ];
      },
    };
    await withServer(
      async ({ baseUrl, token }) => {
        const response = await fetch(
          `${baseUrl}/commands?cwd=${encodeURIComponent(process.cwd())}`,
          {
            headers: auth(token),
          },
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          commands: Array<{ name: string; kind: string; description?: string }>;
        };
        expect(body.commands.map((command) => command.name)).toEqual(
          expect.arrayContaining(["/skills", "/pr", "/commit"]),
        );
        expect(body.commands.map((command) => command.name)).not.toContain(
          "/model",
        );
        expect(
          body.commands.find((command) => command.name === "/pr"),
        ).toMatchObject({
          kind: "template",
          description: "Write a PR",
        });
        expect(
          body.commands.find((command) => command.name === "/commit"),
        ).toMatchObject({
          kind: "session",
        });
      },
      { commandCatalog },
    );
  });

  it("patches session runtime model via metadata", async () => {
    await withServer(async ({ baseUrl, token }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({
          id: "s1",
          cwd: process.cwd(),
          model: "old-model",
        }),
      });
      const patched = await fetch(`${baseUrl}/sessions/s1`, {
        method: "PATCH",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ metadata: { runtime: { model: "new-model" } } }),
      });
      expect(patched.status).toBe(200);
      const body = (await patched.json()) as {
        session: { model: string; metadata: Record<string, unknown> };
      };
      expect(body.session.model).toBe("new-model");
      expect(body.session.metadata.runtime).toMatchObject({
        model: "new-model",
      });

      const events = (await (
        await fetch(`${baseUrl}/events`, { headers: auth(token) })
      ).json()) as {
        events: Array<{ type: string }>;
      };
      expect(events.events.map((event) => event.type)).toContain(
        "session.updated",
      );
    });
  });

  it("rejects legacy session model patch bodies", async () => {
    await withServer(async ({ baseUrl, token }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({
          id: "s1",
          cwd: process.cwd(),
          model: "old-model",
        }),
      });
      const patched = await fetch(`${baseUrl}/sessions/s1`, {
        method: "PATCH",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ model: "new-model" }),
      });
      expect(patched.status).toBe(400);
      await expect(patched.json()).resolves.toMatchObject({
        code: "invalid_request",
        message: "model must be changed through metadata.runtime.model",
      });
    });
  });

  it("merges session metadata and closes runtime when permissionMode changes", async () => {
    const created: string[] = [];
    const closed: string[] = [];
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime(context) {
        created.push(context.session.id);
        return {
          async runPrompt() {
            return { messages: [] };
          },
          async close() {
            closed.push(context.session.id);
          },
        };
      },
    };

    await withServer(
      async ({ baseUrl, token }) => {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            id: "s1",
            cwd: process.cwd(),
            model: "m",
            metadata: {
              runtime: { model: "m", maxTurns: 9, permissionMode: "default" },
            },
          }),
        });
        for (let i = 0; i < 20 && created.length === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(created).toEqual(["s1"]);

        const patched = await fetch(`${baseUrl}/sessions/s1`, {
          method: "PATCH",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            metadata: { runtime: { permissionMode: "plan" } },
          }),
        });
        expect(patched.status).toBe(200);
        const body = (await patched.json()) as {
          session: { metadata: Record<string, unknown> };
        };
        expect(body.session.metadata).toEqual({
          runtimeRevision: 1,
          runtime: {
            model: "m",
            maxTurns: 9,
            permissionMode: "plan",
          },
        });
        expect(closed).toContain("s1");

        await fetch(`${baseUrl}/sessions/s1`, { headers: auth(token) });
        for (let i = 0; i < 20 && created.length < 2; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(created.filter((id) => id === "s1")).toHaveLength(2);
      },
      { runtimeFactory },
    );
  });

  it("serves settings and providers through resource APIs", async () => {
    let current = {
      model: "m",
      provider: "openai",
      permission: { mode: "default" },
    };
    let restart = false;
    await withServer(
      async ({ baseUrl, token }) => {
        const settings = (await (
          await fetch(`${baseUrl}/settings`, { headers: auth(token) })
        ).json()) as {
          settings: { model: string };
        };
        expect(settings.settings.model).toBe("m");

        const patched = await fetch(`${baseUrl}/settings`, {
          method: "PATCH",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ provider: "anthropic" }),
        });
        expect(patched.status).toBe(200);
        expect(restart).toBe(true);
        expect(
          ((await patched.json()) as { settings: { provider: string } })
            .settings.provider,
        ).toBe("anthropic");

        const providers = (await (
          await fetch(`${baseUrl}/providers`, { headers: auth(token) })
        ).json()) as {
          providers: Array<{ name: string; active: boolean }>;
        };
        expect(providers.providers).toEqual([
          {
            name: "openai",
            displayName: "OpenAI",
            hasKey: true,
            active: false,
          },
          {
            name: "anthropic",
            displayName: "Anthropic",
            hasKey: false,
            active: true,
          },
        ]);
      },
      {
        settingsService: {
          get: () => current,
          patch: (patch) => {
            current = { ...current, ...patch, permission: current.permission };
            restart = true;
            return { settings: current, restartRuntimes: true };
          },
        },
        providerService: {
          list: () => [
            {
              name: "openai",
              displayName: "OpenAI",
              hasKey: true,
              active: current.provider === "openai",
            },
            {
              name: "anthropic",
              displayName: "Anthropic",
              hasKey: false,
              active: current.provider === "anthropic",
            },
          ],
        },
      },
    );
  });

  it("returns MCP inspect status for a warmed session runtime", async () => {
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt() {
            return { messages: [] };
          },
          async close() {},
          inspect() {
            return {
              mcpServers: [
                {
                  name: "demo",
                  status: "connected",
                  toolCount: 2,
                  resourceCount: 1,
                  command: "demo",
                },
              ],
            };
          },
        };
      },
    };
    await withServer(
      async ({ baseUrl, token }) => {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
        });
        // Wait briefly for warmRuntime.
        await new Promise((resolve) => setTimeout(resolve, 20));
        const response = await fetch(`${baseUrl}/sessions/s1/mcp`, {
          headers: auth(token),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          servers: [
            {
              name: "demo",
              status: "connected",
              toolCount: 2,
              resourceCount: 1,
              command: "demo",
            },
          ],
        });
      },
      { runtimeFactory },
    );
  });

  it("manages memory entries via resource APIs", async () => {
    const entries = new Map<
      string,
      {
        id: string;
        content: string;
        tags?: string[];
        createdAt: number;
        updatedAt: number;
      }
    >();
    await withServer(
      async ({ baseUrl, token }) => {
        const created = await fetch(`${baseUrl}/memory`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ cwd: process.cwd(), content: "prefer pnpm" }),
        });
        expect(created.status).toBe(201);
        const createdBody = (await created.json()) as {
          entry: { id: string; content: string };
        };
        expect(createdBody.entry.content).toBe("prefer pnpm");

        const listed = (await (
          await fetch(
            `${baseUrl}/memory?cwd=${encodeURIComponent(process.cwd())}`,
            { headers: auth(token) },
          )
        ).json()) as { directory: string; entries: Array<{ id: string }> };
        expect(listed.directory).toBe("/tmp/memory");
        expect(listed.entries.map((entry) => entry.id)).toContain(
          createdBody.entry.id,
        );

        const removed = await fetch(
          `${baseUrl}/memory/${createdBody.entry.id}?cwd=${encodeURIComponent(process.cwd())}`,
          { method: "DELETE", headers: auth(token) },
        );
        expect(removed.status).toBe(200);
      },
      {
        memoryService: {
          async list() {
            return { directory: "/tmp/memory", entries: [...entries.values()] };
          },
          async get({ id }) {
            return entries.get(id) ?? null;
          },
          async add({ content, tags }) {
            const entry = {
              id: `m${entries.size + 1}`,
              content,
              ...(tags ? { tags } : {}),
              createdAt: 1,
              updatedAt: 1,
            };
            entries.set(entry.id, entry);
            return entry;
          },
          async remove({ id }) {
            return entries.delete(id);
          },
        },
      },
    );
  });

  it("manages auth status/login/logout via resource APIs", async () => {
    const stored = new Set<string>();
    await withServer(
      async ({ baseUrl, token }) => {
        const status = (await (
          await fetch(`${baseUrl}/auth`, { headers: auth(token) })
        ).json()) as {
          auth: { storedProviders: string[]; codex: { configured: boolean } };
        };
        expect(status.auth.storedProviders).toEqual([]);
        expect(status.auth.codex.configured).toBe(false);

        const login = await fetch(`${baseUrl}/auth/login`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ provider: "openai", apiKey: "sk-test" }),
        });
        expect(login.status).toBe(200);
        expect(stored.has("openai")).toBe(true);

        const logout = await fetch(`${baseUrl}/auth/logout`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ provider: "openai" }),
        });
        expect(logout.status).toBe(200);
        expect(stored.has("openai")).toBe(false);
      },
      {
        authService: {
          async status() {
            return {
              codex: {
                configured: false,
                state: "missing",
                source: "/tmp/auth.json",
              },
              storedProviders: [...stored],
              envProviders: [],
            };
          },
          async login({ provider, apiKey }) {
            if (!apiKey) throw new Error("apiKey required");
            stored.add(provider);
            return { message: `stored ${provider}` };
          },
          async logout({ provider }) {
            stored.delete(provider);
            return { message: `cleared ${provider}` };
          },
        },
      },
    );
  });

  it("returns context preview reports", async () => {
    await withServer(
      async ({ baseUrl, token }) => {
        const response = await fetch(
          `${baseUrl}/context?cwd=${encodeURIComponent(process.cwd())}`,
          { headers: auth(token) },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ report: "CONTEXT REPORT" });
      },
      {
        contextService: {
          async preview() {
            return { report: "CONTEXT REPORT" };
          },
          async status() {
            return { report: "CONTEXT STATUS" };
          },
        },
      },
    );
  });

  it("creates, updates and removes custom providers through resource APIs", async () => {
    const records = new Map<string, { id: string; displayName: string }>();
    const catalogConnections = new Set<string>();
    await withServer(
      async ({ baseUrl, token }) => {
        const input = {
          id: "office-gateway",
          displayName: "Office Gateway",
          baseUrl: "https://gateway.example/v1",
          apiFormat: "openai",
          models: [{ id: "team-model", displayName: "Team Model" }],
        };
        const created = await fetch(`${baseUrl}/providers/custom`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        expect(created.status).toBe(201);
        expect(await created.json()).toMatchObject({
          provider: { name: "office-gateway" },
        });

        const connected = await fetch(
          `${baseUrl}/providers/catalog/remote/connect`,
          {
            method: "POST",
            headers: { ...auth(token), "content-type": "application/json" },
            body: JSON.stringify({ apiKey: "secret" }),
          },
        );
        expect(connected.status).toBe(200);
        expect(catalogConnections.has("remote")).toBe(true);

        const disconnected = await fetch(
          `${baseUrl}/providers/catalog/remote/connect`,
          {
            method: "DELETE",
            headers: auth(token),
          },
        );
        expect(disconnected.status).toBe(200);
        expect(catalogConnections.has("remote")).toBe(false);

        const updated = await fetch(
          `${baseUrl}/providers/custom/office-gateway`,
          {
            method: "PATCH",
            headers: { ...auth(token), "content-type": "application/json" },
            body: JSON.stringify({ ...input, displayName: "Office AI" }),
          },
        );
        expect(updated.status).toBe(200);
        expect(await updated.json()).toMatchObject({
          provider: { displayName: "Office AI" },
        });

        const removed = await fetch(
          `${baseUrl}/providers/custom/office-gateway`,
          {
            method: "DELETE",
            headers: auth(token),
          },
        );
        expect(removed.status).toBe(200);
        expect(records.has("office-gateway")).toBe(false);
      },
      {
        providerService: {
          list: () => [],
          create: (input) => {
            records.set(input.id, {
              id: input.id,
              displayName: input.displayName,
            });
            return {
              name: input.id,
              displayName: input.displayName,
              hasKey: false,
              active: false,
              custom: true,
            };
          },
          update: (id, input) => {
            records.set(id, { id, displayName: input.displayName });
            return {
              name: id,
              displayName: input.displayName,
              hasKey: false,
              active: false,
              custom: true,
            };
          },
          remove: (id) => {
            records.delete(id);
          },
          connectCatalog: (id, input) => {
            if (!input.apiKey) throw new Error("apiKey required");
            catalogConnections.add(id);
            return {
              name: id,
              displayName: "Remote AI",
              hasKey: true,
              active: false,
              source: "catalog",
            };
          },
          disconnectCatalog: (id) => {
            catalogConnections.delete(id);
          },
        },
      },
    );
  });

  it("forwards catalog connect headers and patch updates through system routes", async () => {
    const release = vi.fn();
    const closeAllRuntimes = vi.fn(async () => {});
    const connectCatalog = vi.fn(async () => ({
      name: "remote",
      displayName: "Remote AI",
      hasKey: true,
      active: false,
      source: "catalog" as const,
    }));
    const updateCatalogHeaders = vi.fn(async () => ({
      name: "remote",
      displayName: "Remote AI",
      hasKey: true,
      active: false,
      source: "catalog" as const,
    }));
    const { createSystemRoutes } = await import("../routes/system.js");
    const { ProviderMutationError } = await import(
      "../../application/default-services/provider-service.js"
    );
    const routes = createSystemRoutes({
      providerService: {
        list: () => [],
        connectCatalog,
        updateCatalogHeaders,
      },
      control: {
        acquireGlobalMutation: vi.fn(() => ({ release })),
        closeAllRuntimes,
        invalidateRuntimes: vi.fn(async () => {}),
        runtimeSnapshot: () => ({
          startedAt: 0,
          uptimeMs: 0,
          sessions: { total: 0, byStatus: {} },
          runs: { total: 0, byStatus: {} },
          tasks: { total: 0, byStatus: {} },
          permissions: { total: 0, byStatus: {} },
          projectionSettlements: { total: 0, pending: 0, byStatus: {} },
          sseClientCount: 0,
          warmAgentCount: 0,
          coordinator: { activeRunCount: 0, queuedRunCount: 0 },
          metrics: { counters: {}, gauges: {}, histograms: {} },
        }),
        inspectRun: () => undefined,
        listProjectionDiagnostics: () => ({
          settlements: [],
          pending: 0,
          diagnosticOk: true,
          includeContent: false,
        }),
      },
    });

    const connected = await routes.request("/providers/catalog/remote/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiKey: "secret",
        headers: { "X-Session": "{{sessionId}}" },
      }),
    });
    expect(connected.status).toBe(200);
    expect(connectCatalog).toHaveBeenCalledWith("remote", {
      apiKey: "secret",
      headers: { "X-Session": "{{sessionId}}" },
    });
    expect(closeAllRuntimes).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();

    closeAllRuntimes.mockClear();
    release.mockClear();
    const missingHeaders = await routes.request("/providers/catalog/remote", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missingHeaders.status).toBe(400);
    expect(updateCatalogHeaders).not.toHaveBeenCalled();
    expect(closeAllRuntimes).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();

    closeAllRuntimes.mockClear();
    release.mockClear();
    const cleared = await routes.request("/providers/catalog/remote", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ headers: {} }),
    });
    expect(cleared.status).toBe(200);
    expect(updateCatalogHeaders).toHaveBeenCalledWith("remote", {});
    expect(closeAllRuntimes).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();

    closeAllRuntimes.mockClear();
    release.mockClear();
    connectCatalog.mockRejectedValueOnce(
      new ProviderMutationError(400, "Unknown template variable"),
    );
    const invalid = await routes.request("/providers/catalog/remote/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiKey: "secret",
        headers: { "X-Test": "{{unknown}}" },
      }),
    });
    expect(invalid.status).toBe(400);
    expect(closeAllRuntimes).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("compacts a session transcript through the runtime and store", async () => {
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt() {
            return { messages: [] };
          },
          async close() {},
          async compact() {
            return {
              messageCount: 1,
              transcript: [
                {
                  role: "assistant",
                  parts: [
                    { type: "text", status: "completed", text: "summary" },
                  ],
                },
              ],
            };
          },
        };
      },
    };
    await withServer(
      async ({ baseUrl, token }) => {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        const response = await fetch(`${baseUrl}/sessions/s1/compact`, {
          method: "POST",
          headers: auth(token),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          messageCount: number;
          messages: Array<{ role: string }>;
          parts: Array<{ text?: string }>;
        };
        expect(body.messageCount).toBe(1);
        expect(body.messages).toHaveLength(1);
        expect(body.parts[0]?.text).toBe("summary");
        const events = (await (
          await fetch(`${baseUrl}/events`, { headers: auth(token) })
        ).json()) as {
          events: Array<{ type: string }>;
        };
        expect(events.events.map((event) => event.type)).toContain(
          "session.transcript.replaced",
        );
      },
      { runtimeFactory },
    );
  });

  it("returns session usage and exports transcript files", async () => {
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt() {
            return { messages: [] };
          },
          async close() {},
          getUsage() {
            return {
              inputTokens: 10,
              outputTokens: 20,
              cacheCreationTokens: 1,
              cacheReadTokens: 2,
              messageCount: 1,
            };
          },
        };
      },
    };
    await withServer(
      async ({ baseUrl, token }) => {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            id: "s1",
            cwd: process.cwd(),
            model: "gpt-4o-mini",
          }),
        });
        const usage = await fetch(`${baseUrl}/sessions/s1/usage`, {
          headers: auth(token),
        });
        expect(usage.status).toBe(200);
        const usageBody = (await usage.json()) as {
          inputTokens: number;
          outputTokens: number;
          estimatedCost: string;
          model: string;
        };
        expect(usageBody.model).toBe("gpt-4o-mini");
        expect(usageBody.inputTokens).toBe(10);
        expect(usageBody.outputTokens).toBe(20);
        expect(usageBody.estimatedCost).toMatch(/^\$/);

        const emptyExport = await fetch(`${baseUrl}/sessions/s1/export`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(emptyExport.status).toBe(400);
      },
      { runtimeFactory },
    );
  });

  it("lists output styles via resource API", async () => {
    await withServer(
      async ({ baseUrl, token }) => {
        const response = await fetch(`${baseUrl}/output-styles`, {
          headers: auth(token),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          styles: [{ name: "default", content: "std", source: "builtin" }],
        });
      },
      {
        outputStyleService: {
          list() {
            return [
              { name: "default", content: "std", source: "builtin" as const },
            ];
          },
        },
      },
    );
  });

  it("accepts only user-scoped Native Plugin installation requests", async () => {
    const installLocal = vi.fn(async () => ({ message: "Installed plugin 'demo'." }));
    await withServer(
      async ({ baseUrl, token }) => {
        const projectInstall = await fetch(`${baseUrl}/plugins/install-local`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            cwd: process.cwd(), sourcePath: process.cwd(), scope: "project", approvedPermissions: [],
          }),
        });
        expect(projectInstall.status).toBe(400);
        expect(installLocal).not.toHaveBeenCalled();

        const userInstall = await fetch(`${baseUrl}/plugins/install-local`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            cwd: process.cwd(), sourcePath: process.cwd(), scope: "user", approvedPermissions: [],
          }),
        });
        expect(userInstall.status).toBe(200);
        expect(installLocal).toHaveBeenCalledWith({
          cwd: process.cwd(), sourcePath: process.cwd(), scope: "user", approvedPermissions: [], link: false,
        });
      },
      {
        pluginService: {
          async list() { return { plugins: [], warnings: [] }; },
          async setEnabled() { return { message: "unchanged" }; },
          installLocal,
        },
      },
    );
  });

  it("exposes project/plugin/hooks/git and background-shell resource APIs", async () => {
    await withServer(
      async ({ baseUrl, token }) => {
        const init = await fetch(`${baseUrl}/project/init`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ cwd: process.cwd() }),
        });
        expect(init.status).toBe(200);
        expect(await init.json()).toEqual({ report: "INIT OK" });

        const plugins = await fetch(
          `${baseUrl}/plugins?cwd=${encodeURIComponent(process.cwd())}`,
          {
            headers: auth(token),
          },
        );
        expect(plugins.status).toBe(200);
        expect(await plugins.json()).toEqual({
          plugins: [
            {
              identity: { id: "demo", name: "demo", version: "1.0.0" },
              origin: "native",
              scope: "user",
              enabled: true,
              installation: "installed",
              activation: "active",
              runtimeStatus: {
                state: "loaded",
                message: "插件已加载。",
                action: "none",
              },
              inventory: { skills: 1 },
              permissions: { requested: [], approved: [], missing: [] },
              diagnostics: [],
            },
          ],
          warnings: [],
        });

        const enable = await fetch(`${baseUrl}/plugins/demo/enable`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ cwd: process.cwd() }),
        });
        expect(enable.status).toBe(200);
        expect(await enable.json()).toEqual({
          message: "Enabled plugin 'demo'.",
        });

        const personas = await fetch(`${baseUrl}/agent-personas`, {
          headers: auth(token),
        });
        expect(personas.status).toBe(200);
        expect(await personas.json()).toEqual({
          agents: [
            { name: "Explore", description: "search", source: "builtin" },
          ],
        });

        const hooks = await fetch(
          `${baseUrl}/hooks?cwd=${encodeURIComponent(process.cwd())}`,
          { headers: auth(token) },
        );
        expect(hooks.status).toBe(200);
        expect(await hooks.json()).toEqual({
          hooks: [
            {
              id: "h1",
              event: "stop",
              type: "command",
              enabled: true,
              origin: "settings",
            },
          ],
        });

        const diff = await fetch(
          `${baseUrl}/git/diff?cwd=${encodeURIComponent(process.cwd())}`,
          { headers: auth(token) },
        );
        expect(diff.status).toBe(200);
        expect(await diff.json()).toEqual({ output: "a.txt | 1 +\n" });

        const branch = await fetch(
          `${baseUrl}/git/branch?cwd=${encodeURIComponent(process.cwd())}&list=true`,
          { headers: auth(token) },
        );
        expect(branch.status).toBe(200);
        expect(await branch.json()).toEqual({ output: "* main\n" });

        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            id: "s-task",
            cwd: process.cwd(),
            model: "m",
          }),
        });
        const successfulShellCommand = `${process.execPath} -e "process.exit(0)"`;
        const missingSession = await fetch(`${baseUrl}/background-shells`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: "missing-session",
            command: successfulShellCommand,
          }),
        });
        expect(missingSession.status).toBe(404);
        await expect(missingSession.json()).resolves.toEqual({
          error: "Session not found",
        });

        const oldList = await fetch(`${baseUrl}/tasks?sessionId=s-task`, {
          headers: auth(token),
        });
        expect(oldList.status).toBe(404);

        const oldCreate = await fetch(`${baseUrl}/tasks`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: "s-task",
            command: successfulShellCommand,
          }),
        });
        expect(oldCreate.status).toBe(404);

        const backgroundShell = await fetch(`${baseUrl}/background-shells`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: "s-task",
            command: successfulShellCommand,
          }),
        });
        expect(backgroundShell.status).toBe(201);
        const receipt = (await backgroundShell.json()) as {
          jobId: string;
          snapshot: JobSnapshot;
        };
        expect(receipt.snapshot).toMatchObject({
          id: receipt.jobId,
          kind: "shell",
          ownerSession: "s-task",
        });

        const read = await fetch(
          `${baseUrl}/jobs/${receipt.jobId}?sessionId=s-task`,
          {
            headers: auth(token),
          },
        );
        expect(read.status).toBe(200);
        await expect(read.json()).resolves.toMatchObject({
          snapshot: {
            id: receipt.jobId,
            kind: "shell",
            ownerSession: "s-task",
          },
        });
      },
      {
        projectInitService: {
          async init() {
            return { report: "INIT OK" };
          },
        },
        pluginService: {
          async list() {
            return {
              plugins: [
                {
                  identity: { id: "demo", name: "demo", version: "1.0.0" },
                  origin: "native",
                  scope: "user",
                  enabled: true,
                  installation: "installed",
                  activation: "active",
                  runtimeStatus: {
                    state: "loaded",
                    message: "插件已加载。",
                    action: "none",
                  },
                  inventory: { skills: 1 },
                  permissions: { requested: [], approved: [], missing: [] },
                  diagnostics: [],
                },
              ],
              warnings: [],
            };
          },
          async setEnabled({ id, enabled }) {
            return {
              message: `${enabled ? "Enabled" : "Disabled"} plugin '${id}'.`,
            };
          },
        },
        agentPersonaService: {
          async list() {
            return {
              agents: [
                { name: "Explore", description: "search", source: "builtin" },
              ],
            };
          },
        },
        hooksService: {
          async list() {
            return {
              hooks: [
                {
                  id: "h1",
                  event: "stop",
                  type: "command",
                  enabled: true,
                  origin: "settings" as const,
                },
              ],
            };
          },
        },
        gitService: {
          async diff() {
            return { output: "a.txt | 1 +\n" };
          },
          async branch() {
            return { output: "* main\n" };
          },
          async status() {
            return { output: " M a.txt\n" };
          },
          async commit({ message }) {
            return { output: `[main abc] ${message}` };
          },
        },
      },
    );

    await withServer(
      async ({ baseUrl, token }) => {
        const status = await fetch(
          `${baseUrl}/git/status?cwd=${encodeURIComponent(process.cwd())}`,
          { headers: auth(token) },
        );
        expect(status.status).toBe(200);
        expect(await status.json()).toEqual({ output: " M a.txt\n" });

        const commit = await fetch(`${baseUrl}/git/commit`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ cwd: process.cwd(), message: "fix auth" }),
        });
        expect(commit.status).toBe(200);
        expect(await commit.json()).toEqual({ output: "[main abc] fix auth" });

        const reload = await fetch(`${baseUrl}/plugins/reload`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ cwd: process.cwd() }),
        });
        expect(reload.status).toBe(200);
        const reloadBody = (await reload.json()) as {
          message: string;
          plugins: unknown[];
        };
        expect(reloadBody.message).toContain("rediscovered");
        expect(reloadBody.plugins).toHaveLength(1);
      },
      {
        pluginService: {
          async list() {
            return {
              plugins: [
                {
                  name: "demo",
                  version: "1.0.0",
                  enabled: true,
                  skillCount: 1,
                  commandCount: 0,
                  hookCount: 0,
                  agentCount: 0,
                },
              ],
              warnings: [],
            };
          },
          async setEnabled() {
            return { message: "ok" };
          },
        },
        gitService: {
          async diff() {
            return { output: "" };
          },
          async branch() {
            return { output: "" };
          },
          async status() {
            return { output: " M a.txt\n" };
          },
          async commit({ message }) {
            return { output: `[main abc] ${message}` };
          },
        },
      },
    );
  });

  it("compensates a real background shell when post-create Job normalization fails", async () => {
    await withServer(async ({ baseUrl, token, server }) => {
      const sessionId = "s-background-normalization";
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: sessionId, cwd: process.cwd(), model: "m" }),
      });
      const internals = server as unknown as {
        jobs: { read: (...args: unknown[]) => Promise<unknown> };
        application: {
          backgroundShells: {
            stop(
              taskId: string,
              input: { sessionId: string },
            ): Promise<unknown>;
          };
        };
      };
      internals.jobs.read = vi.fn(async () => {
        throw new Error("normalization unavailable");
      });

      try {
        const response = await fetch(`${baseUrl}/background-shells`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            sessionId,
            command: `${process.execPath} -e "setInterval(() => {}, 1000)"`,
          }),
        });

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({
          error: "normalization unavailable",
        });
        const [task] = server.store.listSessionTasks(sessionId);
        expect(task).toBeDefined();
        expect(task?.status).not.toBe("running");
      } finally {
        const [task] = server.store.listSessionTasks(sessionId);
        if (task)
          await internals.application.backgroundShells
            .stop(task.id, { sessionId })
            .catch(() => {});
      }
    });
  });

  it("rewinds a session transcript via store replace", async () => {
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt() {
            return { messages: [] };
          },
          async close() {},
          async compact() {
            return {
              messageCount: 2,
              transcript: [
                {
                  role: "user",
                  parts: [{ type: "text", status: "completed", text: "hello" }],
                },
                {
                  role: "assistant",
                  parts: [{ type: "text", status: "completed", text: "hi" }],
                },
              ],
            };
          },
        };
      },
    };

    await withServer(
      async ({ baseUrl, token }) => {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
        });
        const empty = await fetch(`${baseUrl}/sessions/s1/rewind`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ count: 1 }),
        });
        expect(empty.status).toBe(400);

        await new Promise((resolve) => setTimeout(resolve, 20));
        await fetch(`${baseUrl}/sessions/s1/compact`, {
          method: "POST",
          headers: auth(token),
        });
        const response = await fetch(`${baseUrl}/sessions/s1/rewind`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ count: 1 }),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          turns: number;
          removed: number;
          messages: unknown[];
        };
        expect(body.turns).toBe(1);
        expect(body.removed).toBe(3);
        expect(body.messages).toHaveLength(0);
        const events = (await (
          await fetch(`${baseUrl}/events`, { headers: auth(token) })
        ).json()) as {
          events: Array<{ type: string }>;
        };
        expect(
          events.events
            .map((event) => event.type)
            .filter((type) => type === "session.transcript.replaced").length,
        ).toBeGreaterThanOrEqual(2);
      },
      { runtimeFactory },
    );
  });

  it("starts dream and manages profile via resource APIs", async () => {
    await withServer(
      async ({ baseUrl, token }) => {
        const dream = await fetch(`${baseUrl}/dream`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ cwd: process.cwd(), preview: true }),
        });
        expect(dream.status).toBe(201);
        expect(await dream.json()).toEqual({ taskId: "dream_1" });

        const status = await fetch(`${baseUrl}/profile`, {
          headers: auth(token),
        });
        expect(status.status).toBe(200);
        expect(await status.json()).toEqual({ report: "PROFILE STATUS" });

        const init = await fetch(`${baseUrl}/profile/init`, {
          method: "POST",
          headers: auth(token),
        });
        expect(init.status).toBe(200);
        expect(await init.json()).toEqual({ report: "PROFILE INIT" });
      },
      {
        dreamService: {
          async start() {
            return { started: true, taskId: "dream_1" };
          },
        },
        profileService: {
          async status() {
            return { report: "PROFILE STATUS" };
          },
          async init() {
            return { report: "PROFILE INIT" };
          },
        },
      },
    );
  });

  it("creates sessions, admits prompts, and replays events by cursor", async () => {
    await withServer(async ({ baseUrl, token }) => {
      const created = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({
          id: "s1",
          cwd: process.cwd(),
          model: "m",
          title: "Main",
        }),
      });
      expect(created.status).toBe(201);

      const firstEvents = (await (
        await fetch(`${baseUrl}/events`, { headers: auth(token) })
      ).json()) as {
        events: Array<{ seq: number; type: string; schemaVersion: number }>;
      };
      expect(firstEvents.events.map((event) => event.type)).toEqual([
        "session.created",
      ]);
      expect(firstEvents.events.map((event) => event.schemaVersion)).toEqual([
        1,
      ]);
      const cursor = firstEvents.events[0]!.seq;

      const prompt = await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "hello", delivery: "queue" }),
      });
      expect(prompt.status).toBe(202);

      const sessions = (await (
        await fetch(`${baseUrl}/sessions`, { headers: auth(token) })
      ).json()) as {
        sessions: Array<{ id: string }>;
      };
      expect(sessions.sessions.map((session) => session.id)).toEqual(["s1"]);

      const nextEvents = (await (
        await fetch(`${baseUrl}/events?cursor=${cursor}`, {
          headers: auth(token),
        })
      ).json()) as {
        events: Array<{ type: string; schemaVersion: number }>;
      };
      expect(nextEvents.events.map((event) => event.type)).toEqual([
        "session.input.admitted",
      ]);
      expect(nextEvents.events.map((event) => event.schemaVersion)).toEqual([
        2,
      ]);

      const snapshot = (await (
        await fetch(`${baseUrl}/sessions/s1/state`, { headers: auth(token) })
      ).json()) as {
        cursor: number;
        inputs: Array<{ content: string }>;
        messages: unknown[];
        parts: unknown[];
      };
      expect(snapshot.cursor).toBeGreaterThan(cursor);
      expect(snapshot.inputs.map((input) => input.content)).toEqual(["hello"]);
      expect(snapshot.messages).toEqual([]);
      expect(snapshot.parts).toEqual([]);
    });
  });

  it("archives sessions via DELETE and hides them from the default list", async () => {
    await withServer(async ({ baseUrl, token }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({
          id: "s1",
          cwd: process.cwd(),
          model: "m",
          title: "Main",
        }),
      });

      const archived = await fetch(`${baseUrl}/sessions/s1`, {
        method: "DELETE",
        headers: auth(token),
      });
      expect(archived.status).toBe(200);
      expect(
        ((await archived.json()) as { session: { status: string } }).session
          .status,
      ).toBe("archived");

      const listed = (await (
        await fetch(`${baseUrl}/sessions`, { headers: auth(token) })
      ).json()) as {
        sessions: Array<{ id: string }>;
      };
      expect(listed.sessions).toEqual([]);

      const events = (await (
        await fetch(`${baseUrl}/events`, { headers: auth(token) })
      ).json()) as {
        events: Array<{ type: string }>;
      };
      expect(events.events.map((event) => event.type)).toContain(
        "session.archived",
      );
    });
  });

  it("hides child sessions from the default session list", async () => {
    await withServer(async ({ baseUrl, token }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({
          id: "parent",
          cwd: process.cwd(),
          model: "m",
          title: "Parent",
        }),
      });
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({
          id: "child",
          parentId: "parent",
          cwd: process.cwd(),
          model: "m",
          title: "Child",
        }),
      });

      const listed = (await (
        await fetch(`${baseUrl}/sessions`, { headers: auth(token) })
      ).json()) as {
        sessions: Array<{ id: string }>;
      };
      expect(listed.sessions.map((session) => session.id)).toEqual(["parent"]);

      const withChildren = (await (
        await fetch(`${baseUrl}/sessions?includeChildren=true`, {
          headers: auth(token),
        })
      ).json()) as {
        sessions: Array<{ id: string }>;
      };
      expect(withChildren.sessions.map((session) => session.id).sort()).toEqual(
        ["child", "parent"],
      );
    });
  });

  it("archives descendants after interrupting runs and closing runtimes", async () => {
    let serverRef: VykorHttpServer | undefined;
    const lifecycle: string[] = [];
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime(context) {
        return {
          async runPrompt(input) {
            await new Promise<void>((resolve) => {
              input.signal.addEventListener(
                "abort",
                () => {
                  lifecycle.push(`interrupt:${input.session.id}`);
                  resolve();
                },
                { once: true },
              );
            });
            throw new Error("interrupted by archive");
          },
          async close() {
            lifecycle.push(
              `close:${context.session.id}:${serverRef?.store.sessions.get(context.session.id)?.status}`,
            );
          },
        };
      },
    };

    await withServer(
      async ({ baseUrl, token, server }) => {
        serverRef = server;
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            id: "parent",
            cwd: process.cwd(),
            model: "m",
          }),
        });

        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            id: "child",
            parentId: "parent",
            cwd: process.cwd(),
            model: "m",
            title: "child",
            agent: "Explore",
          }),
        });
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            id: "grandchild",
            parentId: "child",
            cwd: process.cwd(),
            model: "m",
            title: "grandchild",
            agent: "Explore",
          }),
        });
        await fetch(`${baseUrl}/sessions/child/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "run child" }),
        });
        await fetch(`${baseUrl}/sessions/grandchild/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "run grandchild" }),
        });
        for (let i = 0; i < 50; i++) {
          const running = ["child", "grandchild"].every((id) =>
            server.store.runs.listRuns(id).some((run) => run.status === "running"),
          );
          if (running) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const archived = await fetch(`${baseUrl}/sessions/parent`, {
          method: "DELETE",
          headers: auth(token),
        });

        expect(archived.status).toBe(200);
        expect(server.store.sessions.get("parent")?.status).toBe("archived");
        expect(server.store.sessions.get("child")?.status).toBe("archived");
        expect(server.store.sessions.get("grandchild")?.status).toBe("archived");
        for (const id of ["child", "grandchild"]) {
          const interruptIndex = lifecycle.indexOf(`interrupt:${id}`);
          const closeIndex = lifecycle.findIndex((event) =>
            event.startsWith(`close:${id}:`),
          );
          expect(interruptIndex).toBeGreaterThanOrEqual(0);
          expect(interruptIndex).toBeLessThan(closeIndex);
          expect(lifecycle[closeIndex]).not.toBe(`close:${id}:archived`);
        }
        expect(
          lifecycle.find((event) => event.startsWith("close:parent:")),
        ).not.toBe("close:parent:archived");
      },
      { runtimeFactory },
    );
  });

  it("makes archive terminal before waiting for an interrupted run to settle", async () => {
    const abortObserved = deferred();
    const releaseRun = deferred();
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt(input) {
            await new Promise<void>((resolve) => {
              input.signal.addEventListener(
                "abort",
                () => {
                  abortObserved.resolve();
                  void releaseRun.promise.then(resolve);
                },
                { once: true },
              );
            });
            throw new Error("interrupted by archive");
          },
          async close() {},
        };
      },
    };

    await withServer(
      async ({ baseUrl, token, server }) => {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
        });
        await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "active" }),
        });
        await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "running",
        );

        const archive = fetch(`${baseUrl}/sessions/s1`, {
          method: "DELETE",
          headers: auth(token),
        });
        await abortObserved.promise;
        expect(server.store.sessions.get("s1")?.status).toBe("closing");

        const rejected = await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "must not run" }),
        });
        expect(rejected.status).toBe(409);

        releaseRun.resolve();
        expect((await archive).status).toBe(200);
        expect(server.store.sessions.get("s1")?.status).toBe("archived");
        expect(
          server.store.conversations.listInputs("s1").map((input) => input.content),
        ).toEqual(["active"]);
      },
      { runtimeFactory },
    );
  });

  it("returns the original admission for an idempotent prompt retry", async () => {
    await withServer(async ({ baseUrl, token, server }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
      });
      const request = {
        id: "prompt-request-1",
        content: "do the thing",
        metadata: { source: "tui", labels: ["retry"] },
      };
      const first = await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const second = await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const firstBody = (await first.json()) as { input: { id: string } };
      const secondBody = (await second.json()) as { input: { id: string } };
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(secondBody.input.id).toBe(firstBody.input.id);
      expect(server.store.conversations.listInputs("s1")).toHaveLength(1);

      const conflict = await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ ...request, content: "a different operation" }),
      });
      expect(conflict.status).toBe(409);
      expect(server.store.conversations.listInputs("s1")).toHaveLength(1);
    });
  });

  it("keeps a session running while only queued work is interrupted", async () => {
    const abortObserved = deferred();
    const releaseRun = deferred();
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt(input) {
            await new Promise<void>((resolve) => {
              input.signal.addEventListener(
                "abort",
                () => {
                  abortObserved.resolve();
                  void releaseRun.promise.then(resolve);
                },
                { once: true },
              );
            });
            throw new Error("interrupted by test");
          },
          async close() {},
        };
      },
    };

    await withServer(
      async ({ baseUrl, token, server }) => {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
        });
        for (const content of ["active", "queued"]) {
          await fetch(`${baseUrl}/sessions/s1/prompts`, {
            method: "POST",
            headers: { ...auth(token), "content-type": "application/json" },
            body: JSON.stringify({ content }),
          });
        }
        await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "running",
        );

        await fetch(`${baseUrl}/sessions/s1/interrupt`, {
          method: "POST",
          headers: auth(token),
        });
        await abortObserved.promise;
        expect(server.store.sessions.get("s1")?.status).toBe("running");

        releaseRun.resolve();
        for (
          let i = 0;
          i < 50 && server.store.sessions.get("s1")?.status !== "idle";
          i++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(server.store.sessions.get("s1")?.status).toBe("idle");
      },
      { runtimeFactory },
    );
  });

  it("rejects runtime metadata changes while a run is active", async () => {
    const started = deferred();
    const closed: string[] = [];
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime(context) {
        return {
          async runPrompt(input) {
            started.resolve();
            await new Promise<void>((_resolve, reject) => {
              const interrupt = () =>
                reject(
                  new Error(String(input.signal.reason ?? "Run interrupted")),
                );
              if (input.signal.aborted) interrupt();
              else
                input.signal.addEventListener("abort", interrupt, {
                  once: true,
                });
            });
            return { messages: [] };
          },
          async close() {
            closed.push(context.session.id);
          },
        };
      },
    };

    await withServer(
      async ({ baseUrl, token, server }) => {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            id: "s1",
            cwd: process.cwd(),
            model: "m",
            metadata: { runtime: { model: "m", permissionMode: "default" } },
          }),
        });
        await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "active" }),
        });
        await started.promise;

        const patched = await fetch(`${baseUrl}/sessions/s1`, {
          method: "PATCH",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            metadata: { runtime: { permissionMode: "plan" } },
          }),
        });
        expect(patched.status).toBe(409);
        expect(
          (
            server.store.sessions.get("s1")?.metadata.runtime as
              Record<string, unknown> | undefined
          )?.permissionMode,
        ).toBe("default");
        expect(closed).toEqual([]);
      },
      { runtimeFactory },
    );
  });

  it("rejects runtime-restarting resource mutations before they write state", async () => {
    const started = deferred();
    const stopped = deferred();
    const closed: string[] = [];
    let memoryWrites = 0;
    let authWrites = 0;
    let pluginWrites = 0;
    let profileWrites = 0;
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime(context) {
        return {
          async runPrompt(input) {
            started.resolve();
            await new Promise<void>((resolve) => {
              input.signal.addEventListener("abort", resolve, { once: true });
            });
            stopped.resolve();
            throw input.signal.reason;
          },
          async close() {
            closed.push(context.session.id);
          },
          async remember() {
            return { skipped: false, writtenIds: [], titles: [] };
          },
        };
      },
    };

    await withServer(
      async ({ baseUrl, token }) => {
        const cwd = process.cwd();
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ id: "s1", cwd, model: "m" }),
        });
        await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "active" }),
        });
        await started.promise;

        const requests = await Promise.all([
          fetch(`${baseUrl}/memory`, {
            method: "POST",
            headers: { ...auth(token), "content-type": "application/json" },
            body: JSON.stringify({ cwd, content: "do not persist" }),
          }),
          fetch(`${baseUrl}/auth/login`, {
            method: "POST",
            headers: { ...auth(token), "content-type": "application/json" },
            body: JSON.stringify({ provider: "openai", apiKey: "sk-test" }),
          }),
          fetch(`${baseUrl}/profile/init`, {
            method: "POST",
            headers: auth(token),
          }),
          fetch(`${baseUrl}/plugins/demo/enable`, {
            method: "POST",
            headers: { ...auth(token), "content-type": "application/json" },
            body: JSON.stringify({ cwd }),
          }),
          fetch(`${baseUrl}/plugins/reload`, {
            method: "POST",
            headers: { ...auth(token), "content-type": "application/json" },
            body: JSON.stringify({ cwd }),
          }),
          fetch(`${baseUrl}/sessions/s1/remember`, {
            method: "POST",
            headers: auth(token),
          }),
        ]);

        expect(requests.map((response) => response.status)).toEqual([
          409, 409, 409, 409, 409, 409,
        ]);
        expect({
          memoryWrites,
          authWrites,
          pluginWrites,
          profileWrites,
          closed,
        }).toEqual({
          memoryWrites: 0,
          authWrites: 0,
          pluginWrites: 0,
          profileWrites: 0,
          closed: [],
        });

        await fetch(`${baseUrl}/sessions/s1/interrupt`, {
          method: "POST",
          headers: auth(token),
        });
        await stopped.promise;
      },
      {
        runtimeFactory,
        memoryService: {
          async list() {
            return { directory: "/tmp/memory", entries: [] };
          },
          async get() {
            return null;
          },
          async add() {
            memoryWrites++;
            return {
              id: "m1",
              content: "unexpected",
              createdAt: 1,
              updatedAt: 1,
            };
          },
          async remove() {
            return false;
          },
        },
        authService: {
          async status() {
            return {
              codex: { configured: false, state: "none", source: "none" },
              storedProviders: [],
              envProviders: [],
            };
          },
          async login() {
            authWrites++;
            return { message: "unexpected" };
          },
          async logout() {
            authWrites++;
            return { message: "unexpected" };
          },
        },
        profileService: {
          async status() {
            return { report: "unused" };
          },
          async init() {
            profileWrites++;
            return { report: "unexpected" };
          },
        },
        pluginService: {
          async list() {
            return { plugins: [], warnings: [] };
          },
          async setEnabled() {
            pluginWrites++;
            return { message: "unexpected", restartRuntimes: true };
          },
        },
      },
    );
  });

  it("streams replayed and live events over SSE", async () => {
    await withServer(async ({ baseUrl, token }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
      });

      const abort = new AbortController();
      const stream = await fetch(`${baseUrl}/events/stream?cursor=0`, {
        headers: auth(token),
        signal: abort.signal,
      });
      expect(stream.status).toBe(200);
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";

      await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "wake" }),
      });

      for (let i = 0; i < 20 && !text.includes("session.input.admitted"); i++) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      abort.abort();

      expect(text).toContain("session.created");
      expect(text).toContain("session.input.admitted");
    });
  });

  it("runs channel messages through durable sessions and keeps delivery separate", async () => {
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt(input, run) {
            await run.emit({
              type: "output.text.delta",
              data: { delta: `reply: ${input.input.content}` },
            });
          },
          async close() {},
        };
      },
    };
    await withServer(
      async ({ baseUrl, token }) => {
        const request = {
          connector: "feishu",
          accountId: "app-1",
          chatId: "chat-1",
          externalMessageId: "message-1",
          senderId: "user-1",
          content: "hello",
          cwd: process.cwd(),
          model: "m",
        };
        const send = async (body = request) => {
          const response = await fetch(`${baseUrl}/channels/messages`, {
            method: "POST",
            headers: { ...auth(token), "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          return { response, body: (await response.json()) as any };
        };

        const first = await send();
        const duplicate = await send();
        const other = await send({
          ...request,
          chatId: "chat-2",
          externalMessageId: "message-2",
        });
        expect(first.response.status).toBe(202);
        expect(first.body.delivery.content).toBe("reply: hello");
        expect(duplicate.body.duplicate).toBe(true);
        expect(duplicate.body.delivery.runId).toBe(first.body.delivery.runId);
        expect(other.body.conversation.sessionId).not.toBe(
          first.body.conversation.sessionId,
        );

        const recorded = await fetch(
          `${baseUrl}/channels/deliveries/${first.body.delivery.id}/result`,
          {
            method: "POST",
            headers: { ...auth(token), "content-type": "application/json" },
            body: JSON.stringify({ status: "sent" }),
          },
        );
        expect(recorded.status).toBe(200);
        expect(((await recorded.json()) as any).delivery.status).toBe("sent");
      },
      { runtimeFactory },
    );
  });

  it("replays a filtered SSE stream from Last-Event-ID", async () => {
    await withServer(async ({ baseUrl, token }) => {
      for (const id of ["s1", "s2"]) {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ id, cwd: process.cwd(), model: "m" }),
        });
      }
      await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "replay me" }),
      });

      const abort = new AbortController();
      const stream = await fetch(`${baseUrl}/events/stream?sessionId=s1`, {
        headers: { ...auth(token), "last-event-id": "1" },
        signal: abort.signal,
      });
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (let i = 0; i < 10 && !text.includes("session.input.admitted"); i++) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      await reader.cancel();
      abort.abort();

      expect(text).toContain("session.input.admitted");
      expect(text).toContain("id: 3\nevent: session.input.admitted");
      expect(text).not.toContain("id: 1\nevent:");
      expect(text).not.toContain('"sessionId":"s2"');
    });
  });

  it("runs admitted prompts through an injected framework agent", async () => {
    const closed: string[] = [];
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime({ session }) {
        return {
          async runPrompt(input, run) {
            expect(input.session.id).toBe(session.id);
            expect(input.input.content).toBe("hello runtime");
            expect(input.history).toEqual([]);
            expect(input.parts).toEqual([]);
            await run.emit({
              type: "output.text.delta",
              data: { delta: "hello" },
            });
            return {
              messages: [],
            };
          },
          async close() {
            closed.push(session.id);
          },
        };
      },
    };

    await withServer(
      async ({ baseUrl, token }) => {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
        });

        const liveAbort = new AbortController();
        const liveStream = await fetch(
          `${baseUrl}/events/stream?sessionId=s1`,
          {
            headers: auth(token),
            signal: liveAbort.signal,
          },
        );
        const liveReader = liveStream.body!.getReader();
        const liveDecoder = new TextDecoder();

        const prompt = await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "hello runtime" }),
        });
        expect(prompt.status).toBe(202);
        const body = (await prompt.json()) as { run?: { status: string } };
        expect(body.run?.status).toBe("pending");

        const events = await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "completed",
        );
        expect(events.map((event) => event.type)).not.toContain(
          "session.message.part.delta",
        );

        let liveText = "";
        for (
          let i = 0;
          i < 30 && !liveText.includes("session.message.part.delta");
          i++
        ) {
          const chunk = await liveReader.read();
          if (chunk.done) break;
          liveText += liveDecoder.decode(chunk.value, { stream: true });
        }
        await liveReader.cancel();
        liveAbort.abort();
        expect(liveText).toContain("event: session.message.part.delta");
        expect(liveText).toContain('"delta":"hello"');

        const messages = (await (
          await fetch(`${baseUrl}/sessions/s1/messages`, {
            headers: auth(token),
          })
        ).json()) as {
          messages: Array<{ role: string; inputId?: string }>;
        };
        const parts = (await (
          await fetch(`${baseUrl}/sessions/s1/parts`, { headers: auth(token) })
        ).json()) as {
          parts: Array<{ type: string; text?: string; status: string }>;
        };
        expect(messages.messages.map((message) => message.role)).toEqual([
          "user",
          "assistant",
        ]);
        expect(messages.messages[0]).toMatchObject({
          inputId: expect.any(String),
        });
        expect(parts.parts.map((part) => [part.type, part.text])).toEqual([
          ["text", "hello runtime"],
          ["text", "hello"],
        ]);
        expect(closed).toEqual([]);
      },
      { runtimeFactory },
    );
    expect(closed).toEqual(["s1"]);
  });

  it("persists each model turn as a separate assistant message", async () => {
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt(_input, run) {
            await run.emit({
              type: "output.text.delta",
              data: { delta: "checking" },
            });
            await run.emit({
              type: "tool.started",
              data: {
                toolUse: {
                  type: "tool_use",
                  id: "tool-1",
                  name: "Read",
                  input: { path: "README.md" },
                },
              },
            });
            await run.emit({
              type: "output.turn.completed",
              data: { stopReason: "tool_use" },
            });
            await run.emit({
              type: "tool.completed",
              data: {
                toolUseId: "tool-1",
                result: { content: [{ type: "text", text: "file contents" }] },
              },
            });
            await run.emit({
              type: "output.text.delta",
              data: { delta: "finished" },
            });
            await run.emit({
              type: "output.turn.completed",
              data: { stopReason: "end_turn" },
            });
            return { messages: [] };
          },
          async close() {},
        };
      },
    };

    await withServer(
      async ({ baseUrl, token }) => {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
        });
        await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "inspect" }),
        });
        await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "completed",
        );

        const messages = (await (
          await fetch(`${baseUrl}/sessions/s1/messages`, {
            headers: auth(token),
          })
        ).json()) as {
          messages: Array<{ id: string; role: string }>;
        };
        const parts = (await (
          await fetch(`${baseUrl}/sessions/s1/parts`, { headers: auth(token) })
        ).json()) as {
          parts: Array<{
            messageId: string;
            type: string;
            text?: string;
            toolName?: string;
          }>;
        };
        expect(messages.messages.map((message) => message.role)).toEqual([
          "user",
          "assistant",
          "assistant",
        ]);
        const assistantIds = messages.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.id);
        expect(assistantIds[0]).not.toBe(assistantIds[1]);
        expect(parts.parts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              messageId: assistantIds[0],
              type: "tool",
              toolName: "Read",
            }),
            expect.objectContaining({
              messageId: assistantIds[1],
              type: "text",
              text: "finished",
            }),
          ]),
        );
      },
      { runtimeFactory },
    );
  });

  it("queues prompts for the same session and persists messages in run order", async () => {
    const releaseFirst = deferred();
    const started: string[] = [];
    let created = 0;
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        created += 1;
        return {
          async runPrompt(input) {
            started.push(input.input.content);
            if (input.input.content === "first") await releaseFirst.promise;
            return { messages: [] };
          },
          async close() {},
        };
      },
    };

    await withServer(
      async ({ baseUrl, token }) => {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
        });

        const first = await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "first" }),
        });
        expect(
          ((await first.json()) as { queue_state?: string }).queue_state,
        ).toBe("running");

        await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "running",
        );

        const second = await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "second" }),
        });
        expect(
          ((await second.json()) as { queue_state?: string }).queue_state,
        ).toBe("queued");
        expect(started).toEqual(["first"]);

        releaseFirst.resolve();
        await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "completed" &&
            started.includes("second"),
        );

        const messages = (await (
          await fetch(`${baseUrl}/sessions/s1/messages`, {
            headers: auth(token),
          })
        ).json()) as {
          messages: Array<{ role: string }>;
        };
        const parts = (await (
          await fetch(`${baseUrl}/sessions/s1/parts`, { headers: auth(token) })
        ).json()) as {
          parts: Array<{ text?: string }>;
        };
        expect(messages.messages.map((message) => message.role)).toEqual([
          "user",
          "user",
        ]);
        expect(parts.parts.map((part) => part.text)).toEqual([
          "first",
          "second",
        ]);
        expect(created).toBe(1);
      },
      { runtimeFactory },
    );
  });

  it("keeps permission requests alive after an event client disconnects and accepts a later reply", async () => {
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt(input, run) {
            const decision = await run.requestPermission({
              toolName: "Write",
              reason: "needs edit",
              input: { path: "README.md" },
            });
            await run.emit({
              type: "output.text.delta",
              data: {
                delta:
                  decision.status === "approved"
                    ? "permission granted"
                    : "permission denied",
              },
            });
            return { messages: [] };
          },
          async close() {},
        };
      },
    };

    await withServer(
      async ({ baseUrl, token }) => {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
        });

        const abort = new AbortController();
        const stream = await fetch(`${baseUrl}/events/stream?sessionId=s1`, {
          headers: auth(token),
          signal: abort.signal,
        });
        expect(stream.status).toBe(200);
        const reader = stream.body!.getReader();
        const decoder = new TextDecoder();

        const prompt = await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "please edit" }),
        });
        expect(prompt.status).toBe(202);

        let streamText = "";
        for (
          let i = 0;
          i < 50 && !streamText.includes("permission.asked");
          i++
        ) {
          const chunk = await reader.read();
          if (chunk.done) break;
          streamText += decoder.decode(chunk.value, { stream: true });
        }
        expect(streamText).toContain("permission.asked");
        await reader.cancel();
        abort.abort();

        const pending = (await (
          await fetch(`${baseUrl}/permissions?sessionId=s1&status=pending`, {
            headers: auth(token),
          })
        ).json()) as {
          requests: Array<{ id: string; status: string; toolName: string }>;
        };
        expect(pending.requests).toMatchObject([
          { status: "pending", toolName: "Write" },
        ]);

        const replied = await fetch(
          `${baseUrl}/permissions/${pending.requests[0]!.id}/reply`,
          {
            method: "POST",
            headers: { ...auth(token), "content-type": "application/json" },
            body: JSON.stringify({
              status: "approved",
              decision: "session",
              clientId: "web-2",
            }),
          },
        );
        expect(replied.status).toBe(200);

        await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "completed",
        );

        const messages = (await (
          await fetch(`${baseUrl}/sessions/s1/messages`, {
            headers: auth(token),
          })
        ).json()) as {
          messages: Array<{ role: string }>;
        };
        const parts = (await (
          await fetch(`${baseUrl}/sessions/s1/parts`, { headers: auth(token) })
        ).json()) as {
          parts: Array<{ text?: string }>;
        };
        expect(messages.messages.map((message) => message.role)).toEqual([
          "user",
          "assistant",
        ]);
        expect(parts.parts.map((part) => part.text)).toEqual([
          "please edit",
          "permission granted",
        ]);
      },
      { runtimeFactory },
    );
  });

  it("interrupts active and queued session runs", async () => {
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt(input) {
            await new Promise<void>((resolve) => {
              input.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            throw new Error("interrupted by test");
          },
          async close() {},
        };
      },
    };

    await withServer(
      async ({ baseUrl, token }) => {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
        });
        await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "active" }),
        });
        await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "running",
        );
        await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "queued" }),
        });

        const interrupted = await fetch(`${baseUrl}/sessions/s1/interrupt`, {
          method: "POST",
          headers: auth(token),
        });
        expect(await interrupted.json()).toMatchObject({
          activeRunId: expect.any(String),
          queuedRunIds: [expect.any(String)],
          interrupted: true,
        });

        const events = await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "interrupted",
        );
        expect(events.map((event) => event.type)).toContain(
          "session.run.interrupt_requested",
        );
      },
      { runtimeFactory },
    );
  });

  it("steers into an active run without creating a second run", async () => {
    const release = deferred();
    let observedSteerCount = 0;
    let drained: Array<{ content: string; delivery: string }> = [];
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt(input) {
            drained = [await input.waitForSteer()];
            observedSteerCount = drained.length;
            await release.promise;
          },
          async close() {},
        };
      },
    };

    await withServer(
      async ({ baseUrl, token }) => {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
        });

        const first = await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "active" }),
        });
        const firstBody = (await first.json()) as {
          run: { id: string };
          queue_state: string;
        };
        expect(first.status).toBe(202);
        expect(firstBody.queue_state).toBe("running");

        await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "running",
        );

        const steered = await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            content: "course correct",
            delivery: "steer",
          }),
        });
        const steeredBody = (await steered.json()) as {
          input: { content: string; delivery: string };
          run?: { id: string };
          queue_state?: string;
        };
        expect(steered.status).toBe(202);
        expect(steeredBody.input).toMatchObject({
          content: "course correct",
          delivery: "steer",
        });
        expect(steeredBody.run?.id).toBe(firstBody.run.id);
        expect(steeredBody.queue_state).toBe("running");

        const state = (await (
          await fetch(`${baseUrl}/sessions/s1/state`, { headers: auth(token) })
        ).json()) as {
          runs: Array<{ id: string }>;
          inputs: Array<{ content: string; delivery: string }>;
        };
        expect(state.runs).toHaveLength(1);
        expect(
          state.inputs.map((input) => [input.content, input.delivery]),
        ).toEqual([
          ["active", "queue"],
          ["course correct", "steer"],
        ]);

        for (let i = 0; i < 50 && observedSteerCount === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(observedSteerCount).toBeGreaterThan(0);
        expect(drained.map((input) => input.content)).toEqual([
          "course correct",
        ]);

        release.resolve();
        await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "completed",
        );
      },
      { runtimeFactory },
    );
  });

  it("promotes a durable queued prompt into the active run without executing it twice", async () => {
    const release = deferred();
    let executionCount = 0;
    let steeredContent = "";
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt(input) {
            executionCount += 1;
            steeredContent = (await input.waitForSteer()).content;
            await release.promise;
          },
          async close() {},
        };
      },
    };

    await withServer(
      async ({ baseUrl, token }) => {
        const headers = { ...auth(token), "content-type": "application/json" };
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
        });
        const active = (await (
          await fetch(`${baseUrl}/sessions/s1/prompts`, {
            method: "POST",
            headers,
            body: JSON.stringify({ content: "active" }),
          })
        ).json()) as { run: { id: string } };
        await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (event.payload?.run as { id?: string; status?: string } | undefined)
              ?.id === active.run.id &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "running",
        );
        const queued = (await (
          await fetch(`${baseUrl}/sessions/s1/prompts`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id: "queued-input", content: "adjust now" }),
          })
        ).json()) as { input: { id: string }; run: { id: string } };

        const response = await fetch(
          `${baseUrl}/sessions/s1/prompts/${queued.input.id}/promote`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              queuedRunId: queued.run.id,
              expectedActiveRunId: active.run.id,
            }),
          },
        );
        const promoted = (await response.json()) as {
          queued_run: {
            id: string;
            status: string;
            metadata: Record<string, unknown>;
          };
          active_run: { id: string };
        };
        expect(response.status).toBe(200);
        expect(promoted).toMatchObject({
          queued_run: {
            id: queued.run.id,
            status: "interrupted",
            metadata: {
              promotion: { kind: "steered", activeRunId: active.run.id },
            },
          },
          active_run: { id: active.run.id },
        });
        expect(steeredContent).toBe("adjust now");
        expect(executionCount).toBe(1);

        release.resolve();
        await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (event.payload?.run as { id?: string; status?: string } | undefined)
              ?.id === active.run.id &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "completed",
        );
        expect(executionCount).toBe(1);
      },
      { runtimeFactory },
    );
  });

  it("falls back to creating a run when steer arrives while idle", async () => {
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt() {},
          async close() {},
        };
      },
    };

    await withServer(
      async ({ baseUrl, token }) => {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
        });

        const steered = await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({
            content: "start via steer",
            delivery: "steer",
          }),
        });
        const body = (await steered.json()) as {
          run: { id: string };
          queue_state: string;
          input: { delivery: string };
        };
        expect(steered.status).toBe(202);
        expect(body.input.delivery).toBe("steer");
        expect(body.run.id).toEqual(expect.any(String));
        expect(body.queue_state).toBe("running");

        await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "completed",
        );

        const state = (await (
          await fetch(`${baseUrl}/sessions/s1/state`, { headers: auth(token) })
        ).json()) as {
          runs: Array<{ id: string }>;
        };
        expect(state.runs).toHaveLength(1);
      },
      { runtimeFactory },
    );
  });

  it("keeps queue delivery enqueue semantics while a run is active", async () => {
    const release = deferred();
    const runtimeFactory: TestAgentProgramFactory = {
      async createRuntime() {
        return {
          async runPrompt(input) {
            await new Promise<void>((resolve) => {
              const finish = () => resolve();
              input.signal.addEventListener("abort", finish, { once: true });
              void release.promise.then(finish);
            });
          },
          async close() {},
        };
      },
    };

    await withServer(
      async ({ baseUrl, token }) => {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
        });

        const first = await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "active" }),
        });
        const firstBody = (await first.json()) as { run: { id: string } };

        await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "running",
        );

        const queued = await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content: "next", delivery: "queue" }),
        });
        const queuedBody = (await queued.json()) as {
          run: { id: string };
          queue_state: string;
        };
        expect(queued.status).toBe(202);
        expect(queuedBody.run.id).not.toBe(firstBody.run.id);
        expect(queuedBody.queue_state).toBe("queued");

        const state = (await (
          await fetch(`${baseUrl}/sessions/s1/state`, { headers: auth(token) })
        ).json()) as {
          runs: Array<{ id: string }>;
        };
        expect(state.runs).toHaveLength(2);

        release.resolve();
        await waitForEvent(
          baseUrl,
          token,
          (event) =>
            event.type === "session.run.updated" &&
            (event.payload?.run as { id?: string; status?: string } | undefined)
              ?.id === queuedBody.run.id &&
            (event.payload?.run as { status?: string } | undefined)?.status ===
              "completed",
        );
      },
      { runtimeFactory },
    );
  });
});
