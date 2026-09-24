import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { act, useState } from "react";
import { testRender } from "@opentui/react/test-utils";

import { useServerSync } from "./useServerSync";
import type { TuiSessionController } from "./sessionController";
import type { SessionEventRecord, SessionMessagePartRecord, SessionMessageRecord, SessionRecord } from "@vykor/client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, });
}

function capabilitiesResponse(): Response {
  return jsonResponse({
    serverVersion: "test",
    protocol: { version: 4 },
    features: {},
  });
}

function event(seq: number, type: string, payload: Record<string, unknown>, sessionId = "s1"): SessionEventRecord {
  return { id: `e${seq}`, seq, type, schemaVersion: 1, sessionId, payload, createdAt: seq };
}

function sseResponse(events: SessionEventRecord[] = []): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      for (const item of events) {
          controller.enqueue(encoder.encode(`id: ${item.seq}\nevent: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`));
      }
      controller.close();
    },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

type DaemonFixture = {
  url: string;
  token: string;
  stop: () => Promise<void>;
};
type DaemonChild = ChildProcessByStdio<null, Readable, Readable>;
type DaemonFixtureOptions = {
  startupTimeoutMs?: number;
  scriptSource?: string;
  onSpawn?: (child: DaemonChild, dir: string) => void;
};

