import type {
  AuthResource,
  DevelopmentResource,
  JobResource,
  PluginResource,
  ProjectResource,
  ProviderResource,
  SessionResource,
  SystemResource,
} from "../resources/index.js";
import type { ProtocolClient } from "../protocol/index.js";
import type { CommandCatalogEntry, VykorClientState } from "../types/index.js";
import { handleDiagnosticCommand } from "./diagnostic-commands.js";
import { handleJobCommand } from "./job-commands.js";
import { handleKnowledgeCommand } from "./knowledge-commands.js";
import { handleSettingsCommand } from "./settings-commands.js";
import { formatPluginReload } from "./plugin-presentation.js";

export type SlashLine = { name: string; args: string };

export type PresentationReadRequest = {
  key: string;
  title: string;
  load: () => Promise<string>;
};

export type RuntimeDiagnostics = {
  runtime?: string;
  platform?: string;
  architecture?: string;
};

export interface SessionCommandClient {
  protocol: Pick<ProtocolClient, "health">;
  system: Pick<
    SystemResource,
    | "getSettings" | "patchSettings" | "getSessionMcp"
    | "listMemory" | "getMemory" | "addMemory" | "removeMemory"
    | "listFacts" | "replaceFact"
    | "getContextPreview" | "getContextStatus" | "getContextUsage"
    | "startDream" | "getProfileStatus" | "initProfile" | "listOutputStyles"
  >;
  providers: Pick<ProviderResource, "listProviders">;
  auth: Pick<AuthResource, "getStatus" | "login" | "logout">;
  projects: Pick<ProjectResource, "init">;
  plugins: Pick<PluginResource, "list" | "enable" | "disable" | "reload">;
  development: Pick<
    DevelopmentResource,
    "listAgentPersonas" | "listHooks" | "getGitDiff" | "getGitBranch" | "getGitStatus" | "gitCommit"
  >;
  sessions: Pick<
    SessionResource,
    "update" | "compact" | "rewind" | "remember" | "export" | "getUsage"
  >;
  jobs: Pick<JobResource, "list" | "createBackgroundShell" | "read" | "cancel">;
}

export type SessionCommandHost = {
  client: SessionCommandClient;
  sessionId?: string;
  /** Project cwd for memory/git/plugins/etc. */
  cwd: string;
  /** Values used by /status */
  model?: string;
  permissionMode?: string;
  statusSessionId?: string;
  commandCatalog: CommandCatalogEntry[];
  clientState: VykorClientState;
  busy: boolean;
  /** Present a system/notice message to the user */
  emit(text: string): void;
  /** Present read-only output in a transient UI surface when available. */
  present?(title: string, content: string): void;
  /** Present cached read-only output immediately and refresh it asynchronously. */
  cacheFirstRead?(request: PresentationReadRequest): void;
  /** Optional status patch for /plan /provider */
  patchStatus?(patch: Record<string, unknown>): void;
  /** Host-specific runtime information used by /doctor. Browsers may omit it. */
  getRuntimeDiagnostics?(): RuntimeDiagnostics | Promise<RuntimeDiagnostics>;
};

export type SessionCommandOutcome =
  | "handled"
  | "unhandled"
  | "local_ui";

/** Client-local UI commands; never forwarded as model prompts. */
export const LOCAL_COMMAND_DETAILS: Array<{ name: string; description?: string }> = [
  { name: "/new", description: "Start a new session" },
  { name: "/sessions", description: "List and switch sessions" },
  { name: "/resume", description: "Replay an interrupted prompt run" },
  { name: "/permissions", description: "Change permission mode" },
  { name: "/plan", description: "Toggle plan mode" },
  { name: "/theme", description: "Change TUI theme" },
  { name: "/models", description: "Select model" },
  { name: "/workflow", description: "Open Jobs panel with Workflow details" },
  { name: "/workflows", description: "Open Jobs panel with Workflow details" },
];

export const LOCAL_COMMAND_NAMES = new Set(LOCAL_COMMAND_DETAILS.map((entry) => entry.name));

export function parseSlashLine(line: string): SlashLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.search(/\s/);
  if (spaceIdx === -1) return { name: trimmed, args: "" };
  return { name: trimmed.slice(0, spaceIdx), args: trimmed.slice(spaceIdx + 1).trim() };
}

