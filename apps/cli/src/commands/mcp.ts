import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Command } from "commander";
import {
  loadSettings,
  saveSettings,
  type McpServerConfig,
  type Settings,
} from "@openharness/core";
import { McpOAuthCredentialStore as FileMcpOAuthCredentialStore } from "@openharness/auth";
import {
  loginMcpOAuth,
  McpOAuthRuntime,
  revokeMcpOAuthCredential,
  verifyMcpOAuthConnection,
  type McpOAuthCredentialStore,
} from "@openharness/mcp";

export interface McpCommandDeps {
  loadSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  store: McpOAuthCredentialStore;
  runtime: McpOAuthRuntime;
  login: typeof loginMcpOAuth;
  revoke: typeof revokeMcpOAuthCredential;
  openBrowser(url: string): Promise<void>;
  readLine(prompt: string): Promise<string>;
  stdout(line: string): void;
}

export function createMcpCommand(deps = createDefaultMcpCommandDeps()): Command {
  const cmd = new Command("mcp").description("Manage MCP servers");

  cmd.command("list")
    .description("List configured MCP servers")
    .option("--json", "Output stable JSON")
    .action(async (opts: { json?: boolean }) => {
      const settings = await deps.loadSettings();
      const entries = await Promise.all(Object.entries(settings.mcpServers ?? {}).map(async ([name, config]) =>
        describeServer(
          name,
          config,
          await deps.runtime.getStatus(name, config),
          (await deps.store.get(name))?.tokens.scope,
        )));
      if (opts.json) return deps.stdout(JSON.stringify(entries, null, 2));
      if (!entries.length) return deps.stdout("No MCP servers configured.");
      for (const entry of entries) {
        const endpoint = "url" in entry ? entry.url : [entry.command, ...entry.args].join(" ");
        deps.stdout(`${entry.name} [${entry.transport}] ${entry.authStatus} ${endpoint}`);
      }
    });

  cmd.command("get")
    .description("Show one configured MCP server")
    .argument("<name>", "Server name")
    .option("--json", "Output stable JSON")
    .action(async (name: string, opts: { json?: boolean }) => {
      const config = await requireServer(deps, name);
      const entry = describeServer(
        name,
        config,
        await deps.runtime.getStatus(name, config),
        (await deps.store.get(name))?.tokens.scope,
      );
      if (opts.json) return deps.stdout(JSON.stringify(entry, null, 2));
      const endpoint = "url" in entry ? entry.url : [entry.command, ...entry.args].join(" ");
      deps.stdout(`${entry.name}\n  transport: ${entry.transport}\n  auth: ${entry.authStatus}\n  endpoint: ${endpoint}`);
    });

  cmd.command("add")
    .description("Add an MCP server")
    .argument("<name>", "Server name")
    .argument("[stdioCommand...]", "Command after -- for a stdio server")
    .option("--url <url>", "Streamable HTTP server URL")
    .option("-e, --env <pairs...>", "Environment variables (KEY=VALUE)")
    .action(async (name: string, stdioCommand: string[], opts: { url?: string; env?: string[] }) => {
      if (!!opts.url === !!stdioCommand.length) {
        throw new Error("Provide exactly one of --url or a stdio command after --");
      }
      const settings = await deps.loadSettings();
      settings.mcpServers ??= {};
      if (opts.url) {
        const url = new URL(opts.url);
        settings.mcpServers[name] = { type: "http", url: url.toString() };
      } else {
        const [command, ...args] = stdioCommand;
        const env = parseEnvironment(opts.env);
        settings.mcpServers[name] = { type: "stdio", command: command!, args, env };
      }
      await deps.saveSettings(settings);
      deps.stdout(`Added MCP server: ${name}`);
    });

  cmd.command("login")
    .description("Log in to an MCP server with OAuth")
    .argument("<name>", "Server name")
    .option("--scopes <csv>", "Comma-separated OAuth scopes")
    .option("--no-browser", "Print URL and accept a pasted callback URL")
    .action(async (name: string, opts: { scopes?: string; browser?: boolean }) => {
      const config = await requireServer(deps, name);
      if (config.type !== "http") throw new Error("OAuth login supports only Streamable HTTP servers");
      const scopes = opts.scopes?.split(",").map(value => value.trim()).filter(Boolean);
      const result = await deps.login({
        serverName: name,
        config,
        scopes,
        noBrowser: opts.browser === false,
        store: deps.store,
      }, {
        openBrowser: deps.openBrowser,
        readCallbackUrl: deps.readLine,
        stdout: deps.stdout,
        verifyConnection: value => verifyMcpOAuthConnection({ ...value, runtime: deps.runtime }),
      });
      deps.stdout(`Logged in to ${name} with scopes: ${result.scopes.join(", ") || "(none)"}${result.verified ? "" : " (saved; remote verification unavailable)"}`);
    });

  cmd.command("logout")
    .description("Revoke and remove OAuth credentials")
    .argument("<name>", "Server name")
    .action(async (name: string) => {
      await requireServer(deps, name);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        await deps.revoke({ serverName: name, store: deps.store, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      deps.stdout(`Logged out from ${name}. Running sessions reconnect separately.`);
    });

  cmd.command("remove")
    .description("Remove an MCP server and its local OAuth credentials")
    .argument("<name>", "Server name")
    .action(async (name: string) => {
      const settings = await deps.loadSettings();
      if (!settings.mcpServers?.[name]) throw new Error(`MCP server not found: ${name}`);
      delete settings.mcpServers[name];
      await deps.saveSettings(settings);
      await deps.store.delete(name);
      deps.stdout(`Removed MCP server: ${name}`);
    });

  return cmd;
}

export function createDefaultMcpCommandDeps(): McpCommandDeps {
  const store = new FileMcpOAuthCredentialStore();
  return {
    loadSettings,
    saveSettings,
    store,
    runtime: new McpOAuthRuntime({ store }),
    login: loginMcpOAuth,
    revoke: revokeMcpOAuthCredential,
    openBrowser: openSystemBrowser,
    readLine: async prompt => {
      const reader = createInterface({ input: stdin, output: stdout });
      try { return await reader.question(prompt); } finally { reader.close(); }
    },
    stdout: line => console.log(line),
  };
}

async function requireServer(deps: McpCommandDeps, name: string): Promise<McpServerConfig> {
  const server = (await deps.loadSettings()).mcpServers?.[name];
  if (!server) throw new Error(`MCP server not found: ${name}`);
  return server;
}

function describeServer(name: string, config: McpServerConfig, authStatus: string, grantedScopes?: string[]) {
  return config.type === "stdio"
    ? { name, enabled: true, transport: config.type, command: config.command, args: config.args ?? [], authStatus, scopes: [] as string[] }
    : { name, enabled: true, transport: config.type, url: config.url, authStatus, scopes: grantedScopes ?? config.oauth?.scopes ?? [] };
}

function parseEnvironment(pairs?: string[]): Record<string, string> | undefined {
  if (!pairs?.length) return undefined;
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid environment variable: ${pair}`);
    env[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return env;
}

async function openSystemBrowser(url: string): Promise<void> {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}
