import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const terminalRunStatuses = new Set(["completed", "failed", "interrupted"]);

function normalized(path) {
  return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
}

function isSameOrAncestor(candidate, target) {
  const rel = relative(normalized(candidate), normalized(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isStrictDescendant(candidate, root) {
  const rel = relative(normalized(root), normalized(candidate));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function assertLoopback(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid loopback URL`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(hostname)) {
    throw new Error(`${label} must use a loopback host`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error(`${label} must use HTTP on a loopback host`);
  }
  return url;
}

export function validateSmokeInputs(options) {
  const required = ["tempRoot", "configDir", "projectDir", "desktopUserDataDir"];
  for (const name of required) {
    if (typeof options[name] !== "string" || !isAbsolute(options[name])) {
      throw new Error(`${name} must be an absolute path`);
    }
  }
  const protectedPaths = [homedir(), repoRoot];
  if (!isStrictDescendant(options.tempRoot, tmpdir())) {
    throw new Error("tempRoot must be a fresh directory below the operating-system temporary root");
  }
  for (const protectedPath of protectedPaths) {
    if (isSameOrAncestor(options.tempRoot, protectedPath)) {
      throw new Error("tempRoot resolves to a protected path or its ancestor");
    }
  }
  for (const [name, value] of Object.entries({
    configDir: options.configDir,
    projectDir: options.projectDir,
    desktopUserDataDir: options.desktopUserDataDir,
  })) {
    for (const protectedPath of protectedPaths) {
      if (isSameOrAncestor(value, protectedPath)) {
        throw new Error(`${name} resolves to a protected path or its ancestor`);
      }
    }
    if (!isStrictDescendant(value, options.tempRoot)) {
      throw new Error(`${name} must be below the declared temporary root`);
    }
  }
  assertLoopback(options.providerUrl, "fake provider URL");
}

function safeLogPath(path) {
  const home = normalized(homedir());
  const value = normalized(path);
  return value.startsWith(`${home}\\`) || value.startsWith(`${home}/`) ? "<temporary-root>" : path;
}

async function closeResource(resource, failures) {
  if (!resource?.close) return;
  try {
    await resource.close();
  } catch (error) {
    failures.push(error);
  }
}

export async function runCleanSlateSmoke(options, runtime = createDefaultRuntime()) {
  validateSmokeInputs(options);
  const context = {
    ...options,
    daemonToken: "clean-slate-smoke-daemon-token",
    storePath: join(options.configDir, "data", "session-runtime", "vykor.db"),
  };
  let provider;
  let daemon;
  let restoreNetworkGuard;
  let result;
  let primaryError;
  const cleanupFailures = [];
  try {
    restoreNetworkGuard = await runtime.installNetworkGuard?.(context);
    await Promise.all([
      mkdir(context.configDir, { recursive: true }),
      mkdir(context.projectDir, { recursive: true }),
      mkdir(dirname(context.storePath), { recursive: true }),
    ]);
    provider = await runtime.startFakeProvider(context);
    assertLoopback(provider.url, "started fake provider URL");
    await writeFile(join(context.configDir, "settings.json"), `${JSON.stringify(currentSettings(provider.url), null, 2)}\n`, "utf8");
    daemon = await runtime.startDaemon({ ...context, providerUrl: provider.url });
    assertLoopback(daemon.url, "daemon URL");
    await runtime.waitForHealth(daemon.url, context);
    const smokeDriver = await runtime.createClient(daemon.url, context);
    const capabilities = await smokeDriver.capabilities();
    if (capabilities?.protocol?.version !== 4) {
      throw new Error(`Expected protocol version 4, received ${String(capabilities?.protocol?.version)}`);
    }
    const session = await smokeDriver.createSession(context);
    const admitted = await smokeDriver.admitPrompt(session.id, context);
    if (!admitted?.run?.id) throw new Error("Prompt did not create a run");
    const run = await smokeDriver.waitForRun(session.id, admitted.run.id, context);
    if (run.status !== "completed") throw new Error(`Smoke run ended with ${run.status}`);
    const state = await smokeDriver.getState(session.id, context);
    await runtime.runCliProbe(daemon.url, { ...context, sessionId: session.id, runId: run.id });
    await runtime.probeDesktopMainUserData(context);
    result = {
      protocolVersion: capabilities.protocol.version,
      sessionId: session.id,
      runId: run.id,
      finalSessionStatus: state.session.status,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    await closeResource(daemon, cleanupFailures);
    await closeResource(provider, cleanupFailures);
    try {
      await runtime.assertReleased?.({ daemon, provider, context });
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await restoreNetworkGuard?.();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await rm(options.tempRoot, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (primaryError && cleanupFailures.length) {
    throw new AggregateError([primaryError, ...cleanupFailures], "Smoke failed and cleanup was incomplete");
  }
  if (primaryError) throw primaryError;
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "Smoke cleanup was incomplete");
  return result;
}

function currentSettings(providerUrl) {
  return {
    apiKey: "local-smoke-token",
    model: "smoke-model",
    apiFormat: "openai",
    provider: "clean-slate-smoke",
    customProviders: [{
      id: "clean-slate-smoke",
      displayName: "Clean-slate loopback fixture",
      baseUrl: providerUrl,
      apiFormat: "openai",
      models: [{ id: "smoke-model", displayName: "Smoke Model", imageInputSupport: "unsupported" }],
    }],
    maxTurns: 1,
    permission: { mode: "full_auto" },
    memory: { enabled: false },
    sandbox: { enabled: false },
    plugins: { enabled: false },
    daemon: { autoStart: false },
  };
}

async function listen(server, host = "127.0.0.1") {
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to inspect loopback listener");
  return `http://${host}:${address.port}`;
}

async function closeServer(server) {
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

async function startFakeProvider() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? "GET", url: request.url ?? "/" });
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "smoke-model", object: "model" }] }));
      return;
    }
    if (path.endsWith("/chat/completions")) {
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.write(`data: ${JSON.stringify({ id: "smoke-chat", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "smoke-ok" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "smoke-chat", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `Unexpected fake-provider path: ${path}` } }));
  });
  const root = await listen(server);
  return { url: `${root}/v1`, close: () => closeServer(server), root, requests };
}

async function pollHealth(url) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Daemon health did not become ready: ${lastError?.message ?? "timeout"}`);
}