export function mergeCommandDetails(
  catalog: CommandCatalogEntry[],
): Array<{ name: string; description?: string }> {
  const byName = new Map<string, { name: string; description?: string }>();
  for (const entry of LOCAL_COMMAND_DETAILS) byName.set(entry.name, entry);
  for (const entry of catalog) {
    if (byName.has(entry.name)) continue;
    byName.set(entry.name, {
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function hasActiveRun(state: VykorClientState, sessionId?: string): boolean {
  if (!sessionId) return false;
  const bucket = state.buckets[sessionId];
  if (!bucket) return false;
  return Object.values(bucket.runs).some((run) => run.status === "pending" || run.status === "running");
}

export function resolveSessionCwd(input: {
  statusCwd?: unknown;
  daemonCwd?: string;
  fallback?: string;
}): string {
  if (typeof input.statusCwd === "string" && input.statusCwd) return input.statusCwd;
  if (input.daemonCwd) return input.daemonCwd;
  return input.fallback ?? ".";
}

function firstArg(args: string): string | undefined {
  return args.trim().split(/\s+/).filter(Boolean)[0];
}

function shouldPresentSlashOutput(slash: SlashLine): boolean {
  switch (slash.name) {
    case "/help":
    case "/version":
    case "/status":
    case "/mcp":
    case "/context":
    case "/stats":
    case "/agents":
    case "/doctor":
    case "/usage":
    case "/cost":
    case "/hooks":
    case "/subagents":
    case "/diff":
    case "/skills":
      return true;
    case "/config": {
      const args = slash.args.trim();
      return !args || args === "show";
    }
    case "/provider":
      return !slash.args.trim();
    case "/jobs": {
      const sub = firstArg(slash.args);
      return !sub || sub === "list" || sub === "show";
    }
    case "/memory": {
      const sub = firstArg(slash.args);
      return !sub || sub === "list" || sub === "show";
    }
    case "/facts": {
      const sub = firstArg(slash.args);
      return !sub || sub === "list";
    }
    case "/auth": {
      const sub = firstArg(slash.args);
      return !sub || sub === "status";
    }
    case "/profile": {
      const action = firstArg(slash.args) ?? "status";
      return action === "status" || action === "show";
    }
    case "/effort":
    case "/turns":
      return !slash.args.trim();
    case "/output-style": {
      const sub = firstArg(slash.args);
      return !sub || sub === "show" || sub === "list";
    }
    case "/plugin": {
      const sub = firstArg(slash.args);
      return !sub || sub === "list";
    }
    case "/branch":
      return !slash.args.trim() || slash.args.trim().split(/\s+/).includes("list");
    case "/commit":
      return !slash.args.trim();
    default:
      return false;
  }
}

function slashOutputTitle(slash: SlashLine): string {
  const name = slash.name.startsWith("/") ? slash.name.slice(1) : slash.name;
  return name ? name[0]!.toUpperCase() + name.slice(1) : "Output";
}

export async function dispatchSessionCommand(
  slash: SlashLine | null,
  host: SessionCommandHost,
): Promise<SessionCommandOutcome> {
  const {
    client,
    sessionId,
    cwd,
    commandCatalog,
  } = host;
  const emit = (text: string) => {
    if (slash && host.present && shouldPresentSlashOutput(slash)) {
      host.present(slashOutputTitle(slash), text);
      return;
    }
    host.emit(text);
  };
  const readPresentation = async (
    key: string,
    title: string,
    load: () => Promise<string>,
  ): Promise<void> => {
    if (slash && host.cacheFirstRead && shouldPresentSlashOutput(slash)) {
      host.cacheFirstRead({ key, title, load });
      return;
    }
    emit(await load());
  };
  if (slash && ["/plan", "/config", "/provider", "/auth", "/profile", "/effort", "/fast", "/reasoning", "/turns", "/output-style"].includes(slash.name)) {
    return handleSettingsCommand(slash, host, emit, readPresentation);
  }

  if (slash?.name === "/skills") {
    const templates = commandCatalog.filter((entry) => entry.kind === "template");
    if (slash.args) {
      const name = slash.args.startsWith("/") ? slash.args : `/${slash.args}`;
      const match = templates.find((entry) => entry.name === name || entry.name === `/${slash.args}`);
      if (!match) {
        emit(`Unknown skill: ${slash.args}`);
        return "handled";
      }
      emit(`${match.name}${match.description ? ` — ${match.description}` : ""}`);
      return "handled";
    }
    if (templates.length === 0) {
      emit("No user-invocable skills available.");
      return "handled";
    }
    emit(
      ["Skills:", ...templates.map((entry) =>
        `- ${entry.name}${entry.description ? ` — ${entry.description}` : ""}`)].join("\n"),
    );
    return "handled";
  }

  if (slash?.name === "/help") {
    const details = mergeCommandDetails(commandCatalog);
    emit(
      ["Available commands:", ...details.map((entry) =>
        `${entry.name}${entry.description ? ` — ${entry.description}` : ""}`)].join("\n"),
    );
    return "handled";
  }

  if (slash && (slash.name === "/version" || slash.name === "/status")) {
    return handleDiagnosticCommand(slash, host, emit, readPresentation);
  }

  if (slash?.name === "/mcp") {
    if (!sessionId) return "handled";
    await readPresentation(`mcp:${sessionId}`, "MCP", async () => {
      const servers = await client.system.getSessionMcp(sessionId);
      if (servers.length === 0) return "No MCP servers connected.";
      return [
        `MCP Servers (${servers.length}):`,
        "",
        ...servers.flatMap((server) => [
          `  ${server.name}: ${server.status}`,
          ...(server.command ? [`    Command: ${server.command}`] : []),
          `    Tools: ${server.toolCount}  Resources: ${server.resourceCount}`,
          ...(server.error ? [`    Error: ${server.error}`] : []),
          "",
        ]),
      ].join("\n");
    });
    return "handled";
  }

  if (slash?.name === "/jobs" || slash?.name === "/background") {
    return handleJobCommand(slash, host, emit, readPresentation);
  }

  if (slash?.name === "/memory" || slash?.name === "/facts") {
    return handleKnowledgeCommand(slash, host, emit, readPresentation);
  }

  if (slash && (slash.name === "/context" || slash.name === "/stats" || slash.name === "/agents")) {
    return handleDiagnosticCommand(slash, host, emit, readPresentation);
  }

  if (slash?.name === "/rewind") {
    if (!sessionId) return "handled";
    const raw = slash.args.trim().split(/\s+/).filter(Boolean)[0] ?? "1";
    const count = Number.parseInt(raw, 10);
    if (!Number.isInteger(count) || count < 1) {
      emit("Count must be a positive integer");
      return "handled";
    }
    const result = await client.sessions.rewind(sessionId, { count });
    emit(`Rewound ${result.turns} turn(s), removed ${result.removed} message(s).`);
    return "handled";
  }

  if (slash?.name === "/compact") {
    if (!sessionId) return "handled";
    const result = await client.sessions.compact(sessionId);
    emit(`Conversation compacted (${result.messageCount} messages retained).`);
    return "handled";
  }

  if (slash?.name === "/remember") {
    if (!sessionId) return "handled";
    const result = await client.sessions.remember(sessionId);
    if (result.skipped) {
      emit(`未写入记忆:${result.reason ?? "skipped"}`);
      return "handled";
    }
    emit(`已写入 ${result.writtenIds.length} 条记忆:${result.titles.join("、")}`);
    return "handled";
  }

  if (slash?.name === "/dream") {
    const preview = slash.args.includes("--preview");
    const result = await client.system.startDream({
      cwd,
      ...(sessionId ? { sessionId } : {}),
      preview,
    });
    emit(`Dream started as Job ${result.taskId}. Use /jobs to inspect it.`);
    return "handled";
  }

  if (slash?.name === "/doctor") {
    return handleDiagnosticCommand(slash, host, emit, readPresentation);
  }

  if (slash?.name === "/usage" || slash?.name === "/cost") {
    if (!sessionId) return "handled";
    if (slash.name === "/cost") {
      await readPresentation(`cost:${sessionId}`, "Cost", async () => {
        const usage = await client.sessions.getUsage(sessionId);
        return [
          "Cost estimate:",
          `  Model:         ${usage.model}`,
          `  Input tokens:  ${usage.inputTokens.toLocaleString()}`,
          `  Output tokens: ${usage.outputTokens.toLocaleString()}`,
          `  Est. cost:     ${usage.estimatedCost}`,
          ...(usage.cacheCreationTokens
            ? [`  Cache write:   ${usage.cacheCreationTokens.toLocaleString()}`]
            : []),
          ...(usage.cacheReadTokens
            ? [`  Cache read:    ${usage.cacheReadTokens.toLocaleString()}`]
            : []),
        ].join("\n");
      });
      return "handled";
    }
    await readPresentation(`usage:${sessionId}`, "Usage", async () => {
      const usage = await client.sessions.getUsage(sessionId);
      return [
        "Token usage:",
        `  Input:         ${usage.inputTokens.toLocaleString()}`,
        `  Output:        ${usage.outputTokens.toLocaleString()}`,
        `  Total:         ${(usage.inputTokens + usage.outputTokens).toLocaleString()}`,
        `  Cache write:   ${usage.cacheCreationTokens.toLocaleString()}`,
        `  Cache read:    ${usage.cacheReadTokens.toLocaleString()}`,
        `  Messages:      ${usage.messageCount}`,
        `  Est. cost:     ${usage.estimatedCost}`,
      ].join("\n");
    });
    return "handled";
  }

  if (slash?.name === "/export") {
    if (!sessionId) return "handled";
    const args = slash.args.trim().split(/\s+/).filter(Boolean);
    const forceJson = args.includes("--json");
    const filename = args.find((arg) => !arg.startsWith("--"));
    const result = await client.sessions.export(sessionId, {
      ...(filename ? { filename } : {}),
      json: forceJson,
    });
    emit(`Exported ${result.format === "json" ? "JSON" : "Markdown"} to: ${result.filepath}`);
    return "handled";
  }

  if (slash?.name === "/init") {
    emit(await client.projects.init({ cwd }));
    return "handled";
  }

  if (slash?.name === "/plugin") {
    const args = slash.args.trim().split(/\s+/).filter(Boolean);
    const sub = args[0];
    if (!sub || sub === "list") {
      await readPresentation(`plugins:${cwd}`, "Plugin", async () => {
        const listed = await client.plugins.list({ cwd });
        if (listed.plugins.length === 0) return "No plugins discovered.";
        return [
          ...listed.plugins.map(
            (plugin) =>
              `- ${plugin.identity.id} (${plugin.identity.name}@${plugin.identity.version}) ` +
              `[${plugin.origin}/${plugin.scope}/${plugin.enabled ? "enabled" : "disabled"}/${plugin.activation}] ` +
              Object.entries(plugin.inventory).map(([kind, count]) => `${kind}=${count}`).join(" ") +
              plugin.diagnostics.map((item) => `\n  ! ${item.code}: ${item.message}`).join(""),
          ),
          ...listed.warnings.map((warning) => `! ${warning}`),
        ].join("\n");
      });
      return "handled";
    }
    if ((sub === "enable" || sub === "disable") && args[1]) {
      const result = sub === "enable"
        ? await client.plugins.enable(args[1], { cwd })
        : await client.plugins.disable(args[1], { cwd });
      emit(result.message);
      return "handled";
    }
    emit("Usage: /plugin [list|enable ID|disable ID]");
    return "handled";
  }

  if (slash?.name === "/reload-plugins") {
    const result = await client.plugins.reload({ cwd });
    emit(formatPluginReload(result));
    return "handled";
  }

  if (slash?.name === "/hooks") {
    await readPresentation(`hooks:${cwd}:${sessionId ?? "global"}`, "Hooks", async () => {
      const hooks = await client.development.listHooks({
        cwd,
        ...(sessionId ? { sessionId } : {}),
      });
      if (hooks.length === 0) return "No hooks configured.";
      const settingsHooks = hooks.filter((hook) => hook.origin === "settings");
      const runtimeHooks = hooks.filter((hook) => hook.origin === "runtime");
      const lines = ["Hooks:", ""];
      if (runtimeHooks.length > 0) {
        lines.push("Runtime hooks:");
        for (const hook of runtimeHooks) {
          lines.push(`  ${hook.id}: ${hook.event} (${hook.type}) [${hook.enabled ? "enabled" : "disabled"}]`);
        }
        lines.push("");
      }
      if (settingsHooks.length > 0) {
        lines.push("Settings hooks:");
        for (const hook of settingsHooks) {
          lines.push(`  ${hook.id}: ${hook.event} (${hook.type}) [${hook.enabled ? "enabled" : "disabled"}]`);
        }
      }
      return lines.join("\n");
    });
    return "handled";
  }

  if (slash?.name === "/subagents") {
    const agents = await client.development.listAgentPersonas();
    emit(
      [
        `Available subagent personas (${agents.length}):`,
        "",
        ...agents.flatMap((agent) => [
          `- ${agent.name} [${agent.source ?? "builtin"}]${agent.model ? ` model=${agent.model}` : ""}`,
          `    ${agent.description.split("\n")[0]?.slice(0, 100) ?? ""}`,
        ]),
        "",
        '用法: Agent 工具 subagentType="<name>" 派发;/agents 查看 Agent Jobs。',
      ].join("\n"),
    );
    return "handled";
  }

  if (slash?.name === "/diff") {
    const full = slash.args.trim().split(/\s+/).includes("full");
    await readPresentation(`git:diff:${cwd}:${full ? "full" : "summary"}`, "Diff", async () =>
      await client.development.getGitDiff({ cwd, full }));
    return "handled";
  }

  if (slash?.name === "/branch") {
    const list = slash.args.trim().split(/\s+/).includes("list");
    await readPresentation(`git:branch:${cwd}:${list ? "list" : "current"}`, "Branch", async () =>
      await client.development.getGitBranch({ cwd, list }));
    return "handled";
  }

  if (slash?.name === "/commit") {
    const message = slash.args.trim();
    if (!message) {
      await readPresentation(`git:status:${cwd}`, "Commit", async () => await client.development.getGitStatus({ cwd }));
      return "handled";
    }
    emit(await client.development.gitCommit({ cwd, message }));
    return "handled";
  }

  if (slash && LOCAL_COMMAND_NAMES.has(slash.name)) {
    // UI-only commands are handled by the host UI layer; ignore accidental falls-through.
    return "local_ui";
  }

  return "unhandled";
}
