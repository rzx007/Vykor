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
import type { JobReadResult, JobSnapshot } from "@vykor/protocol";
import { patchSessionRuntimeMetadata } from "@vykor/protocol";
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

function formatJobReadResult(result: JobReadResult): string {
  const snapshot: JobSnapshot = result.snapshot;
  const capabilities = [
    `read=${snapshot.capabilities.read}`,
    `wait=${snapshot.capabilities.wait}`,
    `send=${snapshot.capabilities.send}`,
    `cancel=${snapshot.capabilities.cancel}`,
  ].join(", ");
  return [
    `Job: ${snapshot.id}`,
    `  Kind:          ${snapshot.kind}`,
    `  Status:        ${snapshot.status}`,
    `  Label:         ${snapshot.label}`,
    `  Owner session: ${snapshot.ownerSession}`,
    `  CWD:           ${snapshot.cwd}`,
    `  Started at:    ${snapshot.startedAt}`,
    `  Updated at:    ${snapshot.updatedAt}`,
    `  Finished at:   ${snapshot.finishedAt ?? "(n/a)"}`,
    `  Detail:        ${snapshot.detail ?? "(none)"}`,
    `  Capabilities:  ${capabilities}`,
    `  Metadata:      ${snapshot.metadata ? JSON.stringify(snapshot.metadata) : "(none)"}`,
    `  Cursor:        ${result.cursor}`,
    `  Truncated:     ${result.truncated}`,
    "",
    "Output:",
    result.text || "(no output)",
  ].join("\n");
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
    model,
    permissionMode,
    statusSessionId,
    commandCatalog,
    clientState,
    busy,
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
  const patchStatus = (patch: Record<string, unknown>) => host.patchStatus?.(patch);

  if (slash?.name === "/plan") {
    const next =
      slash.args === "on" ? "plan"
        : slash.args === "off" ? "default"
          : undefined;
    if (!next) {
      emit("Usage: /plan [on|off]");
      return "handled";
    }
    patchStatus({ permission_mode: next });
    if (sessionId) {
      await client.sessions.update(sessionId, {
        metadata: patchSessionRuntimeMetadata({}, { permissionMode: next }),
      });
    }
    emit(`Permission mode: ${next}`);
    return "handled";
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

  if (slash?.name === "/version") {
    await readPresentation("version", "Version", async () => {
      const health = await client.protocol.health();
      return `Vykor${health.version ? ` v${health.version}` : ""}`;
    });
    return "handled";
  }

  if (slash?.name === "/status") {
    emit([
      "Session status:",
      `  session: ${statusSessionId ?? "(none)"}`,
      `  model:   ${model ?? "(unknown)"}`,
      `  cwd:     ${cwd || "(unknown)"}`,
      `  mode:    ${permissionMode ?? "default"}`,
      `  busy:    ${busy || hasActiveRun(clientState, sessionId) ? "yes" : "no"}`,
    ].join("\n"));
    return "handled";
  }

  if (slash?.name === "/config") {
    const args = slash.args.trim();
    if (!args || args === "show") {
      await readPresentation(`config:${cwd}`, "Config", async () => {
        const settings = await client.system.getSettings();
        return JSON.stringify(settings, null, 2);
      });
      return "handled";
    }
    const setMatch = args.match(/^set\s+(\S+)\s+([\s\S]+)$/);
    if (!setMatch?.[1] || setMatch[2] === undefined) {
      emit("Usage: /config [show | set KEY VALUE]");
      return "handled";
    }
    await client.system.patchSettings({ path: setMatch[1], value: setMatch[2].trim() });
    emit(`Set ${setMatch[1]} = ${setMatch[2].trim()}`);
    return "handled";
  }

  if (slash?.name === "/provider") {
    if (!slash.args) {
      await readPresentation("providers", "Provider", async () => {
        const providers = await client.providers.listProviders();
        const lines = ["Available providers:", ""];
        for (const provider of providers) {
          const marker = provider.active ? " (active)" : "";
          const keyStatus = provider.local ? "[local]" : provider.hasKey ? "[key]" : "[no key]";
          lines.push(`  ${provider.name.padEnd(14)} ${provider.displayName.padEnd(14)} ${keyStatus}${marker}`);
        }
        return lines.join("\n");
      });
      return "handled";
    }
    const settings = await client.system.patchSettings(
      slash.args === "auto"
        ? { provider: "auto" }
        : { provider: slash.args },
    );
    if (typeof settings.model === "string") {
      patchStatus({ model: settings.model });
    }
    emit(`Provider switched to: ${slash.args}`);
    return "handled";
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

  if (slash?.name === "/jobs") {
    if (!sessionId) return "handled";
    const args = slash.args.trim();
    const [sub, id, ...extra] = args.split(/\s+/).filter(Boolean);
    if ((!sub || sub === "list") && !id) {
      await readPresentation(`jobs:${sessionId}`, "Jobs", async () => {
        const jobs = await client.jobs.list({
          sessionId,
          includeFinished: true,
          limit: 100,
        });
        if (jobs.length === 0) return "No Jobs.";
        return [
          `Jobs (${jobs.length}):`,
          "",
          ...jobs.map((job) => `  ${job.id} [${job.status}] ${job.kind}: ${job.label}`),
        ].join("\n");
      });
      return "handled";
    }
    if (sub === "show" && id && extra.length === 0) {
      await readPresentation(`job:${sessionId}:${id}`, "Jobs", async () => {
        const result = await client.jobs.read(id, { sessionId });
        return formatJobReadResult(result);
      });
      return "handled";
    }
    if (sub === "cancel" && id && extra.length === 0) {
      const snapshot = await client.jobs.cancel(id, {
        sessionId,
        reason: "Cancelled from slash command",
      });
      emit(`Job ${snapshot.id} status: ${snapshot.status}.`);
      return "handled";
    }
    emit("Usage: /jobs [list | show ID | cancel ID]");
    return "handled";
  }

  if (slash?.name === "/background") {
    const command = slash.args.trim();
    if (!command) {
      emit("Usage: /background <command>");
      return "handled";
    }
    if (!sessionId) return "handled";
    const result = await client.jobs.createBackgroundShell({ sessionId, command });
    emit(`Background shell started: ${result.jobId}. Use /jobs to inspect it.`);
    return "handled";
  }

  if (slash?.name === "/memory") {
    const args = slash.args.trim();
    const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
    if (!sub || sub === "list") {
      await readPresentation(`memory:${cwd}:list`, "Memory", async () => {
        const listed = await client.system.listMemory({ cwd });
        if (listed.entries.length === 0) return `Memory directory: ${listed.directory}\nNo entries found.`;
        return [
          `Memory entries (${listed.entries.length}):`,
          "",
          ...listed.entries.map((entry) => {
            const tags = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";
            const preview = entry.content.length > 80
              ? `${entry.content.slice(0, 80)}...`
              : entry.content;
            return `  ${entry.id}${tags}: ${preview}`;
          }),
        ].join("\n");
      });
      return "handled";
    }
    if (sub === "show" && rest[0]) {
      const memoryId = rest[0];
      await readPresentation(`memory:${cwd}:show:${memoryId}`, "Memory", async () => {
        const entry = await client.system.getMemory(memoryId, { cwd });
        return [
          `ID:       ${entry.id}`,
          `Created:  ${new Date(entry.createdAt).toISOString()}`,
          `Updated:  ${new Date(entry.updatedAt).toISOString()}`,
          `Tags:     ${entry.tags?.join(", ") ?? "(none)"}`,
          `Source:   ${entry.source?.type ?? "(unknown)"}`,
          ...(entry.source?.sessionId ? [`Session:  ${entry.source.sessionId}`] : []),
          ...(entry.source?.messageSha256 ? [`Message:  ${entry.source.messageSha256}`] : []),
          "",
          entry.content,
        ].join("\n");
      });
      return "handled";
    }
    if (sub === "add") {
      const content = rest.join(" ").trim();
      if (!content) {
        emit("Usage: /memory add <content>");
        return "handled";
      }
      const entry = await client.system.addMemory({ cwd, content });
      emit(`Memory added: ${entry.id}`);
      return "handled";
    }
    if (sub === "remove" && rest[0]) {
      await client.system.removeMemory(rest[0], { cwd });
      emit(`Memory removed: ${rest[0]}`);
      return "handled";
    }
    emit("Usage: /memory [list | show ID | add CONTENT | remove ID]");
    return "handled";
  }

  if (slash?.name === "/auth") {
    const args = slash.args.trim();
    const [sub, provider, apiKey] = args.split(/\s+/).filter(Boolean);
    if (!sub || sub === "status") {
      await readPresentation("auth:status", "Auth", async () => {
        const auth = await client.auth.getStatus();
        const lines = ["Credential status:", "", "  Auth sources:"];
        lines.push(
          `    codex_subscription: ${auth.codex.configured ? "ready" : auth.codex.state} (${auth.codex.source})`,
        );
        if (auth.storedProviders.length > 0) {
          lines.push("", "  Stored credentials:");
          for (const name of auth.storedProviders) lines.push(`    ${name}: configured`);
        }
        if (auth.envProviders.length > 0) {
          lines.push("  Environment variables:");
          for (const env of auth.envProviders) lines.push(`    ${env.name}: ${env.envKey}`);
        }
        if (auth.storedProviders.length === 0 && auth.envProviders.length === 0) {
          lines.push("", "  No credentials configured.");
          lines.push("  Use /auth login <provider> <api-key> to store an API key.");
          lines.push("  Use /auth login codex to use a Codex subscription.");
        }
        return lines.join("\n");
      });
      return "handled";
    }
    if (sub === "login") {
      if (!provider) {
        emit("Usage: /auth login <provider> <api-key> or /auth login codex");
        return "handled";
      }
      const result = await client.auth.login({ provider, apiKey });
      emit(result.message);
      return "handled";
    }
    if (sub === "logout") {
      if (!provider) {
        emit("Usage: /auth logout <provider>");
        return "handled";
      }
      const result = await client.auth.logout({ provider });
      emit(result.message);
      return "handled";
    }
    emit("Unknown subcommand. Use login, logout, or status.");
    return "handled";
  }

  if (slash?.name === "/context") {
    const action = slash.args.trim().split(/\s+/).filter(Boolean)[0] ?? "preview";
    if (action === "status") {
      await readPresentation(`context:${cwd}:status`, "Context", async () => await client.system.getContextStatus({ cwd }));
      return "handled";
    }
    if (action === "usage") {
      await readPresentation(
        `context:${cwd}:usage:${sessionId ?? "none"}`,
        "Context",
        async () => {
          const result = await client.system.getContextUsage({
            cwd,
            ...(sessionId ? { sessionId } : {}),
          });
          return result.report;
        },
      );
      return "handled";
    }
    if (action !== "preview") {
      emit("Usage: /context [preview|status|usage]");
      return "handled";
    }
    await readPresentation(`context:${cwd}`, "Context", async () => await client.system.getContextPreview({ cwd }));
    return "handled";
  }

  if (slash?.name === "/stats") {
    if (!sessionId) return "handled";
    const bucket = clientState.buckets[sessionId];
    const messageCount = bucket?.messages.length ?? 0;
    const text = (bucket?.messages ?? [])
      .flatMap((message) => bucket?.partsByMessageId[message.id] ?? [])
      .map((part) => part.text ?? "")
      .join(" ");
    const estimatedTokens = Math.max(1, Math.ceil(text.length / 4));
    const [memory, jobsResult, settings] = await Promise.all([
      client.system.listMemory({ cwd }).catch(() => ({ entries: [] as Array<{ id: string }> })),
      client.jobs.list({ sessionId, includeFinished: true, limit: 100 })
        .then((jobs) => ({ jobs }))
        .catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        })),
      client.system.getSettings().catch(() => ({} as Record<string, unknown>)),
    ]);
    const jobsSummary = "jobs" in jobsResult
      ? String(jobsResult.jobs.length)
      : `unavailable (${jobsResult.error})`;
    emit([
      "Session stats:",
      `- messages: ${messageCount}`,
      `- estimated_tokens: ${estimatedTokens}`,
      `- memory_entries: ${memory.entries.length}`,
      `- jobs: ${jobsSummary}`,
      `- output_style: ${typeof settings.outputStyle === "string" ? settings.outputStyle : "default"}`,
    ].join("\n"));
    return "handled";
  }

  if (slash?.name === "/agents") {
    if (!sessionId) return "handled";
    const agents = await client.jobs.list({
      sessionId,
      kinds: ["agent"],
      includeFinished: true,
      limit: 100,
    });
    if (agents.length === 0) {
      emit("No Agent Jobs.");
      return "handled";
    }
    emit(
      [
        `Agent Jobs (${agents.length}):`,
        "",
        ...agents.map((job) => `  ${job.id} [${job.status}] ${job.label}`),
      ].join("\n"),
    );
    return "handled";
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

  if (slash?.name === "/profile") {
    const action = slash.args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";
    if (action === "status" || action === "show") {
      emit(await client.system.getProfileStatus());
      return "handled";
    }
    if (action === "init") {
      emit(await client.system.initProfile());
      return "handled";
    }
    emit("Usage: /profile [status|init]");
    return "handled";
  }

  if (slash?.name === "/doctor") {
    const [settings, auth, memory, mcp, jobsResult] = await Promise.all([
      client.system.getSettings().catch(() => ({}) as Record<string, unknown>),
      client.auth.getStatus().catch(() => null),
      client.system.listMemory({ cwd }).catch(() => ({ directory: "(unavailable)", entries: [] as Array<{ id: string }> })),
      sessionId ? client.system.getSessionMcp(sessionId).catch(() => []) : Promise.resolve([]),
      sessionId
        ? client.jobs.list({ sessionId, includeFinished: true, limit: 100 })
          .then((jobs) => ({ jobs }))
          .catch((error: unknown) => ({
            error: error instanceof Error ? error.message : String(error),
          }))
        : Promise.resolve({ jobs: [] as JobSnapshot[] }),
    ]);
    const jobsSummary = "jobs" in jobsResult
      ? String(jobsResult.jobs.length)
      : `unavailable (${jobsResult.error})`;
    const bucket = sessionId ? clientState.buckets[sessionId] : undefined;
    const diagnostics = await host.getRuntimeDiagnostics?.();
    const runtime = diagnostics?.runtime ?? "(not provided by this host)";
    const platform = [diagnostics?.platform, diagnostics?.architecture]
      .filter(Boolean)
      .join(" ") || "(not provided by this host)";
    const lines = [
      "Vykor Environment Diagnostic",
      "═".repeat(40),
      "",
      `CWD:            ${cwd}`,
      `Runtime:        ${runtime}`,
      `Platform:       ${platform}`,
      `Model:          ${model ?? String(settings.model ?? "(unknown)")}`,
      `API Format:     ${String(settings.apiFormat ?? "(default)")}`,
      `Base URL:       ${String(settings.baseUrl ?? "(default)")}`,
      `Permission:     ${typeof settings.permission === "object" && settings.permission && "mode" in settings.permission
        ? String((settings.permission as { mode?: string }).mode ?? "default")
        : "default"}`,
      `Max Turns:      ${String(settings.maxTurns ?? "(default)")}`,
      `Effort:         ${String(settings.effort ?? "medium")}`,
      `Passes:         ${String(settings.passes ?? 1)}`,
      `Fast Mode:      ${settings.fastMode ? "on" : "off"}`,
      `Theme:          ${String(settings.theme ?? "default")}`,
      "",
      `Messages:       ${bucket?.messages.length ?? 0}`,
      `Jobs:           ${jobsSummary}`,
      "",
      `Memory dir:     ${memory.directory}`,
      `Memory entries: ${memory.entries.length}`,
    ];
    if (auth) {
      lines.push(
        "",
        `Codex auth:     ${auth.codex.configured ? "ready" : auth.codex.state} (${auth.codex.source})`,
        `Stored keys:    ${auth.storedProviders.length ? auth.storedProviders.join(", ") : "(none)"}`,
      );
    }
    lines.push("", "MCP Servers:");
    if (mcp.length === 0) lines.push("  (none)");
    else {
      for (const server of mcp) {
        lines.push(`  ${server.name}: ${server.status} (${server.toolCount} tools)`);
      }
    }
    emit(lines.join("\n"));
    return "handled";
  }

  if (slash?.name === "/effort") {
    const level = slash.args.trim().split(/\s+/).filter(Boolean)[0];
    if (!level) {
      const settings = await client.system.getSettings();
      emit(`Current effort: ${String(settings.effort ?? "medium")}`);
      return "handled";
    }
    if (!level.trim()) {
      emit("Invalid effort. Provide a non-empty reasoning effort value");
      return "handled";
    }
    await client.system.patchSettings({ effort: level });
    emit(`Effort set to: ${level}`);
    return "handled";
  }

  if (slash?.name === "/fast") {
    const arg = slash.args.trim().split(/\s+/).filter(Boolean)[0];
    const settings = await client.system.getSettings();
    const current = settings.fastMode === true;
    let next: boolean;
    if (arg === "on") next = true;
    else if (arg === "off") next = false;
    else next = !current;
    await client.system.patchSettings({ fastMode: next });
    emit(`Fast mode: ${next ? "ON" : "OFF"}`);
    return "handled";
  }

  if (slash?.name === "/reasoning") {
    const arg = slash.args.trim().split(/\s+/).filter(Boolean)[0];
    const settings = await client.system.getSettings();
    const current = settings.showReasoning !== false;
    let next: boolean;
    if (arg === "on") next = true;
    else if (arg === "off") next = false;
    else next = !current;
    await client.system.patchSettings({ showReasoning: next });
    emit(`Reasoning: ${next ? "ON" : "OFF"}`);
    return "handled";
  }

  if (slash?.name === "/turns") {
    const value = slash.args.trim().split(/\s+/).filter(Boolean)[0];
    if (!value) {
      const settings = await client.system.getSettings();
      emit(`Current max turns: ${String(settings.maxTurns ?? "(default)")}`);
      return "handled";
    }
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1 || n > 512) {
      emit("Value must be between 1 and 512");
      return "handled";
    }
    await client.system.patchSettings({ maxTurns: n });
    emit(`Max turns set to: ${n}`);
    return "handled";
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

  if (slash?.name === "/output-style") {
    const args = slash.args.trim();
    const styles = await client.system.listOutputStyles();
    const settings = await client.system.getSettings();
    const current = typeof settings.outputStyle === "string" ? settings.outputStyle : "default";
    const firstSpace = args.search(/\s/);
    const first = firstSpace === -1 ? args : args.slice(0, firstSpace);
    const rest = firstSpace === -1 ? "" : args.slice(firstSpace + 1).trim();

    if (!first || first === "show") {
      emit(`Output style: ${current}`);
      return "handled";
    }
    if (first === "list") {
      emit(
        styles
          .map((style) => `${style.name === current ? "* " : "  "}${style.name} [${style.source}]`)
          .join("\n"),
      );
      return "handled";
    }

    const styleName = first === "set" && rest ? rest : rest === "" ? first : undefined;
    if (!styleName) {
      emit("Usage: /output-style [show|list|NAME]");
      return "handled";
    }
    if (!styles.some((style) => style.name === styleName)) {
      emit(`Unknown output style: ${styleName}`);
      return "handled";
    }
    await client.system.patchSettings({ outputStyle: styleName });
    emit(`Output style set to ${styleName}`);
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
