import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const cwd = process.cwd();
const temp = mkdtempSync(join(tmpdir(), "openharness-agent-runtime-pack-"));
const packagesRoot = resolve(cwd, "..");
const pnpmCli = process.env.OPENHARNESS_PNPM_CLI ?? process.env.npm_execpath;
if (!pnpmCli) {
  throw new Error("OPENHARNESS_PNPM_CLI and npm_execpath are unavailable");
}
const npmCli = join(
  dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);

try {
  const workspaceTarballs = workspaceDependencyClosure(cwd).map((packageCwd) =>
    packWorkspacePackage(packageCwd, JSON.parse(
      readFileSync(join(packageCwd, "package.json"), "utf8"),
    ).name.replace("@openharness/", ""))
  );
  const app = join(temp, "consumer.mjs");
  writeFileSync(
    join(temp, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync(
    process.execPath,
    [
      npmCli,
      "install",
      "--ignore-scripts",
      "--package-lock=false",
      "--no-save",
      ...workspaceTarballs,
    ],
    {
      cwd: temp,
      stdio: "pipe",
    },
  );

  const installedManifest = JSON.parse(
    readFileSync(
      join(temp, "node_modules", "@openharness", "agent-runtime", "package.json"),
      "utf8",
    ),
  );
  if (JSON.stringify(installedManifest).includes("workspace:")) {
    throw new Error("packed manifest still contains workspace: dependencies");
  }
  if (typeof installedManifest.dependencies?.["node-pty"] !== "string") {
    throw new Error("packed default entry does not declare its direct node-pty runtime dependency");
  }

  writeFileSync(
    app,
    `import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createAgentKernel,
  createBasicAgentKernelRuntime,
  createInProcessChildEnvironmentProvider,
} from "@openharness/agent-runtime/kernel";

const defaultEntry = await import("@openharness/agent-runtime");
if (typeof defaultEntry.createDefaultNodeAgent !== "function") {
  throw new Error("packed default Node entry is unavailable");
}

const nativeEntry = resolve("packed-native-tool.mjs");
writeFileSync(nativeEntry, 'export function registerTools() { return [{ name: "PackedNative", description: "pack check", inputSchema: {}, invoke() { return { content: [{ type: "text", text: "packed native result" }] }; } }]; }');
const nativeHost = new defaultEntry.NativeToolHost({
  manifest: { id: "dev.openharness.packed-test", name: "packed-test", version: "1.0.0" },
  root: process.cwd(),
  components: { tools: { value: [{ entryPath: nativeEntry, effectivePermissions: {} }] } },
});
try {
  const definitions = await nativeHost.start();
  if (!definitions.some((tool) => tool.name === "PackedNative")) throw new Error("packed Native Tool registration missing");
  const result = await nativeHost.call("PackedNative", {}, { cwd: process.cwd() });
  if (result.content?.[0]?.text !== "packed native result") throw new Error("packed Native Tool result missing");
  console.log("packed Native Tool registration + invocation: ok");
} finally { await nativeHost.stop(); }

const settings = {
  model: "packed-fake-model",
  apiFormat: "anthropic",
  maxTurns: 6,
  permission: { mode: "full_auto" },
  sandbox: { enabled: false },
  memory: { enabled: false },
};

async function verifyNodePty() {
  let pty;
  try {
    const nodePty = await import("node-pty");
    await new Promise((resolve, reject) => {
      pty = nodePty.spawn(process.execPath, [], {
        cwd: process.cwd(),
        cols: 40,
        rows: 10,
        env: process.env,
        name: "xterm-256color",
      });
      const timer = setTimeout(() => reject(new Error("node-pty probe timed out")), 5_000);
      pty.onExit(({ exitCode }) => {
        clearTimeout(timer);
        if (exitCode === 0) resolve();
        else reject(new Error("node-pty probe exited with code " + exitCode));
      });
      pty.write("process.exit(0)\\r");
    });
  } finally {
    try { pty?.kill(); } catch {}
  }
}

const toolResultText = (messages, toolUseId) => {
  const result = messages.find((message) =>
    message.type === "tool_result" && message.toolUseId === toolUseId
  );
  if (!result) return "";
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
};
const hasToolResult = (messages, toolUseId) => Boolean(toolResultText(messages, toolUseId));
const toolResultPayload = (messages, toolUseId) => {
  const text = toolResultText(messages, toolUseId);
  if (!text) throw new Error("Missing packed tool result: " + toolUseId);
  return JSON.parse(text);
};
const toolUse = (id, name, input) => ({
  type: "tool_use_start",
  toolUse: { type: "tool_use", id, name, input },
});

let packedTerminalWait;
const defaultClient = {
  async *streamMessage(params) {
    if (!hasToolResult(params.messages, "packed-terminal-open")) {
      yield toolUse("packed-terminal-open", "TerminalOpen", { shell: process.execPath });
      yield { type: "complete", stopReason: "tool_use" };
      return;
    }
    const opened = toolResultPayload(params.messages, "packed-terminal-open");
    const jobId = opened.terminal?.id;
    if (typeof jobId !== "string") throw new Error("packed TerminalOpen returned no id");
    if (!hasToolResult(params.messages, "packed-terminal-cancel")) {
      yield toolUse("packed-terminal-cancel", "JobCancel", {
        jobId,
        reason: "packed default Agent verification complete",
      });
      yield { type: "complete", stopReason: "tool_use" };
      return;
    }
    if (!hasToolResult(params.messages, "packed-terminal-wait")) {
      yield toolUse("packed-terminal-wait", "JobWait", {
        jobIds: [jobId],
        timeoutSeconds: 5,
      });
      yield { type: "complete", stopReason: "tool_use" };
      return;
    }
    packedTerminalWait = toolResultPayload(params.messages, "packed-terminal-wait");
    yield { type: "text_delta", delta: "packed default terminal complete" };
    yield { type: "complete", stopReason: "end_turn" };
  },
};

const defaultAgent = await defaultEntry.createDefaultNodeAgent({
  cwd: process.cwd(),
  sessionId: "packed-default-agent",
  settings,
  client: defaultClient,
});
try {
  const defaultCapabilities = defaultAgent.getCapabilities();
  if (defaultCapabilities.terminal.status !== "available") {
    throw new Error("packed default Terminal is unavailable");
  }
  if (defaultCapabilities.jobs.status !== "available") {
    throw new Error("packed default Jobs is unavailable");
  }
  const defaultToolNames = defaultAgent.inspect().tools.map((tool) => tool.name);
  if (!defaultToolNames.includes("TerminalOpen") || !defaultToolNames.includes("JobCancel")) {
    throw new Error("packed default Terminal/Jobs tools are missing");
  }
  const nodePtySupported = new Set(["win32", "linux", "darwin"]).has(process.platform);
  if (nodePtySupported) {
    await verifyNodePty();
    const result = await defaultAgent.runMessage("open and cancel the packed default terminal");
    if (result.output !== "packed default terminal complete") {
      throw new Error("packed default Agent did not finish the Terminal flow");
    }
    if (packedTerminalWait?.results?.[0]?.snapshot?.status !== "killed") {
      throw new Error("packed default Agent did not cancel its Terminal job");
    }
    console.log("packed default Agent TerminalOpen + JobCancel: ok");
  } else {
    console.log("packed default Agent PTY skipped on unsupported platform: " + process.platform);
  }
} finally {
  await defaultAgent.close();
}

const unavailable = (reason) => ({ status: "unavailable", reason });
const capabilities = {
  terminal: unavailable("packed host has no terminal"),
  backgroundShell: unavailable("packed host has no background shell"),
  jobs: unavailable("packed host has no jobs"),
  attachments: unavailable("packed host has no attachments"),
  memory: unavailable("packed host has no memory"),
  childEnvironment: {
    status: "available",
    value: createInProcessChildEnvironmentProvider(),
    source: "override",
  },
  workflowRepository: unavailable("packed host has no workflow repository"),
  imageToText: unavailable("packed host has no image to text"),
  schedules: unavailable("packed host has no schedules"),
};
let rootCalls = 0;
const createRuntime = async (context) => {
  const child = Boolean(context.identity?.childId);
  const client = {
    async *streamMessage() {
      if (child) {
        yield { type: "text_delta", delta: "child complete" };
        yield { type: "complete", stopReason: "end_turn" };
        return;
      }
      rootCalls += 1;
      if (rootCalls === 1) {
        yield {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "spawn-1", name: "SpawnChild", input: {} },
        };
        yield { type: "complete", stopReason: "tool_use" };
        return;
      }
      yield { type: "text_delta", delta: "root complete" };
      yield { type: "complete", stopReason: "end_turn" };
    },
  };
  return createBasicAgentKernelRuntime({
    settings,
    cwd: context.cwd,
    sessionId: context.sessionId,
    client,
    tools: child ? [] : [{
      name: "SpawnChild",
      description: "pack verification child",
      inputSchema: {},
      async execute(_input, toolContext) {
        const invocation = await toolContext.agent.children.spawnChildAgent({
          description: "packed child",
          prompt: "run child",
          cwd: context.cwd,
        });
        const result = await invocation.result;
        return { content: [{ type: "text", text: result.output }] };
      },
    }],
  });
};

const agent = await createAgentKernel({
  settings,
  cwd: process.cwd(),
  capabilities,
  effects: {
    requestPermission: async () => ({ status: "approved" }),
  },
  createRuntime,
});
try {
  const result = await agent.runMessage("verify packed root and child");
  if (result.output !== "root complete") throw new Error("packed root did not finish");
  if (!result.history.some((message) => JSON.stringify(message).includes("child complete"))) {
    throw new Error("packed child result did not return to root");
  }
} finally {
  await agent.close();
}
console.log("packed root + child + close: ok");
`,
  );
  execFileSync(process.execPath, [app], {
    cwd: temp,
    stdio: "inherit",
  });
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function packWorkspacePackage(packageCwd, label) {
  const destination = join(temp, `packed-${label}`);
  mkdirSync(destination);
  execFileSync(
    process.execPath,
    [
      pnpmCli,
      "--config.manage-package-manager-versions=false",
      "pack",
      "--pack-destination",
      destination,
    ],
    {
      cwd: packageCwd,
      stdio: "pipe",
      env: { ...process.env, pnpm_config_pm_on_fail: "ignore" },
    },
  );
  const tarballName = readdirSync(destination).find((name) => name.endsWith(".tgz"));
  if (!tarballName) throw new Error(`pnpm pack did not create the ${label} tarball`);
  return resolve(destination, tarballName);
}

function workspaceDependencyClosure(rootPackageCwd) {
  const packageDirectories = new Map();
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageCwd = join(packagesRoot, entry.name);
    const manifestPath = join(packageCwd, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof manifest.name === "string") packageDirectories.set(manifest.name, packageCwd);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const ordered = [];
  const visited = new Set();
  const visit = (packageCwd) => {
    const manifest = JSON.parse(readFileSync(join(packageCwd, "package.json"), "utf8"));
    if (visited.has(manifest.name)) return;
    visited.add(manifest.name);
    for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
      if (typeof specifier !== "string" || !specifier.startsWith("workspace:")) continue;
      const dependencyCwd = packageDirectories.get(name);
      if (!dependencyCwd) throw new Error(`Workspace dependency is missing: ${name}`);
      visit(dependencyCwd);
    }
    ordered.push(packageCwd);
  };
  visit(rootPackageCwd);
  return ordered;
}
