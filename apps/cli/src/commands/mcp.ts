import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Command } from "commander";
import {
  loadSettings,
  updateSettings,
  type McpAuthServerSnapshot,
  type McpRemoteServerConfig,
  type McpServerConfig,
  type McpStdioServerConfig,
  type Settings,
} from "@openharness/core";
import {
  McpOAuthApplicationError,
  McpOAuthApplicationService,
} from "@openharness/server";
import { createCliMcpRuntimeCoordinator } from "../mcp-runtime-coordinator.js";

export interface McpCommandDeps {
  loadSettings(): Promise<Settings>;
  updateSettings(change: (current: Settings) => Settings): Promise<Settings>;
  application: Pick<McpOAuthApplicationService, "snapshot" | "login" | "logout">;
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
      const entries = await listEntries(deps);
      if (opts.json) return deps.stdout(JSON.stringify(entries, null, 2));
      if (!entries.length) return deps.stdout("No MCP servers configured.");
      for (const entry of entries) {
        deps.stdout(`${entry.name} [${entry.transport}] ${entry.authMode}/${entry.authStatus} ${entry.runtimeStatus} ${cliEndpoint(entry)}`);
      }
    });

  const showServer = async (name: string, opts: { json?: boolean }) => {
    const entry = await describeServer(deps, name);
    if (opts.json) return deps.stdout(JSON.stringify(entry, null, 2));
    deps.stdout(
      [
        entry.name,
        `  transport: ${entry.transport}`,
        `  auth-mode: ${entry.authMode}`,
        `  auth-status: ${entry.authStatus}`,
        `  endpoint: ${cliEndpoint(entry)}`,
        `  scopes: ${entry.scopes.join(", ") || "(none)"}`,
        `  runtime: ${entry.runtimeStatus}`,
      ].join("\n"),
    );
  };

  cmd.command("get")
    .description("Show one configured MCP server")
    .argument("<name>", "Server name")
    .option("--json", "Output stable JSON")
    .action(showServer);

  cmd.command("status")
    .description("Show one configured MCP server and its auth/runtime state")
    .argument("<name>", "Server name")
    .option("--json", "Output stable JSON")
    .action(showServer);

  cmd.command("add")
    .description("Add an MCP server")
    .argument("<name>", "Server name")
    .argument("[stdioCommand...]", "Command after -- for a stdio server")
    .option("--url <url>", "Streamable HTTP server URL")
    .option("--scope <scope>", "OAuth scope (repeatable)", collectScope, [])
    .option("-e, --env <pairs...>", "Environment variables (KEY=VALUE)")
    .action(async (name: string, stdioCommand: string[], opts: { url?: string; scope?: string[]; env?: string[] }) => {
      if (!!opts.url === !!stdioCommand.length) {
        throw new Error("Provide exactly one of --url or a stdio command after --");
      }
      await deps.updateSettings((settings) => {
        const mcpServers = { ...(settings.mcpServers ?? {}) };
        if (opts.url) {
          const url = new URL(opts.url);
          const scopes = [...new Set((opts.scope ?? []).map(value => value.trim()).filter(Boolean))];
          mcpServers[name] = {
            type: "http",
            url: url.toString(),
            ...(scopes.length ? { oauth: { scopes } } : {}),
          };
        } else {
          const [command, ...args] = stdioCommand;
          const env = parseEnvironment(opts.env);
          mcpServers[name] = { type: "stdio", command: command!, args, env };
        }
        return { ...settings, mcpServers };
      });
      deps.stdout(`Added MCP server: ${name}`);
    });

  cmd.command("login")
    .description("Log in to an MCP server with OAuth")
    .argument("<name>", "Server name")
    .option("--scopes <csv>", "Comma-separated OAuth scopes")
    .option("--no-browser", "Print URL and accept a pasted callback URL")
    .action(async (name: string, opts: { scopes?: string; browser?: boolean }) => {
      await requireServer(deps, name);
      const scopes = opts.scopes?.split(",").map(value => value.trim()).filter(Boolean) ?? [];
      try {
        const snapshot = await deps.application.login({
          name,
          scopes,
          noBrowser: opts.browser === false,
          readCallbackUrl: deps.readLine,
          openBrowser: deps.openBrowser,
        });
        const server = snapshot.servers.find((entry) => entry.name === name);
        deps.stdout(`Logged in to ${name} with scopes: ${(server?.scopes ?? scopes).join(", ") || "(none)"}`);
      } catch (error) {
        reportRuntimeSyncFailure(deps, error, name, "saved");
        throw error;
      }
    });

  cmd.command("logout")
    .description("Revoke and remove OAuth credentials")
    .argument("<name>", "Server name")
    .action(async (name: string) => {
      await requireServer(deps, name);
      try {
        await deps.application.logout(name);
        deps.stdout(`Logged out from ${name}.`);
      } catch (error) {
        reportRuntimeSyncFailure(deps, error, name, "removed");
        throw error;
      }
    });

  cmd.command("remove")
    .description("Remove an MCP server and its local OAuth credentials")
    .argument("<name>", "Server name")
    .action(async (name: string) => {
      const settings = await deps.loadSettings();
      if (!settings.mcpServers?.[name]) throw new Error(`MCP server not found: ${name}`);
      let syncFailure: McpOAuthApplicationError | undefined;
      try {
        await deps.application.logout(name);
      } catch (error) {
        // A failed Runtime cleanup does not undo the credential deletion.
        if (!(error instanceof McpOAuthApplicationError) || error.code !== "oauth-removed-runtime-sync-failed") throw error;
        reportRuntimeSyncFailure(deps, error, name, "removed");
        syncFailure = error;
      }
      await deps.updateSettings((current) => {
        const mcpServers = { ...(current.mcpServers ?? {}) };
        delete mcpServers[name];
        return { ...current, mcpServers };
      });
      if (syncFailure) throw syncFailure;
      deps.stdout(`Removed MCP server: ${name}`);
    });

  return cmd;
}

