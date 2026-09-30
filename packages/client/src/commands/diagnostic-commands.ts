import type { JobSnapshot } from "@vykor/protocol";
import { hasActiveRun, type SessionCommandHost, type SlashLine } from "./session-commands.js";

type ReadPresentation = (key: string, title: string, load: () => Promise<string>) => Promise<void>;

export async function handleDiagnosticCommand(
  slash: SlashLine,
  host: SessionCommandHost,
  emit: (text: string) => void,
  readPresentation: ReadPresentation,
): Promise<"handled"> {
  const { client, sessionId, cwd, clientState, model, permissionMode, statusSessionId, busy } = host;
  if (slash.name === "/version") {
    await readPresentation("version", "Version", async () => {
      const health = await client.protocol.health();
      return `Vykor${health.version ? ` v${health.version}` : ""}`;
    });
    return "handled";
  }
  if (slash.name === "/status") {
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
  if (slash.name === "/context") {
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
  if (slash.name === "/stats") {
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
  if (slash.name === "/agents") {
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
    emit([
      `Agent Jobs (${agents.length}):`,
      "",
      ...agents.map((job) => `  ${job.id} [${job.status}] ${job.label}`),
    ].join("\n"));
    return "handled";
  }

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