function waitForFixtureReady(
  child: DaemonChild,
  timeoutMs = 90_000,
): Promise<{ url: string; token: string }> {
  let stdout = "";
  let stderr = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for daemon fixture.\n${stderr}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      const line = stdout.slice(0, newline).trim();
      try {
        resolve(JSON.parse(line) as { url: string; token: string });
      } catch (error) {
        reject(
          new Error(`Daemon fixture printed invalid startup JSON: ${line}`, {
            cause: error,
          }),
        );
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Daemon fixture exited before startup: code=${code} signal=${signal}\n${stderr}`));
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForChildExit(child: DaemonChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function cleanupDaemonFixture(child: DaemonChild | undefined, dir: string): Promise<void> {
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      if (!(await waitForChildExit(child, 2_000)) && child.exitCode === null) {
        child.kill("SIGKILL");
        await waitForChildExit(child, 1_000);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function resolveTsxLoader(repoRoot: string): string {
  const pnpmModulesDir = join(repoRoot, "node_modules", ".pnpm");
  const tsxPackageDir = readdirSync(pnpmModulesDir).find((name) => name.startsWith("tsx@"));
  if (!tsxPackageDir) {
    throw new Error("Unable to find tsx loader under node_modules/.pnpm.");
  }
  return join(pnpmModulesDir, tsxPackageDir, "node_modules", "tsx", "dist", "loader.mjs");
}

async function startDaemonFixture(options: DaemonFixtureOptions = {}): Promise<DaemonFixture> {
  const dir = mkdtempSync(join(tmpdir(), "vk-tui-sync-"));
  const token = "tui-sync-token";
  const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  const serverModuleUrl = pathToFileURL(join(repoRoot, "packages/server/src/http/server.ts")).href;
  const scriptPath = join(dir, "daemon-fixture.mjs");
  let child: DaemonChild | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= cleanupDaemonFixture(child, dir);

  try {
    writeFileSync(
      scriptPath,
      options.scriptSource ?? `
const { VykorHttpServer } = await import(${JSON.stringify(serverModuleUrl)});
const capabilities = Object.fromEntries([
  "terminal",
  "backgroundShell",
  "jobs",
  "attachments",
  "memory",
  "childEnvironment",
  "workflowRepository",
  "imageToText",
  "schedules",
].map((name) => [name, { status: "disabled" }]));

const server = new VykorHttpServer({
  token: ${JSON.stringify(token)},
  storePath: ${JSON.stringify(join(dir, "sessions.db"))},
  logger: () => {},
  async createAgent({ session, options: agentOptions }) {
    let sequence = 0;
    const publish = async (event, context) => {
      await agentOptions.onEvent?.({
        ...event,
        id: \`fixture-event-\${++sequence}\`,
        sequence,
        occurredAt: new Date().toISOString(),
        context,
      });
    };
    return {
      id: session.id,
      state: "idle",
      subscribe() { return () => {}; },
      children: { get() {}, getBySessionId() {}, list() { return []; } },
      submitMessage(content, options) {
        if (content !== "please edit") {
          throw new Error(\`Unexpected prompt: \${content}\`);
        }
        const ids = options.ids;
        const context = { agentId: session.id, sessionId: session.id, inputId: ids.inputId, runId: ids.runId, traceId: ids.traceId };
        const result = (async () => {
          await publish({
            type: "input.accepted",
            data: {
              content,
              delivery: options.delivery ?? "queue",
              ...(options.metadata ? { metadata: options.metadata } : {}),
            },
          }, context);
          await publish({ type: "run.started", data: {} }, context);
          const request = { toolName: "Write", reason: "exercise TUI permission flow", input: { path: "README.md" } };
          const requestId = \`permission-\${sequence + 1}\`;
          await publish({ type: "permission.requested", data: { requestId, request } }, context);
          const decision = await agentOptions.effects.requestPermission(request, {
            ...context,
            cwd: session.cwd,
            signal: new AbortController().signal,
          });
          await publish({ type: "permission.resolved", data: { requestId, decision } }, context);
          const output = decision.status === "approved" ? "edit approved" : "edit denied";
          await publish({ type: "output.text.delta", data: { delta: output } }, context);
          await publish({ type: "run.completed", data: { output } }, context);
          return { status: "completed", output, history: [], usage: { inputTokens: 0, outputTokens: 0 } };
        })();
        return {
          id: ids.runId,
          inputId: ids.inputId,
          sessionId: session.id,
          traceId: ids.traceId,
          started: Promise.resolve({ sessionId: session.id, inputId: ids.inputId, runId: ids.runId }),
          result,
          async steer() { throw new Error("steer is not used in this fixture"); },
          async interrupt() { await result.catch(() => {}); },
        };
      },
      async runMessage(content, options) { return await this.submitMessage(content, options).result; },
      getHistory() { return []; },
      loadHistory() {},
      clear() {},
      setModel() {},
      setCompactContextProvider() {},
      async compact() { return { history: [], beforeMessageCount: 0, afterMessageCount: 0 }; },
      async remember() { return { skipped: true, writtenIds: [], titles: [] }; },
      getUsage() { return { inputTokens: 0, outputTokens: 0 }; },
      getCapabilities() { return capabilities; },
      inspect() {
        return {
          model: session.model,
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
          capabilities,
        };
      },
      async close() {},
    };
  },
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await server.close();
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});

const listen = await server.listen();
console.log(JSON.stringify({ url: listen.url, token: ${JSON.stringify(token)} }));
`,
    );

    const tsxLoaderUrl = pathToFileURL(resolveTsxLoader(repoRoot)).href;
    child = spawn("node", ["--import", tsxLoaderUrl, scriptPath], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    options.onSpawn?.(child, dir);
    const ready = await waitForFixtureReady(child, options.startupTimeoutMs);
    return { ...ready, stop: cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

test("useServerSync hydrates daemon state and sends prompt/permission replies", async () => {
  const session: SessionRecord = {
    id: "s1",
    cwd: process.cwd(),
    title: "TUI",
    model: "m",
    status: "idle",
    metadata: { runtime: { model: "m" } },
    createdAt: 1,
    updatedAt: 1,
  };
  const createdSession: SessionRecord = {
    ...session,
    id: "s2",
    title: "Scratch",
    createdAt: 4,
    updatedAt: 4,
  };
  const childSession: SessionRecord = {
    ...session,
    id: "child1",
    parentId: "s1",
    title: "Child worker",
    status: "running",
    createdAt: 3,
    updatedAt: 6,
  };
  const message: SessionMessageRecord = {
    id: "m1",
    sessionId: "s1",
    seq: 1,
    role: "assistant",
    metadata: {},
    createdAt: 2,
    updatedAt: 2,
  };
  const textPart: SessionMessagePartRecord = {
    id: "p1",
    sessionId: "s1",
    messageId: "m1",
    seq: 1,
    type: "text",
    status: "completed",
    text: "hello from daemon",
    metadata: {},
    createdAt: 2.5,
    updatedAt: 2.5,
  };
  const toolPart: SessionMessagePartRecord = {
    id: "hist1",
    sessionId: "s1",
    messageId: "m1",
    seq: 2,
    type: "tool",
    status: "completed",
    toolUseId: "hist1",
    toolName: "Read",
    input: { path: "README.md" },
    output: { content: [{ type: "text", text: "historical output" }] },
    metadata: {},
    createdAt: 2.6,
    updatedAt: 2.6,
  };
  const liveMessage: SessionMessageRecord = {
    id: "m-live",
    sessionId: "s1",
    seq: 2,
    role: "assistant",
    metadata: {},
    createdAt: 5,
    updatedAt: 5,
  };
  const liveTextPart: SessionMessagePartRecord = {
    id: "p-live",
    sessionId: "s1",
    messageId: "m-live",
    seq: 3,
    type: "text",
    status: "running",
    text: "",
    metadata: {},
    createdAt: 6,
    updatedAt: 6,
  };
  const liveToolPart: SessionMessagePartRecord = {
    id: "live1",
    sessionId: "s1",
    messageId: "m-live",
    seq: 4,
    type: "tool",
    status: "completed",
    toolUseId: "live1",
    toolName: "Bash",
    input: { command: "pwd" },
    output: { content: [{ type: "text", text: "live output" }] },
    metadata: {},
    createdAt: 7,
    updatedAt: 8,
  };
  const permission = {
    id: "p1",
    sessionId: "s1",
    runId: "r1",
    toolName: "Write",
    payload: { reason: "needs edit", input: { path: "README.md" } },
    status: "pending",
    createdAt: 3,
    updatedAt: 3,
  };
  const run = {
    id: "r1",
    sessionId: "s1",
    inputId: "i1",
    status: "running",
    metadata: {},
    createdAt: 4,
    updatedAt: 4,
  };
  const interruptedInput = {
    id: "i-interrupted",
    sessionId: "s1",
    seq: 2,
    delivery: "queue" as const,
    content: "finish interrupted work",
    attachments: [],
    metadata: {},
    createdAt: 5,
  };
  const interruptedRun = {
    id: "r-interrupted",
    sessionId: "s1",
    inputId: interruptedInput.id,
    status: "interrupted" as const,
    error: "Daemon restarted before the run completed",
    metadata: {},
    createdAt: 5,
    updatedAt: 5,
  };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let holdNextSessionList = false;
  let releaseHeldSessionList: ((response: Response) => void) | undefined;
  let listedCreatedSession = false;
  const archivedSessionIds = new Set<string>();
  let holdNextContext = false;
  let releaseHeldContext: ((response: Response) => void) | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const requestUrl = new URL(String(url));
    const pathname = requestUrl.pathname;
    if (pathname === "/health") {
      return jsonResponse({ ok: true });
    }
    if (pathname === "/capabilities") return capabilitiesResponse();
    if (pathname === "/settings" && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({
        settings: {
          model: typeof body.model === "string" ? body.model : "settings-model",
          provider: typeof body.provider === "string" ? body.provider : "openrouter",
          permission: { mode: "default" },
          effort: body.effort ?? "medium",
          fastMode: body.fastMode ?? false,
          maxTurns: body.maxTurns ?? 50,
        },
      });
    }
    if (pathname === "/settings") {
      return jsonResponse({
        settings: {
          model: "settings-model",
          provider: "openrouter",
          permission: { mode: "default" },
          effort: "medium",
          fastMode: false,
          maxTurns: 50,
        },
      });
    }
    if (pathname === "/commands") {
      return jsonResponse({
        commands: [
          {
            name: "/skills",
            kind: "session",
            source: "builtin",
            description: "List skills",
          },
          {
            name: "/config",
            kind: "session",
            source: "builtin",
            description: "Show or edit settings",
          },
          {
            name: "/provider",
            kind: "session",
            source: "builtin",
            description: "Show or switch provider",
          },
          {
            name: "/mcp",
            kind: "session",
            source: "builtin",
            description: "Show MCP status",
          },
          {
            name: "/jobs",
            kind: "session",
            source: "builtin",
            description: "List Jobs",
          },
          {
            name: "/background",
            kind: "session",
            source: "builtin",
            description: "Start a background shell",
          },
          {
            name: "/help",
            kind: "session",
            source: "builtin",
            description: "List commands",
          },
          {
            name: "/status",
            kind: "session",
            source: "builtin",
            description: "Session status",
          },
          {
            name: "/version",
            kind: "session",
            source: "builtin",
            description: "Version",
          },
          {
            name: "/compact",
            kind: "session",
            source: "builtin",
            description: "Compact",
          },
          {
            name: "/remember",
            kind: "session",
            source: "builtin",
            description: "Remember",
          },
          {
            name: "/dream",
            kind: "session",
            source: "builtin",
            description: "Dream",
          },
          {
            name: "/profile",
            kind: "session",
            source: "builtin",
            description: "Profile",
          },
          {
            name: "/doctor",
            kind: "session",
            source: "builtin",
            description: "Doctor",
          },
          {
            name: "/effort",
            kind: "session",
            source: "builtin",
            description: "Effort",
          },
          {
            name: "/usage",
            kind: "session",
            source: "builtin",
            description: "Usage",
          },
          {
            name: "/cost",
            kind: "session",
            source: "builtin",
            description: "Cost",
          },
          {
            name: "/export",
            kind: "session",
            source: "builtin",
            description: "Export",
          },
          {
            name: "/output-style",
            kind: "session",
            source: "builtin",
            description: "Output style",
          },
          {
            name: "/init",
            kind: "session",
            source: "builtin",
            description: "Init project",
          },
          {
            name: "/plugin",
            kind: "session",
            source: "builtin",
            description: "Plugins",
          },
          {
            name: "/hooks",
            kind: "session",
            source: "builtin",
            description: "Hooks",
          },
          {
            name: "/subagents",
            kind: "session",
            source: "builtin",
            description: "Subagents",
          },
          {
            name: "/diff",
            kind: "session",
            source: "builtin",
            description: "Diff",
          },
          {
            name: "/branch",
            kind: "session",
            source: "builtin",
            description: "Branch",
          },
          {
            name: "/rewind",
            kind: "session",
            source: "builtin",
            description: "Rewind",
          },
          {
            name: "/commit",
            kind: "session",
            source: "builtin",
            description: "Commit",
          },
          {
            name: "/reload-plugins",
            kind: "session",
            source: "builtin",
            description: "Reload plugins",
          },
          {
            name: "/pr",
            kind: "template",
            skillName: "pull-request",
            path: "/skills/pull-request/SKILL.md",
            source: "user",
            description: "Write a PR",
          },
        ],
      });
    }
    if (pathname === "/output-styles") {
      return jsonResponse({
        styles: [
          { name: "default", content: "std", source: "builtin" },
          { name: "minimal", content: "terse", source: "builtin" },
        ],
      });
    }
    if (pathname === "/sessions/s1/usage") {
      return jsonResponse({
        model: "m",
        inputTokens: 11,
        outputTokens: 22,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        messageCount: 2,
        estimatedCost: "$0.0001",
      });
    }
    if (pathname === "/sessions/s1/export" && init?.method === "POST") {
      return jsonResponse({
        format: "md",
        filepath: "/tmp/export.md",
        messageCount: 2,
      });
    }
    if (pathname === "/dream" && init?.method === "POST") {
      return jsonResponse({ taskId: "dream_1" });
    }
    if (pathname === "/profile/init" && init?.method === "POST") {
      return jsonResponse({ report: "PROFILE INIT" });
    }
    if (pathname === "/profile") {
      return jsonResponse({ report: "PROFILE STATUS" });
    }
    if (pathname === "/sessions/s1/compact" && init?.method === "POST") {
      return jsonResponse({ messageCount: 2, messages: [], parts: [] });
    }
    if (pathname === "/sessions/s1/remember" && init?.method === "POST") {
      return jsonResponse({
        skipped: false,
        writtenIds: ["mem2"],
        titles: ["pnpm tip"],
      });
    }
    if (pathname === "/providers") {
      return jsonResponse({
        providers: [
          { name: "openai", displayName: "OpenAI", hasKey: true, active: true },
          {
            name: "anthropic",
            displayName: "Anthropic",
            hasKey: false,
            active: false,
          },
        ],
      });
    }
    if (pathname === "/background-shells" && init?.method === "POST") {
      return jsonResponse({
        jobId: "shell_run_1",
        snapshot: {
          id: "shell_run_1",
          kind: "shell",
          label: "echo hi",
          ownerSession: "s1",
          status: "running",
          capabilities: { read: true, wait: true, send: false, cancel: true },
          cwd: process.cwd(),
          startedAt: 1,
          updatedAt: 1,
        },
      });
    }
    if (pathname === "/jobs") {
      return jsonResponse({
        jobs: [
          {
            id: "agent_job_1",
            kind: "agent",
            label: "demo",
            ownerSession: "s1",
            status: "running",
            capabilities: { read: true, wait: true, send: true, cancel: true },
            cwd: process.cwd(),
            startedAt: 1,
            updatedAt: 1,
          },
        ],
      });
    }
    if (pathname === "/project/init" && init?.method === "POST") {
      return jsonResponse({ report: "Project initialized successfully." });
    }
    if (pathname === "/plugins/demo/enable" && init?.method === "POST") {
      return jsonResponse({ message: "Enabled plugin 'demo'." });
    }
    if (pathname === "/plugins") {
      return jsonResponse({
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
      });
    }
    if (pathname === "/hooks") {
      return jsonResponse({
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
    }
    if (pathname === "/agent-personas") {
      return jsonResponse({
        agents: [{ name: "Explore", description: "search files", source: "builtin" }],
      });
    }
    if (pathname === "/git/diff") {
      return jsonResponse({ output: "a.txt | 1 +\n" });
    }
    if (pathname === "/git/branch") {
      return jsonResponse({ output: "Current branch: main" });
    }
    if (pathname === "/sessions/s1/mcp") {
      return jsonResponse({
        servers: [
          {
            name: "demo",
            status: "connected",
            toolCount: 1,
            resourceCount: 0,
            command: "demo",
          },
        ],
      });
    }
    if (pathname === "/memory" && init?.method === "POST") {
      return jsonResponse({
        entry: {
          id: "mem1",
          content: "prefer pnpm",
          createdAt: 1,
          updatedAt: 1,
        },
      });
    }
    if (pathname === "/memory") {
      return jsonResponse({
        directory: "/tmp/memory",
        entries: [{ id: "mem1", content: "prefer pnpm", createdAt: 1, updatedAt: 1 }],
      });
    }
    if (pathname === "/auth") {
      return jsonResponse({
        auth: {
          codex: {
            configured: false,
            state: "missing",
            source: "/tmp/auth.json",
          },
          storedProviders: ["openai"],
          envProviders: [],
        },
      });
    }
    if (pathname === "/context") {
      if (holdNextContext) {
        holdNextContext = false;
        return await new Promise<Response>((resolve) => {
          releaseHeldContext = resolve;
        });
      }
      return jsonResponse({ report: "CONTEXT PREVIEW" });
    }
    if (pathname === "/sessions" && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as {
        model?: string;
        metadata?: Record<string, unknown>;
      };
      listedCreatedSession = true;
      return jsonResponse({
        session: {
          ...createdSession,
          model: body.model ?? createdSession.model,
          metadata: body.metadata ?? createdSession.metadata,
        },
      });
    }
    if (pathname === "/sessions") {
      if (holdNextSessionList) {
        holdNextSessionList = false;
        return await new Promise<Response>((resolve) => {
          releaseHeldSessionList = resolve;
        });
      }
      const sessions = [session, childSession];
      if (listedCreatedSession && !archivedSessionIds.has("s2")) sessions.push(createdSession);
      return jsonResponse({ sessions });
    }
    if ((pathname === "/sessions/s1" || pathname === "/sessions/s2") && init?.method === "GET") {
      return jsonResponse({
        session: pathname.endsWith("/s2") ? createdSession : session,
      });
    }
    if ((pathname === "/sessions/s1" || pathname === "/sessions/s2") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body ?? "{}")) as {
        model?: string;
        metadata?: Record<string, unknown>;
      };
      const base = pathname.endsWith("/s2") ? createdSession : session;
      return jsonResponse({
        session: {
          ...base,
          model: body.model ?? base.model,
          metadata: body.metadata ? { ...base.metadata, ...body.metadata } : base.metadata,
          updatedAt: 9,
        },
      });
    }
    if (pathname === "/sessions/s1/rewind" && init?.method === "POST") {
      return jsonResponse({ turns: 1, removed: 2, messages: [], parts: [] });
    }
    if (pathname === "/plugins/reload" && init?.method === "POST") {
      return jsonResponse({
        plugins: [
          {
            identity: { id: "demo", name: "demo", version: "1.0.0" },
            origin: "native",
            scope: "project",
            enabled: true,
            installation: "installed",
            activation: "active",
            inventory: { skills: 1, commands: 0, hooks: 0, agents: 0 },
            permissions: { requested: [], approved: [], missing: [] },
            diagnostics: [],
          },
        ],
        warnings: [],
        message: "Plugins rediscovered; session runtimes will reload on next use.",
      });
    }
    if (pathname === "/git/status") {
      return jsonResponse({ output: " M README.md\n" });
    }
    if (pathname === "/git/commit" && init?.method === "POST") {
      return jsonResponse({ output: "[main abc123] fix auth" });
    }
    if (pathname === "/sessions/s1/state") {
      return jsonResponse({
        cursor: 6,
        session,
        inputs: [interruptedInput],
        messages: [message],
        parts: [textPart, toolPart],
        runs: [run, interruptedRun],
        attempts: [],
        permissions: [permission],
      });
    }
    if (pathname === "/sessions/s2/state") {
      return jsonResponse({
        cursor: 10,
        session: createdSession,
        inputs: [],
        messages: [],
        parts: [],
        runs: [],
        attempts: [],
        permissions: [],
      });
    }
    if (pathname === "/sessions/s2" && init?.method === "DELETE") {
      archivedSessionIds.add("s2");
      return jsonResponse({
        session: { ...createdSession, status: "archived", archivedAt: 20 },
      });
    }
    if (pathname === "/events") {
      return jsonResponse({
        events: [
          event(1, "session.created", { session }),
          event(2, "session.message.created", { message }),
          event(3, "session.message.part.updated", { part: textPart }),
          event(4, "session.message.part.updated", { part: toolPart }),
          event(5, "permission.asked", { request: permission }),
          event(6, "session.run.updated", { run }),
          event(7, "session.message.created", { message: liveMessage }),
          event(8, "session.message.part.updated", { part: liveTextPart }),
          event(9, "session.message.part.delta", {
            sessionId: "s1",
            messageId: "m-live",
            partId: "p-live",
            field: "text",
            delta: "streaming now",
          }),
          event(10, "session.message.part.updated", { part: liveToolPart }),
        ],
      });
    }
    if (pathname === "/events/stream" && requestUrl.searchParams.get("sessionId") === "s2") {
      return sseResponse([
        event(
          11,
          "session.run.updated",
          {
        run: {
          id: "r2",
          sessionId: "s2",
          status: "failed",
          error: "provider unavailable",
          metadata: {},
          createdAt: 12,
          updatedAt: 13,
        },
          },
          "s2",
        ),
      ]);
    }
    if (pathname === "/events/stream")
      return sseResponse([
      event(7, "session.message.created", { message: liveMessage }),
      event(8, "session.message.part.updated", { part: liveTextPart }),
      event(9, "session.message.part.delta", {
        sessionId: "s1",
        messageId: "m-live",
        partId: "p-live",
        field: "text",
        delta: "streaming now",
      }),
      event(10, "session.message.part.updated", { part: liveToolPart }),
    ]);
    if (pathname === "/sessions/s1/prompts") return jsonResponse({ input: { id: "i1" } });
    if (pathname === "/sessions/s2/prompts")
      return jsonResponse({
      input: { id: "i2" },
        run: {
          id: "r2",
          sessionId: "s2",
          status: "running",
          metadata: {},
          createdAt: 12,
          updatedAt: 12,
        },
    });
    if (pathname === "/sessions/s1/runs/r-interrupted/resume") {
      return jsonResponse({
        input: {
          ...interruptedInput,
          id: "i-recovery",
          metadata: { recovery: { sourceRunId: interruptedRun.id } },
        },
        run: {
          ...interruptedRun,
          id: "r-recovery",
          inputId: "i-recovery",
          status: "pending",
        },
        source_run: interruptedRun,
      });
    }
    if (pathname === "/permissions/p1/reply") {
      return jsonResponse({
        request: { ...permission, status: "approved", decision: "once" },
      });
    }
    return jsonResponse({});
  }) as typeof fetch;

  let captured: TuiSessionController | undefined;
  const errors: string[] = [];
  function Harness() {
    captured = useServerSync(
      {
      daemon: {
        url: "http://daemon.test",
        token: "tok",
        cwd: session.cwd,
        model: "m",
        permissionMode: "plan",
        maxTurns: 11,
        sessionMode: "coordinator",
      },
      },
      (message) => errors.push(message),
    );
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, {
    width: 80,
    height: 24,
  });
  for (let i = 0; i < 20 && (!captured?.ready || captured.transcript.length === 0 || !captured.modal); i += 1) {
    await act(async () => {
      await renderOnce();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }

  expect(captured?.ready).toBe(true);
  expect(captured?.transcript.map((item) => item.text)).toContain("hello from daemon");
  expect(captured?.transcript).toContainEqual(
    expect.objectContaining({
    role: "tool",
    tool_name: "Read",
    tool_input: { path: "README.md" },
    }),
  );
  expect(captured?.transcript).toContainEqual(
    expect.objectContaining({
    role: "tool_result",
    tool_name: "Read",
    text: "historical output",
    }),
  );
  expect(captured?.transcript).toContainEqual(
    expect.objectContaining({
    role: "tool",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
    }),
  );
  expect(captured?.transcript).toContainEqual(
    expect.objectContaining({
    role: "tool_result",
    tool_name: "Bash",
    text: "live output",
    }),
  );
  expect(captured?.transcript.map((item) => item.text)).not.toContain("streaming now");
  expect(captured?.transcript.map((item) => item.text)).toContain("Run interrupted: Daemon restarted before the run completed\nUse /resume r-interrupted to replay its original prompt.");
  expect(captured?.assistantBuffer).toBe("streaming now");
  expect(captured?.modal).toMatchObject({
    kind: "permission",
    request_id: "p1",
    tool_name: "Write",
  });

  await act(async () => {
    captured?.sendRequest({ type: "submit_line", line: "next prompt" });
    captured?.sendRequest({
      type: "permission_response",
      request_id: "p1",
      allowed: true,
      scope: "once",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  expect(calls.some((call) => call.url === "http://daemon.test/sessions/s1/prompts")).toBe(true);
  expect(calls.some((call) => call.url === "http://daemon.test/permissions/p1/reply")).toBe(true);
  const publicPaths = new Set(["/health", "/capabilities"]);
  const publicCalls = calls.filter((call) => publicPaths.has(new URL(call.url).pathname));
  const authenticatedCalls = calls.filter((call) => !publicPaths.has(new URL(call.url).pathname));
  expect(publicCalls.map((call) => new URL(call.url).pathname)).toEqual(
    expect.arrayContaining(["/health", "/capabilities"]),
  );
  expect(publicCalls.every((call) => new Headers(call.init.headers).get("authorization") === null)).toBe(true);
  expect(
    authenticatedCalls
      .filter((call) => new Headers(call.init.headers).get("authorization") !== "Bearer tok")
      .map((call) => call.url),
  ).toEqual([]);

  await act(async () => {
    captured?.sendRequest({
      type: "submit_line",
      line: "/resume r-interrupted",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const recoveryCall = calls.find((call) => call.url === "http://daemon.test/sessions/s1/runs/r-interrupted/resume");
  expect(recoveryCall?.init.method).toBe("POST");
  expect(JSON.parse(String(recoveryCall?.init.body ?? "{}"))).toMatchObject({
    id: expect.any(String),
  });

  await act(async () => {
    holdNextSessionList = true;
    captured?.sendRequest({ type: "list_sessions" });
    await Promise.resolve();
  });
  const sessionOption = captured?.selectRequest?.options[0];
  expect(sessionOption?.value).toBe("s1");
  expect(sessionOption?.label === "TUI" || sessionOption?.label === "* TUI").toBe(true);
  expect(sessionOption?.description?.endsWith("| idle")).toBe(true);
  expect(captured?.selectRequest?.options.some((option) => String(option.label).includes("New session"))).toBe(false);
  expect(captured?.selectRequest?.options.some((option) => option.value === "child1")).toBe(false);
  expect(sessionOption?.description?.includes("\\") || sessionOption?.description?.includes("/")).toBe(false);
  expect(releaseHeldSessionList).toBeTruthy();

  await act(async () => {
    releaseHeldSessionList?.(jsonResponse({ sessions: [session, childSession] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(captured?.selectRequest?.options.some((option) => option.value === "child1")).toBe(false);

  await act(async () => {
    holdNextContext = true;
    captured?.sendRequest({ type: "submit_line", line: "/context" });
    await Promise.resolve();
  });
  expect(captured?.displayRequest?.title).toBe("Context");
  expect(captured?.displayRequest?.content).toBe("Loading...");
  expect(releaseHeldContext).toBeTruthy();

  await act(async () => {
    releaseHeldContext?.(jsonResponse({ report: "CONTEXT V1" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(captured?.displayRequest?.content).toBe("CONTEXT V1");

  await act(async () => {
    holdNextContext = true;
    captured?.sendRequest({ type: "submit_line", line: "/context" });
    await Promise.resolve();
  });
  expect(captured?.displayRequest?.content).toBe("CONTEXT V1");
  await act(async () => {
    releaseHeldContext?.(jsonResponse({ report: "CONTEXT V2" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(captured?.displayRequest?.content).toBe("CONTEXT V2");

  await act(async () => {
    captured?.sendRequest({ type: "submit_line", line: "/new Scratch" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  let createCall = calls.find((call) => call.url === "http://daemon.test/sessions" && call.init.method === "POST");
  expect(createCall).toBeUndefined();
  expect(captured?.status.session_id).toBeUndefined();
  expect(captured?.busy).toBe(false);

  await act(async () => {
    captured?.sendRequest({ type: "set_session_mode", session_mode: "direct" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(captured?.status.session_mode).toBe("direct");

  await act(async () => {
    captured?.sendRequest({
      type: "set_session_mode",
      session_mode: "coordinator",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(captured?.status.session_mode).toBe("coordinator");

  await act(async () => {
    captured?.sendRequest({ type: "list_sessions" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(captured?.selectRequest?.title).toBe("Sessions");
  expect(captured?.selectRequest?.options[0]?.value).toBe("s1");

  await act(async () => {
    captured?.sendRequest({
      type: "submit_line",
      line: "first scratch prompt",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  createCall = calls.find((call) => call.url === "http://daemon.test/sessions" && call.init.method === "POST");
  expect(createCall).toBeTruthy();
  expect(JSON.parse(String(createCall?.init.body ?? "{}"))).toMatchObject({
    model: "m",
    title: "Scratch",
    metadata: {
      runtime: {
        model: "m",
        provider: "openrouter",
        permissionMode: "plan",
        maxTurns: 11,
        sessionMode: "coordinator",
      },
    },
  });
  expect(calls.some((call) => call.url === "http://daemon.test/sessions/s2/prompts")).toBe(true);
  expect(captured?.status.session_id).toBe("s2");
  expect(captured?.busy).toBe(false);
  expect(errors).toContain("provider unavailable");
  expect(captured?.transcript).toContainEqual({
    role: "system",
    text: "error: provider unavailable",
  });

  await act(async () => {
    captured?.sendRequest({
      type: "set_permission_mode",
      permission_mode: "full_auto",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const permissionPatch = calls.find((call) => call.url === "http://daemon.test/sessions/s2" && call.init.method === "PATCH" && String(call.init.body ?? "").includes("permissionMode"));
  expect(permissionPatch).toBeTruthy();
  expect(captured?.status.permission_mode).toBe("full_auto");

  await act(async () => {
    captured?.sendRequest({ type: "list_sessions" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(captured?.selectRequest?.options.some((option) => option.value === "s2")).toBe(true);

  await act(async () => {
    captured?.sendRequest({ type: "delete_session", session_id: "s2" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(calls.some((call) => call.url === "http://daemon.test/sessions/s2" && call.init.method === "DELETE")).toBe(true);
  expect(captured?.status.session_id).toBe("s1");
  expect(captured?.selectRequest?.options.some((option) => option.value === "s2")).toBe(false);

  await act(async () => {
    holdNextSessionList = true;
    captured?.sendRequest({ type: "list_sessions" });
    await Promise.resolve();
  });
  expect(captured?.selectRequest?.options.some((option) => option.value === "s2")).toBe(false);
  await act(async () => {
    releaseHeldSessionList?.(jsonResponse({ sessions: [session, childSession] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(captured?.selectRequest?.options.some((option) => option.value === "s2")).toBe(false);

  expect(captured?.commands).toEqual(expect.arrayContaining([
    "/new",
    "/models",
    "/pr",
    "/skills",
    "/jobs",
    "/background",
  ]));
  expect(captured?.commands).not.toContain("/model");
  expect(captured?.commands).not.toContain("/tasks");

  await act(async () => {
    captured?.sendRequest({
      type: "select_model",
      model: "nvidia/nemotron-3.5-lightning:free",
      provider: "openrouter",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const modelSessionPatch = calls.find((call) => call.url === "http://daemon.test/sessions/s1" && call.init.method === "PATCH" && String(call.init.body ?? "").includes("nvidia/nemotron-3.5-lightning:free"));
  expect(modelSessionPatch).toBeTruthy();
  expect(JSON.parse(String(modelSessionPatch?.init.body ?? "{}"))).toMatchObject({
    metadata: {
      runtime: {
        model: "nvidia/nemotron-3.5-lightning:free",
        provider: "openrouter",
      },
    },
  });
  expect(captured?.status.model).toBe("nvidia/nemotron-3.5-lightning:free");
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Model selected: nvidia/nemotron-3.5-lightning:free"))).toBe(true);

  await act(async () => {
    captured?.sendRequest({ type: "submit_line", line: "/pr fix auth" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const skillPrompt = calls.find(
    (call) => call.url === "http://daemon.test/sessions/s1/prompts" &&
      call.init.method === "POST" &&
      String(call.init.body ?? "").includes("fix auth"),
  );
  expect(JSON.parse(String(skillPrompt?.init.body ?? "{}"))).toMatchObject({
    items: [
      { type: "skill", name: "pull-request", path: "/skills/pull-request/SKILL.md", source: "user" },
      { type: "text", text: " fix auth" },
    ],
  });

  const promptCallsBeforeUnknown = calls.filter((call) => call.url.includes("/prompts")).length;
  await act(async () => {
    captured?.sendRequest({
      type: "submit_line",
      line: "/definitely-not-a-command",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(calls.filter((call) => call.url.includes("/prompts")).length).toBe(promptCallsBeforeUnknown);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Unknown command: /definitely-not-a-command"))).toBe(true);

  await act(async () => {
    captured?.sendRequest({ type: "submit_line", line: "/help" });
    captured?.sendRequest({ type: "submit_line", line: "/config show" });
    captured?.sendRequest({ type: "submit_line", line: "/provider" });
    captured?.sendRequest({ type: "submit_line", line: "/mcp" });
    captured?.sendRequest({ type: "submit_line", line: "/jobs list" });
    captured?.sendRequest({ type: "submit_line", line: "/memory" });
    captured?.sendRequest({ type: "submit_line", line: "/auth" });
    captured?.sendRequest({ type: "submit_line", line: "/context" });
    captured?.sendRequest({ type: "submit_line", line: "/stats" });
    captured?.sendRequest({ type: "submit_line", line: "/agents" });
    captured?.sendRequest({ type: "submit_line", line: "/compact" });
    captured?.sendRequest({ type: "submit_line", line: "/remember" });
    captured?.sendRequest({ type: "submit_line", line: "/dream" });
    captured?.sendRequest({ type: "submit_line", line: "/profile" });
    captured?.sendRequest({ type: "submit_line", line: "/doctor" });
    captured?.sendRequest({ type: "submit_line", line: "/effort high" });
    captured?.sendRequest({ type: "submit_line", line: "/usage" });
    captured?.sendRequest({ type: "submit_line", line: "/cost" });
    captured?.sendRequest({ type: "submit_line", line: "/export" });
    captured?.sendRequest({ type: "submit_line", line: "/output-style list" });
    captured?.sendRequest({ type: "submit_line", line: "/background echo hi" });
    captured?.sendRequest({ type: "submit_line", line: "/init" });
    captured?.sendRequest({ type: "submit_line", line: "/plugin" });
    captured?.sendRequest({ type: "submit_line", line: "/hooks" });
    captured?.sendRequest({ type: "submit_line", line: "/subagents" });
    captured?.sendRequest({ type: "submit_line", line: "/diff" });
    captured?.sendRequest({ type: "submit_line", line: "/branch" });
    captured?.sendRequest({ type: "submit_line", line: "/rewind 1" });
    captured?.sendRequest({ type: "submit_line", line: "/reload-plugins" });
    captured?.sendRequest({ type: "submit_line", line: "/commit" });
    captured?.sendRequest({ type: "submit_line", line: "/commit fix auth" });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Available commands:"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes('"provider": "openai"'))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("OpenAI"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("MCP Servers"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("agent_job_1"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("prefer pnpm"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Credential status:"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("CONTEXT PREVIEW"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Session stats:"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Agent Jobs"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Conversation compacted"))).toBe(true);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("已写入"))).toBe(true);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Dream started as Job dream_1"))).toBe(true);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("PROFILE STATUS"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Vykor Environment Diagnostic"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Effort set to: high"))).toBe(true);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Token usage:"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Cost estimate:"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Exported Markdown to:"))).toBe(true);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("* default"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Background shell started: shell_run_1"))).toBe(true);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Project initialized successfully."))).toBe(true);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("demo@1.0.0"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("h1: stop"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Explore"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("a.txt | 1 +"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Current branch: main"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Rewound 1 turn(s)"))).toBe(true);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Plugins rediscovered; session runtimes will reload on next use."))).toBe(true);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("M README.md"))).toBe(false);

  await act(async () => {
    captured?.sendRequest({ type: "submit_line", line: "/commit" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(captured?.displayRequest?.title).toBe("Commit");
  expect(captured?.displayRequest?.content).toContain("M README.md");
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("[main abc123] fix auth"))).toBe(true);

  const createCallsBeforeImmediateNew = calls.filter((call) => call.url === "http://daemon.test/sessions" && call.init.method === "POST").length;
  const oldPromptCallsBeforeImmediateNew = calls.filter((call) => call.url === "http://daemon.test/sessions/s1/prompts").length;
  await act(async () => {
    captured?.sendRequest({ type: "submit_line", line: "/new Isolated" });
    captured?.sendRequest({ type: "submit_line", line: "isolated prompt" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(calls.filter((call) => call.url === "http://daemon.test/sessions" && call.init.method === "POST")).toHaveLength(createCallsBeforeImmediateNew + 1);
  expect(calls.filter((call) => call.url === "http://daemon.test/sessions/s1/prompts")).toHaveLength(oldPromptCallsBeforeImmediateNew);
  expect(calls.some((call) => call.url === "http://daemon.test/sessions/s2/prompts")).toBe(true);
  expect(captured?.status.session_id).toBe("s2");
  expect(captured?.transcript.some((item) => item.text.includes("Unknown command: /definitely-not-a-command") || item.text.includes("Model set to gpt-test"))).toBe(false);

  renderer.destroy();
}, 15_000);

test("useServerSync reconnects the active session when daemon identity changes", async () => {
  const session: SessionRecord = {
    id: "s1",
    cwd: process.cwd(),
    title: "Session",
    model: "m",
    status: "idle",
    metadata: { runtime: { model: "m" } },
    createdAt: 1,
    updatedAt: 1,
  };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let firstStreamAborted = false;

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = new URL(String(url));
    calls.push({ url: requestUrl.toString(), init: init ?? {} });
    const pathname = requestUrl.pathname;
    if (pathname === "/health") return jsonResponse({ ok: true });
    if (pathname === "/capabilities") return capabilitiesResponse();
    if (pathname === "/settings") return jsonResponse({ settings: { model: "m" } });
    if (pathname === "/commands") return jsonResponse({ commands: [] });
    if (pathname === "/sessions") return jsonResponse({ sessions: [session] });
    if (pathname === "/sessions/s1") return jsonResponse({ session });
    if (pathname === "/sessions/s1/state") {
      return jsonResponse({
        cursor: requestUrl.host === "daemon-next.test" ? 2 : 1,
        session,
        inputs: [],
        messages: [],
        parts: [],
        runs: [],
        attempts: [],
        tasks: [],
        permissions: [],
      });
    }
    if (pathname === "/sessions/s1/mcp") return jsonResponse({ servers: [] });
    if (pathname === "/jobs") return jsonResponse({ jobs: [] });
    if (pathname === "/events/stream") {
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener("abort", () => {
              if (requestUrl.host === "daemon.test") firstStreamAborted = true;
              controller.close();
            }, { once: true });
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return jsonResponse({});
  }) as typeof fetch;

  let switchDaemon: (() => void) | undefined;
  function Harness() {
    const [daemon, setDaemon] = useState({ url: "http://daemon.test", token: "old", model: "m" });
    switchDaemon = () => setDaemon({ url: "http://daemon-next.test", token: "next", model: "m" });
    useServerSync({ daemon });
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, { width: 80, height: 24 });
  for (let i = 0; i < 20 && !calls.some((call) => call.url.includes("daemon.test/events/stream")); i += 1) {
    await act(async () => {
      await renderOnce();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }

  await act(async () => {
    switchDaemon?.();
    await renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  expect(firstStreamAborted).toBe(true);
  expect(calls.some((call) => call.url.includes("daemon-next.test/sessions/s1/state"))).toBe(true);
  const nextStream = calls.find((call) => call.url.includes("daemon-next.test/events/stream"));
  expect(nextStream).toBeTruthy();
  expect(new Headers(nextStream?.init.headers).get("authorization")).toBe("Bearer next");
  renderer.destroy();
});

test("useServerSync starts on the new-session home when the latest session uses an older model", async () => {
  const oldSession: SessionRecord = {
    id: "old",
    cwd: process.cwd(),
    title: "Old session",
    model: "old-model",
    status: "idle",
    metadata: { runtime: { model: "old-model" } },
    createdAt: 1,
    updatedAt: 1,
  };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/health") return jsonResponse({ ok: true });
    if (pathname === "/capabilities") return capabilitiesResponse();
    if (pathname === "/settings")
      return jsonResponse({
        settings: { model: "new-model", provider: "openrouter" },
      });
    if (pathname === "/commands") return jsonResponse({ commands: [] });
    if (pathname === "/sessions" && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as { model?: string };
      return jsonResponse({
        session: {
          ...oldSession,
          id: "new",
          title: "TUI",
          model: body.model ?? "missing-model",
          metadata: { runtime: { model: body.model ?? "missing-model" } },
          updatedAt: 2,
        },
      });
    }
    if (pathname === "/sessions") return jsonResponse({ sessions: [oldSession] });
    if (pathname === "/sessions/new/prompts") return jsonResponse({ input: { id: "i-new" } });
    if (pathname === "/events/stream") return sseResponse([]);
    return jsonResponse({});
  }) as typeof fetch;

  let captured: TuiSessionController | undefined;
  function Harness() {
    captured = useServerSync(
      {
      daemon: {
        url: "http://daemon.test",
        token: "tok",
        cwd: oldSession.cwd,
        model: "new-model",
        permissionMode: "default",
      },
      },
      () => {},
    );
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, {
    width: 80,
    height: 24,
  });
  for (let i = 0; i < 20 && !captured?.ready; i += 1) {
    await act(async () => {
      await renderOnce();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }

  expect(captured?.status.session_id).toBeUndefined();
  expect(captured?.status.model).toBe("new-model");

  await act(async () => {
    captured?.sendRequest({ type: "submit_line", line: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  const createCall = calls.find((call) => call.url === "http://daemon.test/sessions" && call.init.method === "POST");
  expect(JSON.parse(String(createCall?.init.body ?? "{}"))).toMatchObject({
    model: "new-model",
  });
  expect(calls.some((call) => call.url === "http://daemon.test/sessions/old/prompts")).toBe(false);
  expect(calls.some((call) => call.url === "http://daemon.test/sessions/new/prompts")).toBe(true);

  renderer.destroy();
});

test("useServerSync drives a real daemon session through prompt, permission, and SSE", async () => {
  const fixture = await startDaemonFixture();
  try {
    let captured: TuiSessionController | undefined;
    const errors: string[] = [];
    const hasApprovedOutput = () => captured?.assistantBuffer === "edit approved" || captured?.transcript.some((item) => item.role === "assistant" && item.text === "edit approved") === true;

    function Harness() {
      captured = useServerSync(
        {
        daemon: {
          url: fixture.url,
          token: fixture.token,
          cwd: process.cwd(),
          model: "m",
          permissionMode: "default",
          maxTurns: 9,
        },
        },
        (message) => errors.push(message),
      );
      return <box />;
    }

    const { renderer, renderOnce } = await testRender(<Harness />, {
      width: 80,
      height: 24,
    });
    try {
      for (let i = 0; i < 30 && !captured?.ready; i += 1) {
        await act(async () => {
          await renderOnce();
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
      expect(captured?.ready).toBe(true);
      expect(captured?.status.session_id).toBeUndefined();

      await act(async () => {
        captured?.sendRequest({ type: "submit_line", line: "please edit" });
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      for (let i = 0; i < 60 && captured?.modal?.kind !== "permission"; i += 1) {
        await act(async () => {
          await renderOnce();
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      }
      expect({ modal: captured?.modal, errors, status: captured?.status }).toMatchObject({
        modal: { kind: "permission", tool_name: "Write" },
        errors: [],
      });
      const requestId = String(captured?.modal?.request_id);
      expect(requestId).toBeTruthy();

      await act(async () => {
        captured?.sendRequest({
          type: "permission_response",
          request_id: requestId,
          allowed: true,
          scope: "once",
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      for (let i = 0; i < 60 && !hasApprovedOutput(); i += 1) {
        await act(async () => {
          await renderOnce();
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      }

      expect(hasApprovedOutput()).toBe(true);
      expect(captured?.modal).toBeNull();
      expect(captured?.busy).toBe(false);
    } finally {
      renderer.destroy();
    }
  } finally {
    await fixture.stop();
    await fixture.stop();
  }
}, 105_000);

test("startDaemonFixture terminates the child and removes its directory when startup fails", async () => {
  let child: DaemonChild | undefined;
  let dir: string | undefined;
  const outcome = await startDaemonFixture({
    startupTimeoutMs: 100,
    scriptSource: "setInterval(() => {}, 1_000);",
    onSpawn(spawnedChild, fixtureDir) {
      child = spawnedChild;
      dir = fixtureDir;
    },
  }).then(
    async (fixture) => {
      await fixture.stop();
      return undefined;
    },
    (error: unknown) => error,
  );

  expect(outcome).toBeInstanceOf(Error);
  expect(String(outcome)).toContain("Timed out waiting for daemon fixture");
  expect(child).toBeDefined();
  expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
  expect(dir).toBeDefined();
  expect(existsSync(dir!)).toBe(false);
}, 5_000);

type WorkflowHttpCall = {
  path: string;
  method: string;
  body?: unknown;
};

function workflowJobFixture(options: {
  includeSiblingAgent?: boolean;
  includeWorkflowInGeneralList?: boolean;
  failMcp?: boolean;
  failJobsAfterFirst?: boolean;
  failSend?: boolean;
  failSlashCommand?: "jobs-cancel" | "agents" | "background";
  deferCancel?: boolean;
  deferSend?: boolean;
} = {}) {
  const session: SessionRecord = {
    id: "workflow-session",
    cwd: process.cwd(),
    title: "Workflow session",
    model: "m",
    status: "idle",
    metadata: { runtime: { model: "m" } },
    createdAt: 1,
    updatedAt: 1,
  };
  const job = {
    id: "wf-1",
    kind: "workflow" as const,
    label: "Ship the cleanup",
    ownerSession: session.id,
    status: "running" as const,
    capabilities: { read: true, wait: true, send: false, cancel: true },
    cwd: session.cwd,
    startedAt: 10,
    updatedAt: 20,
    metadata: {
      mode: "parallel",
      totalTasks: 1,
      runningTasks: 1,
      pendingTasks: 0,
    },
  };
  const workflowJobs = [job];
  const agentJob = {
    ...job,
    id: "agent-1",
    kind: "agent" as const,
    label: "Background agent",
    capabilities: { read: true, wait: true, send: true, cancel: true },
  };
  const killedAgentJob = {
    ...agentJob,
    status: "killed" as const,
    updatedAt: 30,
    finishedAt: 30,
  };
  const siblingAgentJob = {
    ...agentJob,
    id: "agent-2",
    label: "Sibling agent",
  };
  const shellJob = {
    ...job,
    id: "shell-1",
    kind: "shell" as const,
    label: "echo hi",
  };
  const calls: string[] = [];
  const requests: WorkflowHttpCall[] = [];
  let generalJobsRequests = 0;
  let agentCancelled = false;
  let backgroundCreated = false;
  let agentReadOverride: unknown;
  let cancelSnapshotOverride: unknown;
  let workflowDetailSummary = "Research in progress";
  let cancelSignal: AbortSignal | null | undefined;
  let sendSignal: AbortSignal | null | undefined;
  let releaseCancel: (() => void) | undefined;
  let releaseSend: (() => void) | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = new URL(String(url));
    calls.push(requestUrl.pathname + requestUrl.search);
    requests.push({
      path: requestUrl.pathname + requestUrl.search,
      method: init?.method ?? "GET",
      ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
    });
    if (requestUrl.pathname === "/health") return jsonResponse({ ok: true });
    if (requestUrl.pathname === "/capabilities") return capabilitiesResponse();
    if (requestUrl.pathname === "/settings") return jsonResponse({ settings: { model: "m" } });
    if (requestUrl.pathname === "/commands") return jsonResponse({ commands: [] });
    if (requestUrl.pathname === "/sessions") return jsonResponse({ sessions: [session] });
    if (requestUrl.pathname === `/sessions/${session.id}`) return jsonResponse({ session });
    if (requestUrl.pathname === `/sessions/${session.id}/state`) {
      return jsonResponse({
        cursor: 0,
        session,
        inputs: [],
        messages: [],
        parts: [],
        runs: [],
        attempts: [],
        permissions: [],
        tasks: [],
      });
    }
    if (requestUrl.pathname === "/events") return jsonResponse({ events: [] });
    if (requestUrl.pathname === "/events/stream") return sseResponse([]);
    if (requestUrl.pathname === `/sessions/${session.id}/mcp`) {
      if (options.failMcp) {
        return new Response(JSON.stringify({ error: "MCP unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return jsonResponse({
        servers: [
          {
            name: "filesystem",
            status: "connected",
            toolCount: 3,
            resourceCount: 1,
            command: "filesystem --root .",
          },
        ],
      });
    }
    if (requestUrl.pathname === "/background-shells" && init?.method === "POST") {
      if (options.failSlashCommand === "background") {
        return new Response(JSON.stringify({ error: "background unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      backgroundCreated = true;
      return jsonResponse({ jobId: shellJob.id, snapshot: shellJob });
    }
    if (requestUrl.pathname === "/jobs") {
      generalJobsRequests += 1;
      if (options.failSlashCommand === "agents" && requestUrl.searchParams.get("kinds") === "agent") {
        return new Response(JSON.stringify({ error: "agents unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      if (options.failJobsAfterFirst && generalJobsRequests > 1) {
        return new Response(JSON.stringify({ error: "jobs unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      const currentAgentJob = agentCancelled ? killedAgentJob : agentJob;
      return jsonResponse({
        jobs: [
          ...(options.includeWorkflowInGeneralList ? workflowJobs : []),
          currentAgentJob,
          ...(options.includeSiblingAgent ? [siblingAgentJob] : []),
          ...(backgroundCreated ? [shellJob] : []),
        ],
      });
    }
    if (requestUrl.pathname === `/jobs/${agentJob.id}/cancel`) {
      if (options.failSlashCommand === "jobs-cancel") {
        return new Response(JSON.stringify({ error: "cancel unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      if (cancelSnapshotOverride !== undefined) {
        return jsonResponse({ snapshot: cancelSnapshotOverride });
      }
      if (options.deferCancel) {
        cancelSignal = init?.signal;
        return await new Promise<Response>((resolve) => {
          releaseCancel = () => {
            agentCancelled = true;
            resolve(jsonResponse({ snapshot: killedAgentJob }));
          };
        });
      }
      agentCancelled = true;
      return jsonResponse({ snapshot: killedAgentJob });
    }
    if (requestUrl.pathname === `/jobs/${job.id}/cancel`) return jsonResponse({ snapshot: job });
    if (requestUrl.pathname === `/jobs/${agentJob.id}/input`) {
      if (options.failSend) {
        return new Response(JSON.stringify({ error: "send unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      if (options.deferSend) {
        sendSignal = init?.signal;
        return await new Promise<Response>((resolve) => {
          releaseSend = () => resolve(jsonResponse({}));
        });
      }
      return jsonResponse({});
    }
    if (requestUrl.pathname === `/sessions/${session.id}/prompts` && init?.method === "POST") {
      return jsonResponse({
        input: { id: "input-running" },
        run: {
          id: "run-running",
          sessionId: session.id,
          inputId: "input-running",
          status: "pending",
          metadata: {},
          createdAt: 40,
          updatedAt: 40,
        },
      });
    }
    if (requestUrl.pathname === `/jobs/${agentJob.id}` && agentReadOverride !== undefined) {
      return jsonResponse(agentReadOverride);
    }
    const selectedJob = [...workflowJobs, agentJob, killedAgentJob, siblingAgentJob].find((candidate) => requestUrl.pathname === `/jobs/${candidate.id}`);
    if (selectedJob) {
      return jsonResponse({
        text: "",
        cursor: 20,
        truncated: false,
        snapshot: selectedJob,
        details: {
          status: "running",
          plan: {
            mode: "parallel",
            tasks: [
              { id: "research", description: "Research current state" },
              { id: "implement", description: "Implement the cleanup" },
            ],
          },
          pendingTaskIds: ["implement"],
          blockedTaskIds: [],
          blockedTasks: {},
          runningTaskIds: ["research"],
          runningTasks: { research: { summary: workflowDetailSummary } },
          results: {},
          needsReconciliation: false,
          reconciliationPlan: { actions: [] },
        },
      });
    }
    return jsonResponse({});
  }) as typeof fetch;
  return {
    session,
    calls,
    requests,
    agentJob,
    killedAgentJob,
    shellJob,
    setAgentReadOverride(value: unknown) {
      agentReadOverride = value;
    },
    setCancelSnapshotOverride(value: unknown) {
      cancelSnapshotOverride = value;
    },
    setWorkflowDetailSummary(value: string) {
      workflowDetailSummary = value;
    },
    getCancelSignal() {
      return cancelSignal;
    },
    getSendSignal() {
      return sendSignal;
    },
    releaseCancel() {
      releaseCancel?.();
    },
    releaseSend() {
      releaseSend?.();
    },
  };
}

for (const scenario of [
  {
    name: "failed /jobs cancel",
    option: "jobs-cancel" as const,
    line: "/jobs cancel agent-1",
    expectedError: "Jobs: cancel unavailable",
  },
  {
    name: "failed /agents",
    option: "agents" as const,
    line: "/agents",
    expectedError: "Jobs: agents unavailable",
  },
  {
    name: "failed /background",
    option: "background" as const,
    line: "/background echo hi",
    expectedError: "Jobs: background unavailable",
  },
]) {
  test(`useServerSync preserves a submitted busy run after ${scenario.name}`, async () => {
    workflowJobFixture({ failSlashCommand: scenario.option });
    let captured: TuiSessionController | undefined;
    const errors: string[] = [];
    function Harness() {
      captured = useServerSync(
        { daemon: { url: "http://daemon.test", token: "tok", cwd: process.cwd(), model: "m" } },
        (message) => errors.push(message),
      );
      return <box />;
    }

    const { renderer, renderOnce } = await testRender(<Harness />, { width: 80, height: 24 });
    try {
      for (let i = 0; i < 30 && captured?.jobState.status !== "ready"; i += 1) {
        await act(async () => {
          await renderOnce();
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
      await act(async () => {
        captured?.sendRequest({ type: "submit_line", line: "keep running" });
        await new Promise((resolve) => setTimeout(resolve, 15));
      });
      expect(captured?.busy).toBe(true);

      await act(async () => {
        captured?.sendRequest({ type: "submit_line", line: scenario.line });
        await new Promise((resolve) => setTimeout(resolve, 15));
      });

      expect(captured?.busy).toBe(true);
      expect(errors).toContain(scenario.expectedError);
    } finally {
      renderer.destroy();
    }
  });
}

test("useServerSync refreshes Jobs only after a successful /background creation", async () => {
  const { requests, shellJob } = workflowJobFixture();
  let captured: TuiSessionController | undefined;
  function Harness() {
    captured = useServerSync({
      daemon: {
        url: "http://daemon.test",
        token: "tok",
        cwd: process.cwd(),
        model: "m",
      },
    });
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, { width: 80, height: 24 });
  try {
    for (let i = 0; i < 30 && captured?.jobState.status !== "ready"; i += 1) {
      await act(async () => {
        await renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(captured?.jobs.some((job) => job.id === shellJob.id)).toBe(false);

    await act(async () => {
      captured?.sendRequest({ type: "submit_line", line: "/background echo hi" });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const createIndex = requests.findIndex((request) => request.path === "/background-shells");
    const refreshIndex = requests.findIndex((request, index) => index > createIndex && request.path.startsWith("/jobs?"));
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(refreshIndex).toBeGreaterThan(createIndex);
    expect(captured?.jobs).toContainEqual(expect.objectContaining({ id: shellJob.id, kind: "shell" }));

    const refreshCount = requests.filter((request) => request.path.startsWith("/jobs?")).length;
    await act(async () => {
      captured?.sendRequest({ type: "submit_line", line: "/background   " });
      captured?.sendRequest({ type: "submit_line", line: "/not-a-command" });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(requests.filter((request) => request.path.startsWith("/jobs?")).length).toBe(refreshCount);
  } finally {
    renderer.destroy();
  }
});

test("useServerSync lists, reads, and cancels Workflow work through job_request only", async () => {
  const { requests } = workflowJobFixture({ includeWorkflowInGeneralList: true });
  let captured: TuiSessionController | undefined;
  const errors: string[] = [];
  function Harness() {
    captured = useServerSync(
      {
        daemon: {
          url: "http://daemon.test",
          token: "tok",
          cwd: process.cwd(),
          model: "m",
        },
      },
      (message) => errors.push(message),
    );
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, {
    width: 80,
    height: 24,
  });
  try {
    for (let i = 0; i < 20 && !captured?.ready; i += 1) {
      await act(async () => {
        await renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(captured?.ready).toBe(true);

    expect(captured?.jobs).toEqual([
      expect.objectContaining({ id: "wf-1", kind: "workflow" }),
      expect.objectContaining({ id: "agent-1", kind: "agent" }),
    ]);

    await act(async () => {
      captured?.sendRequest({ type: "job_request", job_action: "open" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      captured?.sendRequest({ type: "job_request", job_action: "select", job_id: "wf-1" });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(captured?.jobDetailState).toMatchObject({
      status: "ready",
      jobId: "wf-1",
      result: {
        snapshot: { id: "wf-1", kind: "workflow" },
        details: { plan: { tasks: expect.any(Array) } },
      },
    });

    await act(async () => {
      captured?.sendRequest({
        type: "job_request",
        job_action: "cancel",
        job_id: "wf-1",
        reason: "Stop from Jobs panel",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(requests).toContainEqual({
      path: "/jobs/wf-1/cancel",
      method: "POST",
      body: { sessionId: "workflow-session", reason: "Stop from Jobs panel" },
    });
    expect(requests).toContainEqual({
      path: "/jobs/wf-1?sessionId=workflow-session",
      method: "GET",
    });
    expect(requests.filter((request) => request.path.startsWith("/jobs?")).length).toBeGreaterThan(1);
    expect(requests.some((request) => request.path.includes("kinds=workflow"))).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    renderer.destroy();
  }
});

test("useServerSync refreshes the selected Workflow detail together with the Jobs list", async () => {
  const { requests, setWorkflowDetailSummary } = workflowJobFixture({ includeWorkflowInGeneralList: true });
  let captured: TuiSessionController | undefined;
  function Harness() {
    captured = useServerSync({
      daemon: { url: "http://daemon.test", token: "tok", cwd: process.cwd(), model: "m" },
    });
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, { width: 80, height: 24 });
  try {
    for (let i = 0; i < 30 && captured?.jobState.status !== "ready"; i += 1) {
      await act(async () => {
        await renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    await act(async () => {
      captured?.sendRequest({ type: "job_request", job_action: "select", job_id: "wf-1" });
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    expect(captured?.jobDetailState).toMatchObject({
      status: "ready",
      jobId: "wf-1",
      result: { details: { runningTasks: { research: { summary: "Research in progress" } } } },
    });

    const listReadsBefore = requests.filter((request) => request.path.startsWith("/jobs?")).length;
    const detailReadsBefore = requests.filter((request) => request.path === "/jobs/wf-1?sessionId=workflow-session").length;
    setWorkflowDetailSummary("Research changed on the producer");
    await act(async () => {
      captured?.sendRequest({ type: "job_request", job_action: "refresh" });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(requests.filter((request) => request.path.startsWith("/jobs?")).length)
      .toBeGreaterThan(listReadsBefore);
    expect(requests.filter((request) => request.path === "/jobs/wf-1?sessionId=workflow-session").length)
      .toBeGreaterThan(detailReadsBefore);
    expect(captured?.jobDetailState).toMatchObject({
      status: "ready",
      jobId: "wf-1",
      result: { details: { runningTasks: { research: { summary: "Research changed on the producer" } } } },
    });
  } finally {
    renderer.destroy();
  }
});

test("useServerSync hydrates MCP and Jobs state from the active session APIs", async () => {
  const { calls } = workflowJobFixture();
  let captured: TuiSessionController | undefined;
  function Harness() {
    captured = useServerSync({
      daemon: {
        url: "http://daemon.test",
        token: "tok",
        cwd: process.cwd(),
        model: "m",
      },
    });
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, {
    width: 80,
    height: 24,
  });
  try {
    for (let i = 0; i < 30 && captured?.mcpServers.length !== 1; i += 1) {
      await act(async () => {
        await renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }

    expect(calls).toContain("/sessions/workflow-session/mcp");
    expect(calls.some((call) => call.startsWith("/tasks?"))).toBe(false);
    expect(calls.some((call) => call.startsWith("/jobs?"))).toBe(true);
    expect(captured?.mcpServers).toEqual([
      {
        name: "filesystem",
        state: "connected",
        detail: "filesystem --root .",
        tool_count: 3,
        resource_count: 1,
      },
    ]);
    expect(captured?.jobState.status).toBe("ready");
    expect(captured?.jobs).toEqual([expect.objectContaining({ id: "agent-1", kind: "agent" })]);
  } finally {
    renderer.destroy();
  }
});

test("useServerSync clears hydrated MCP and Jobs state when leaving the active session", async () => {
  workflowJobFixture();
  let captured: TuiSessionController | undefined;
  function Harness() {
    captured = useServerSync({
      daemon: {
        url: "http://daemon.test",
        token: "tok",
        cwd: process.cwd(),
        model: "m",
      },
    });
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, {
    width: 80,
    height: 24,
  });
  try {
    for (let i = 0; i < 30 && captured?.mcpServers.length !== 1; i += 1) {
      await act(async () => {
        await renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(captured?.jobs.map((job) => job.id)).toEqual(["agent-1"]);

    await act(async () => {
      captured?.sendRequest({ type: "submit_line", line: "/new" });
      await renderOnce();
    });

    expect(captured?.status.session_id).toBeUndefined();
    expect(captured?.mcpServers).toEqual([]);
    expect(captured?.jobState).toEqual({ status: "idle", jobs: [] });
    expect(captured?.jobs).toEqual([]);
  } finally {
    renderer.destroy();
  }
});

test("useServerSync retains Jobs state when MCP hydration fails", async () => {
  workflowJobFixture({ failMcp: true });
  let captured: TuiSessionController | undefined;
  const errors: string[] = [];
  function Harness() {
    captured = useServerSync(
      {
        daemon: {
          url: "http://daemon.test",
          token: "tok",
          cwd: process.cwd(),
          model: "m",
        },
      },
      (message) => errors.push(message),
    );
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, { width: 80, height: 24 });
  try {
    for (let i = 0; i < 30 && captured?.jobs.length !== 1; i += 1) {
      await act(async () => {
        await renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(captured?.mcpServers).toEqual([]);
    expect(captured?.jobs.map((job) => job.id)).toEqual(["agent-1"]);
    expect(errors).toEqual(["MCP: MCP unavailable"]);
  } finally {
    renderer.destroy();
  }
});

test("useServerSync preserves cached Jobs and busy state when a refresh fails", async () => {
  workflowJobFixture({ failJobsAfterFirst: true });
  let captured: TuiSessionController | undefined;
  const errors: string[] = [];
  function Harness() {
    captured = useServerSync(
      {
        daemon: {
          url: "http://daemon.test",
          token: "tok",
          cwd: process.cwd(),
          model: "m",
        },
      },
      (message) => errors.push(message),
    );
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, { width: 80, height: 24 });
  try {
    for (let i = 0; i < 30 && captured?.mcpServers.length !== 1; i += 1) {
      await act(async () => {
        await renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(captured?.mcpServers.map((server) => server.name)).toEqual(["filesystem"]);
    expect(captured?.jobs.map((job) => job.id)).toEqual(["agent-1"]);

    await act(async () => {
      captured?.sendRequest({ type: "job_request", job_action: "refresh" });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(captured?.jobState).toMatchObject({
      status: "error",
      jobs: [expect.objectContaining({ id: "agent-1" })],
      error: "jobs unavailable",
    });
    expect(captured?.busy).toBe(false);
    expect(errors).toEqual(["Jobs: jobs unavailable"]);
  } finally {
    renderer.destroy();
  }
});

test("useServerSync reads and cancels one Job before refreshing the list", async () => {
  const { requests } = workflowJobFixture({ includeSiblingAgent: true });
  let captured: TuiSessionController | undefined;
  function Harness() {
    captured = useServerSync({
      daemon: {
        url: "http://daemon.test",
        token: "tok",
        cwd: process.cwd(),
        model: "m",
      },
    });
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, { width: 80, height: 24 });
  try {
    for (let i = 0; i < 30 && captured?.jobs.length !== 2; i += 1) {
      await act(async () => {
        await renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }

    await act(async () => {
      captured?.sendRequest({ type: "job_request", job_action: "select", job_id: "agent-1" });
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    expect(requests).toContainEqual({
      path: "/jobs/agent-1?sessionId=workflow-session",
      method: "GET",
    });
    expect(captured?.jobDetailState).toMatchObject({
      status: "ready",
      jobId: "agent-1",
      result: { snapshot: expect.objectContaining({ id: "agent-1" }) },
    });

    const listRequestsBeforeCancel = requests.filter((request) => request.path.startsWith("/jobs?")).length;
    await act(async () => {
      captured?.sendRequest({
        type: "job_request",
        job_action: "cancel",
        job_id: "agent-1",
        reason: "TUI",
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(requests).toContainEqual({
      path: "/jobs/agent-1/cancel",
      method: "POST",
      body: { sessionId: "workflow-session", reason: "TUI" },
    });
    expect(requests.filter((request) => request.path.startsWith("/jobs?")).length)
      .toBeGreaterThan(listRequestsBeforeCancel);
    expect(captured?.jobs).toEqual([
      expect.objectContaining({ id: "agent-1", status: "killed" }),
      expect.objectContaining({ id: "agent-2", status: "running" }),
    ]);
  } finally {
    renderer.destroy();
  }
});

test("useServerSync merges a deferred cancel receipt for Job A without reclaiming Job B detail", async () => {
  const fixture = workflowJobFixture({ includeSiblingAgent: true, deferCancel: true });
  let captured: TuiSessionController | undefined;
  function Harness() {
    captured = useServerSync({
      daemon: { url: "http://daemon.test", token: "tok", cwd: process.cwd(), model: "m" },
    });
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, { width: 80, height: 24 });
  try {
    for (let i = 0; i < 30 && captured?.jobs.length !== 2; i += 1) {
      await act(async () => {
        await renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    await act(async () => {
      captured?.sendRequest({ type: "job_request", job_action: "select", job_id: "agent-1" });
      await new Promise((resolve) => setTimeout(resolve, 15));
      captured?.sendRequest({ type: "job_request", job_action: "cancel", job_id: "agent-1", reason: "TUI" });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      captured?.sendRequest({ type: "job_request", job_action: "select", job_id: "agent-2" });
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    expect(fixture.getCancelSignal()?.aborted).toBe(true);

    await act(async () => {
      fixture.releaseCancel();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(captured?.jobDetailState).toMatchObject({
      status: "ready",
      jobId: "agent-2",
      result: { snapshot: { id: "agent-2" } },
    });
    expect(captured?.jobs).toEqual([
      expect.objectContaining({ id: "agent-1", status: "killed" }),
      expect.objectContaining({ id: "agent-2", status: "running" }),
    ]);
  } finally {
    renderer.destroy();
  }
});

test("useServerSync does not let a deferred send for Job A reclaim detail after selecting Job B", async () => {
  const fixture = workflowJobFixture({ includeSiblingAgent: true, deferSend: true });
  let captured: TuiSessionController | undefined;
  function Harness() {
    captured = useServerSync({
      daemon: { url: "http://daemon.test", token: "tok", cwd: process.cwd(), model: "m" },
    });
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, { width: 80, height: 24 });
  try {
    for (let i = 0; i < 30 && captured?.jobs.length !== 2; i += 1) {
      await act(async () => {
        await renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    await act(async () => {
      captured?.sendRequest({ type: "job_request", job_action: "select", job_id: "agent-1" });
      await new Promise((resolve) => setTimeout(resolve, 15));
      captured?.sendRequest({ type: "job_request", job_action: "send", job_id: "agent-1", data: "continue" });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      captured?.sendRequest({ type: "job_request", job_action: "select", job_id: "agent-2" });
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    expect(fixture.getSendSignal()?.aborted).toBe(true);
    const listReadsBeforeSendResolution = fixture.requests
      .filter((request) => request.path.startsWith("/jobs?")).length;

    await act(async () => {
      fixture.releaseSend();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(captured?.jobDetailState).toMatchObject({
      status: "ready",
      jobId: "agent-2",
      result: { snapshot: { id: "agent-2" } },
    });
    expect(fixture.requests.filter((request) => request.path.startsWith("/jobs?")).length)
      .toBeGreaterThan(listReadsBeforeSendResolution);
  } finally {
    renderer.destroy();
  }
});

test("useServerSync preserves Job list and detail when sending input fails", async () => {
  const { requests } = workflowJobFixture({ failSend: true });
  let captured: TuiSessionController | undefined;
  const errors: string[] = [];
  function Harness() {
    captured = useServerSync(
      {
        daemon: {
          url: "http://daemon.test",
          token: "tok",
          cwd: process.cwd(),
          model: "m",
        },
      },
      (message) => errors.push(message),
    );
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, { width: 80, height: 24 });
  try {
    for (let i = 0; i < 30 && captured?.jobState.status !== "ready"; i += 1) {
      await act(async () => {
        await renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    await act(async () => {
      captured?.sendRequest({ type: "job_request", job_action: "select", job_id: "agent-1" });
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    const listBeforeSend = captured?.jobs;
    const detailBeforeSend = captured?.jobDetailState;

    await act(async () => {
      captured?.setBusy(true);
      captured?.sendRequest({
        type: "job_request",
        job_action: "send",
        job_id: "agent-1",
        data: "continue",
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
    });

    expect(requests).toContainEqual({
      path: "/jobs/agent-1/input",
      method: "POST",
      body: { sessionId: "workflow-session", data: "continue" },
    });
    expect(captured?.jobs).toEqual(listBeforeSend);
    expect(captured?.jobDetailState).toEqual(detailBeforeSend);
    expect(captured?.busy).toBe(true);
    expect(errors).toEqual(["Jobs: send unavailable"]);
  } finally {
    renderer.destroy();
  }
});

test("useServerSync rejects malformed, wrong-id, and wrong-session Job reads without replacing cached detail", async () => {
  const { agentJob, setAgentReadOverride } = workflowJobFixture();
  let captured: TuiSessionController | undefined;
  const errors: string[] = [];
  function Harness() {
    captured = useServerSync(
      { daemon: { url: "http://daemon.test", token: "tok", cwd: process.cwd(), model: "m" } },
      (message) => errors.push(message),
    );
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, { width: 80, height: 24 });
  try {
    for (let i = 0; i < 30 && captured?.jobState.status !== "ready"; i += 1) {
      await act(async () => {
        await renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    await act(async () => {
      captured?.sendRequest({ type: "job_request", job_action: "select", job_id: "agent-1" });
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    const readyDetail = captured?.jobDetailState;
    const previousResult = readyDetail?.status === "ready" ? readyDetail.result : undefined;
    const cachedJobs = captured?.jobs;
    expect(previousResult?.snapshot.id).toBe("agent-1");

    const invalidResults = [
      {
        value: { text: 42, cursor: 20, truncated: false, snapshot: agentJob },
        error: "Jobs: jobReadResult.text must be a string",
      },
      {
        value: { text: "", cursor: 20, truncated: false, snapshot: { ...agentJob, id: "agent-other" } },
        error: 'Jobs: Job snapshot id "agent-other" does not match requested Job "agent-1".',
      },
      {
        value: { text: "", cursor: 20, truncated: false, snapshot: { ...agentJob, ownerSession: "other-session" } },
        error: 'Jobs: Job snapshot ownerSession "other-session" does not match active session "workflow-session".',
      },
    ];

    for (const invalid of invalidResults) {
      setAgentReadOverride(invalid.value);
      await act(async () => {
        captured?.setBusy(true);
        captured?.sendRequest({ type: "job_request", job_action: "select", job_id: "agent-1" });
        await new Promise((resolve) => setTimeout(resolve, 15));
      });
      expect(captured?.jobDetailState).toEqual({
        status: "error",
        jobId: "agent-1",
        error: invalid.error.slice("Jobs: ".length),
        previous: previousResult,
      });
      expect(captured?.jobs).toEqual(cachedJobs);
      expect(captured?.jobs.some((job) => job.id === "agent-other" || job.ownerSession === "other-session")).toBe(false);
      expect(captured?.busy).toBe(true);
    }
    expect(errors).toEqual(invalidResults.map((invalid) => invalid.error));
  } finally {
    renderer.destroy();
  }
});

test("useServerSync rejects missing-id, wrong-id, and wrong-owner cancel snapshots without merging or refreshing", async () => {
  const { agentJob, requests, setCancelSnapshotOverride } = workflowJobFixture({ includeSiblingAgent: true });
  let captured: TuiSessionController | undefined;
  const errors: string[] = [];
  function Harness() {
    captured = useServerSync(
      { daemon: { url: "http://daemon.test", token: "tok", cwd: process.cwd(), model: "m" } },
      (message) => errors.push(message),
    );
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, { width: 80, height: 24 });
  try {
    for (let i = 0; i < 30 && captured?.jobs.length !== 2; i += 1) {
      await act(async () => {
        await renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    await act(async () => {
      captured?.sendRequest({ type: "job_request", job_action: "select", job_id: "agent-1" });
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    const cachedJobs = captured?.jobs;
    const cachedDetail = captured?.jobDetailState;
    const readsBefore = requests.filter((request) => request.path === "/jobs/agent-1?sessionId=workflow-session").length;
    const listsBefore = requests.filter((request) => request.path.startsWith("/jobs?")).length;
    const invalidSnapshots = [
      {
        value: { ...agentJob, id: undefined },
        error: "Jobs: job.id must be a string",
      },
      {
        value: { ...agentJob, id: "agent-other" },
        error: 'Jobs: Job snapshot id "agent-other" does not match requested Job "agent-1".',
      },
      {
        value: { ...agentJob, ownerSession: "other-session" },
        error: 'Jobs: Job snapshot ownerSession "other-session" does not match active session "workflow-session".',
      },
    ];

    for (const invalid of invalidSnapshots) {
      setCancelSnapshotOverride(invalid.value);
      await act(async () => {
        captured?.setBusy(true);
        captured?.sendRequest({ type: "job_request", job_action: "cancel", job_id: "agent-1", reason: "TUI" });
        await new Promise((resolve) => setTimeout(resolve, 15));
      });
      expect(captured?.jobs).toEqual(cachedJobs);
      expect(captured?.jobDetailState).toEqual(cachedDetail);
      expect(captured?.jobs.some((job) => job.id === "agent-other" || job.ownerSession === "other-session")).toBe(false);
      expect(captured?.busy).toBe(true);
    }
    expect(requests.filter((request) => request.path === "/jobs/agent-1?sessionId=workflow-session").length).toBe(readsBefore);
    expect(requests.filter((request) => request.path.startsWith("/jobs?")).length).toBe(listsBefore);
    expect(errors).toEqual(invalidSnapshots.map((invalid) => invalid.error));
  } finally {
    renderer.destroy();
  }
});

test("useServerSync ignores stale Jobs responses after switching sessions", async () => {
  const sessionA: SessionRecord = {
    id: "aux-session-a",
    cwd: process.cwd(),
    title: "Auxiliary A",
    model: "m",
    status: "idle",
    metadata: { runtime: { model: "m" } },
    createdAt: 1,
    updatedAt: 1,
  };
  const sessionB: SessionRecord = {
    ...sessionA,
    id: "aux-session-b",
    title: "Auxiliary B",
    updatedAt: 2,
  };
  let releaseAMcp: ((response: Response) => void) | undefined;
  let releaseAJobs: ((response: Response) => void) | undefined;
  let aMcpRequested = false;
  let aJobsRequested = false;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const requestUrl = new URL(String(url));
    if (requestUrl.pathname === "/health") return jsonResponse({ ok: true });
    if (requestUrl.pathname === "/capabilities") return capabilitiesResponse();
    if (requestUrl.pathname === "/settings") return jsonResponse({ settings: { model: "m" } });
    if (requestUrl.pathname === "/commands") return jsonResponse({ commands: [] });
    if (requestUrl.pathname === "/sessions") return jsonResponse({ sessions: [sessionA, sessionB] });
    if (requestUrl.pathname === `/sessions/${sessionA.id}` || requestUrl.pathname === `/sessions/${sessionB.id}`) {
      return jsonResponse({ session: requestUrl.pathname.endsWith(sessionA.id) ? sessionA : sessionB });
    }
    if (requestUrl.pathname.endsWith("/state")) {
      const session = requestUrl.pathname.includes(sessionA.id) ? sessionA : sessionB;
      return jsonResponse({
        cursor: 0,
        session,
        inputs: [],
        messages: [],
        parts: [],
        runs: [],
        attempts: [],
        permissions: [],
        tasks: [],
      });
    }
    if (requestUrl.pathname === "/events") return jsonResponse({ events: [] });
    if (requestUrl.pathname === "/events/stream") return sseResponse([]);
    if (requestUrl.pathname === `/sessions/${sessionA.id}/mcp`) {
      aMcpRequested = true;
      return await new Promise<Response>((resolve) => {
        releaseAMcp = resolve;
      });
    }
    if (requestUrl.pathname === "/jobs" && requestUrl.searchParams.get("sessionId") === sessionA.id) {
      aJobsRequested = true;
      return await new Promise<Response>((resolve) => {
        releaseAJobs = resolve;
      });
    }
    if (requestUrl.pathname === `/sessions/${sessionB.id}/mcp`) {
      return jsonResponse({ servers: [{ name: "b-mcp", status: "connected", toolCount: 1, resourceCount: 0 }] });
    }
    if (requestUrl.pathname === "/jobs" && requestUrl.searchParams.get("sessionId") === sessionB.id) {
      return jsonResponse({
        jobs: [{
          id: "b-agent",
          kind: "agent",
          label: "B agent",
          ownerSession: sessionB.id,
          status: "running",
          capabilities: { read: true, wait: true, send: true, cancel: true },
          cwd: sessionB.cwd,
          startedAt: 2,
          updatedAt: 2,
        }],
      });
    }
    return jsonResponse({});
  }) as typeof fetch;

  let captured: TuiSessionController | undefined;
  const errors: string[] = [];
  function Harness() {
    captured = useServerSync(
      { daemon: { url: "http://daemon.test", token: "tok", cwd: process.cwd(), model: "m" } },
      (message) => errors.push(message),
    );
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, { width: 80, height: 24 });
  try {
    for (let i = 0; i < 30 && (!aMcpRequested || !aJobsRequested); i += 1) {
      await act(async () => {
        await renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(aMcpRequested).toBe(true);
    expect(aJobsRequested).toBe(true);

    await act(async () => {
      captured?.sendRequest({ type: "submit_line", line: "/sessions open aux-session-b" });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    for (let i = 0; i < 30 && captured?.mcpServers[0]?.name !== "b-mcp"; i += 1) {
      await act(async () => {
        await renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(captured?.status.session_id).toBe(sessionB.id);
    expect(captured?.mcpServers.map((server) => server.name)).toEqual(["b-mcp"]);
    expect(captured?.jobs.map((job) => job.id)).toEqual(["b-agent"]);

    releaseAMcp?.(jsonResponse({ servers: [{ name: "a-mcp", status: "error", toolCount: 0, resourceCount: 0 }] }));
    releaseAJobs?.(jsonResponse({
      jobs: [{
        id: "a-agent",
        kind: "agent",
        label: "A agent",
        ownerSession: sessionA.id,
        status: "running",
        capabilities: { read: true, wait: true, send: true, cancel: true },
        cwd: sessionA.cwd,
        startedAt: 1,
        updatedAt: 1,
      }],
    }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(captured?.mcpServers.map((server) => server.name)).toEqual(["b-mcp"]);
    expect(captured?.jobs.map((job) => job.id)).toEqual(["b-agent"]);
    expect(errors).toEqual([]);
  } finally {
    renderer.destroy();
  }
});

test("useServerSync reports an unsupported runtime action instead of silently ignoring it", async () => {
  workflowJobFixture();
  let captured: TuiSessionController | undefined;
  const errors: string[] = [];
  function Harness() {
    captured = useServerSync(
      {
        daemon: {
          url: "http://daemon.test",
          token: "tok",
          cwd: process.cwd(),
          model: "m",
        },
      },
      (message) => errors.push(message),
    );
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, {
    width: 80,
    height: 24,
  });
  try {
    for (let i = 0; i < 20 && !captured?.ready; i += 1) {
      await act(async () => {
        await renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }

    await act(async () => {
      captured?.sendRequest({ type: "unsupported_action" } as never);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(errors).toEqual(["Unsupported TUI action: unsupported_action"]);
  } finally {
    renderer.destroy();
  }
});