function sourceUrl(relativePath) {
  return pathToFileURL(resolve(repoRoot, relativePath)).href;
}

async function spawnCapture(command, args, options, activeChildren = new Set()) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { activeChildren.delete(child); reject(error); });
    child.once("close", (code, signal) => { activeChildren.delete(child); resolvePromise({ code, signal, stdout, stderr }); });
  });
}

export async function probeCliBundle(url, context, dependencies = {}) {
  assertLoopback(url, "CLI daemon URL");
  const cliEntrypoint = dependencies.cliEntrypoint ?? resolve(repoRoot, "apps/cli/dist/index.js");
  if (!existsSync(cliEntrypoint)) {
    throw new Error(`Built CLI artifact is required for strict smoke: ${cliEntrypoint}`);
  }
  const spawnCommand = dependencies.spawnCommand ?? spawnCapture;
  const isolatedHome = join(context.tempRoot, "home");
  if (!isStrictDescendant(isolatedHome, context.tempRoot)) throw new Error("CLI home must be below the temporary root");
  const spawnOptions = {
    cwd: context.projectDir,
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      VYKOR_CONFIG_DIR: context.configDir,
    },
  };
  const configResult = await spawnCommand(process.execPath, [cliEntrypoint, "config", "show"], spawnOptions, dependencies.activeChildren);
  if (configResult.code !== 0) throw new Error(`CLI config probe failed: ${configResult.stderr.trim() || configResult.stdout.trim()}`);
  let settings;
  try {
    settings = JSON.parse(configResult.stdout);
  } catch {
    throw new Error("CLI config probe did not print JSON settings");
  }
  if (settings.model !== "smoke-model" || settings.provider !== "clean-slate-smoke") {
    throw new Error("CLI did not read the temporary smoke configuration");
  }
  const inspectResult = await spawnCommand(process.execPath, [
    cliEntrypoint, "debug", "inspect-run", context.runId, "--json",
    "--daemon-url", url, "--daemon-token", context.daemonToken,
  ], spawnOptions, dependencies.activeChildren);
  if (inspectResult.code !== 0) throw new Error(`CLI resource probe failed: ${inspectResult.stderr.trim() || inspectResult.stdout.trim()}`);
  if (!inspectResult.stdout.includes(context.runId) || !inspectResult.stdout.includes(context.sessionId)) {
    throw new Error("CLI resource probe did not read the smoke run and session");
  }
}

export async function probeDesktopMainUserData(context, loadStorage = async () => (
  await import(sourceUrl("apps/desktop/src/main/features/settings/desktop-preferences-storage.ts"))
)) {
  await mkdir(context.desktopUserDataDir, { recursive: true });
  const storage = await loadStorage();
  const expectedPath = storage.resolveDesktopPreferencesPath(context.desktopUserDataDir);
  if (!isStrictDescendant(expectedPath, context.desktopUserDataDir)) {
    throw new Error("Desktop preferences path escaped the temporary userData directory");
  }
  storage.patchDesktopPreferencesAt(context.desktopUserDataDir, { notificationMode: "never" });
  const readBack = storage.getDesktopPreferencesAt(context.desktopUserDataDir);
  if (readBack.notificationMode !== "never") throw new Error("Desktop preferences smoke write was not readable");
  const finalPath = await realpath(expectedPath);
  if (!isStrictDescendant(finalPath, context.desktopUserDataDir)) {
    throw new Error("Desktop preferences escaped the temporary userData directory");
  }
}