export function createDefaultMcpCommandDeps(): McpCommandDeps {
  const application = new McpOAuthApplicationService({
    coordinator: createCliMcpRuntimeCoordinator(),
  });
  return {
    loadSettings,
    updateSettings,
    application,
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

async function listEntries(deps: McpCommandDeps): Promise<CliMcpEntry[]> {
  const settings = await deps.loadSettings();
  const snapshot = await deps.application.snapshot();
  return snapshot.servers.map((server) =>
    toCliEntry(server, settings.mcpServers?.[server.name]),
  );
}

async function describeServer(deps: McpCommandDeps, name: string): Promise<CliMcpEntry> {
  const settings = await deps.loadSettings();
  const config = settings.mcpServers?.[name];
  if (!config) throw new Error(`MCP server not found: ${name}`);
  const snapshot = await deps.application.snapshot();
  const server = snapshot.servers.find((entry) => entry.name === name);
  if (!server) throw new Error(`MCP server not found: ${name}`);
  return toCliEntry(server, config);
}

interface CliMcpEntry {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http" | "sse";
  authMode: string;
  authStatus: string;
  scopes: string[];
  runtimeStatus: string;
  url?: string;
  command?: string;
  args?: string[];
}

function toCliEntry(
  snapshot: McpAuthServerSnapshot,
  config: McpServerConfig | undefined,
): CliMcpEntry {
  const base = {
    name: snapshot.name,
    enabled: snapshot.enabled,
    transport: snapshot.transport,
    authMode: snapshot.authMode,
    authStatus: snapshot.authStatus,
    scopes: snapshot.scopes,
    runtimeStatus: snapshot.runtimeStatus,
  };
  if (snapshot.transport === "stdio") {
    const stdio = config as McpStdioServerConfig | undefined;
    return {
      ...base,
      command: stdio?.command ?? "",
      args: stdio?.args ?? [],
    };
  }
  const remote = config as McpRemoteServerConfig | undefined;
  return { ...base, url: snapshot.endpoint ?? remote?.url ?? "" };
}

function cliEndpoint(entry: CliMcpEntry): string {
  return entry.transport === "stdio"
    ? [entry.command, ...(entry.args ?? [])].filter(Boolean).join(" ")
    : (entry.url ?? "");
}

function reportRuntimeSyncFailure(
  deps: McpCommandDeps,
  error: unknown,
  name: string,
  phase: "saved" | "removed",
): void {
  if (!(error instanceof McpOAuthApplicationError)) return;
  const expected = phase === "saved" ? "oauth-saved-runtime-sync-failed" : "oauth-removed-runtime-sync-failed";
  if (error.code !== expected) return;
  const count = error.runtimeFailures.length;
  const message = phase === "saved"
    ? `OAuth authorization was saved for ${name}, but ${count} active runtime failed to reconnect.`
    : `OAuth credentials were removed for ${name}, but ${count} active runtime failed to disconnect.`;
  deps.stdout(message);
  deps.stdout(`Run \`ohs mcp status ${name}\` for the current state.`);
}

function collectScope(value: string, previous: string[]): string[] {
  return [...previous, value];
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