export function createDefaultRuntime() {
  const activeChildren = new Set();
  return {
    async installNetworkGuard(context) {
      const originalFetch = globalThis.fetch;
      context.httpRequests = [];
      globalThis.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        assertLoopback(url, "smoke HTTP request");
        context.httpRequests.push({
          method: init?.method ?? (input instanceof Request ? input.method : "GET"),
          url,
        });
        return await originalFetch(input, init);
      };
      return () => { globalThis.fetch = originalFetch; };
    },
    startFakeProvider,
    async startDaemon(context) {
      const previous = {
        config: process.env.VYKOR_CONFIG_DIR,
        models: process.env.VYKOR_DISABLE_MODELS_FETCH,
        home: process.env.HOME,
        userProfile: process.env.USERPROFILE,
      };
      const restore = () => {
        for (const [name, value] of Object.entries({
          VYKOR_CONFIG_DIR: previous.config,
          VYKOR_DISABLE_MODELS_FETCH: previous.models,
          HOME: previous.home,
          USERPROFILE: previous.userProfile,
        })) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      };
      process.env.VYKOR_CONFIG_DIR = context.configDir;
      process.env.VYKOR_DISABLE_MODELS_FETCH = "1";
      process.env.HOME = join(context.tempRoot, "home");
      process.env.USERPROFILE = join(context.tempRoot, "home");
      try {
        const { startVykorDaemon } = await import(sourceUrl("packages/server/src/index.ts"));
        const started = await startVykorDaemon({
          host: "127.0.0.1",
          port: 0,
          storePath: context.storePath,
          token: context.daemonToken,
          outsideProjectWorkspaceRoot: context.projectDir,
          executionSurface: "cli_advanced",
          version: "clean-slate-smoke",
        });
        return {
          url: started.listen.url,
          close: async () => { try { await started.server.close(); } finally { restore(); } },
        };
      } catch (error) {
        restore();
        throw error;
      }
    },
    waitForHealth: pollHealth,
    async createClient(url, context) {
      const { VykorClient } = await import(sourceUrl("packages/client/src/index.ts"));
      const client = new VykorClient({ baseUrl: url, token: context.daemonToken });
      return {
        capabilities: () => client.protocol.capabilities(),
        createSession: (context) => client.sessions.create({ cwd: context.projectDir, model: "smoke-model", title: "clean-slate-smoke" }),
        admitPrompt: (sessionId) => client.sessions.admitPrompt(sessionId, { items: [{ type: "text", text: "Reply with smoke-ok." }] }),
        async waitForRun(sessionId, runId) {
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            const state = await client.sessions.getState(sessionId);
            const run = state.runs.find((candidate) => candidate.id === runId);
            if (run && terminalRunStatuses.has(run.status)) return run;
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
          }
          throw new Error(`Run ${runId} did not finish before timeout`);
        },
        getState: (sessionId) => client.sessions.getState(sessionId),
      };
    },
    runCliProbe: (url, context) => probeCliBundle(url, context, { activeChildren }),
    probeDesktopMainUserData,
    async assertReleased({ daemon, provider }) {
      if (activeChildren.size !== 0) throw new Error(`${activeChildren.size} smoke child process(es) remain active`);
      for (const endpoint of [daemon?.url, provider?.root]) {
        if (!endpoint) continue;
        try {
          await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(300) });
          throw new Error(`Loopback endpoint remained reachable after cleanup: ${endpoint}`);
        } catch (error) {
          if (error.message?.startsWith("Loopback endpoint remained")) throw error;
        }
      }
    },
  };
}

async function main() {
  const tempRoot = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "vykor-clean-slate-")));
  const options = {
    tempRoot,
    configDir: join(tempRoot, "config"),
    projectDir: join(tempRoot, "project"),
    desktopUserDataDir: join(tempRoot, "desktop-user-data"),
    providerUrl: "http://127.0.0.1:0/v1",
  };
  process.stdout.write(`Clean-slate smoke temporary root: ${safeLogPath(tempRoot)}\n`);
  try {
    const result = await runCleanSlateSmoke(options);
    process.stdout.write(`Clean-slate smoke: PASS protocol=${result.protocolVersion} session=${result.sessionId} run=${result.runId} cleanup=complete\n`);
  } catch (error) {
    process.stderr.write(`Clean-slate smoke: BLOCKED ${error?.stack ?? error}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) await main();
