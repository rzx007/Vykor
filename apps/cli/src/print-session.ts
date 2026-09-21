import {
  OpenHarnessClient,
  applySessionSnapshot,
  createPromptRequestId,
  hasActiveRun,
  normalizeDaemonBaseUrl,
  patchSessionRuntimeMetadata,
  syncEvents,
  type OpenHarnessClientState,
  type SessionEventRecord,
  type SessionMessagePartRecord,
  type SessionStateSnapshot,
} from "@openharness/client";
import type { Settings } from "@openharness/core";
import { isCoordinatorMode } from "@openharness/coordinator";

import { ensureLocalDaemon } from "./ensure-daemon.js";
import { EventRenderer } from "./renderer.js";

export interface PrintSessionOptions {
  model?: string;
  cwd?: string;
  verbose?: boolean;
  outputFormat?: string;
  dangerouslySkipPermissions?: boolean;
  permissionMode?: string;
  coordinator?: boolean;
  maxTurns?: number;
  systemPrompt?: string;
  allowedTools?: string;
  disallowedTools?: string;
  effort?: string;
  pluginsEnabled?: boolean;
  daemonUrl?: string;
  daemonToken?: string;
}

type PermissionClient = Pick<OpenHarnessClient, "permissions">;

/** Build daemon session.metadata from CLI overrides / settings. */
export function buildPrintSessionMetadata(
  settings: Settings,
  options: PrintSessionOptions,
): Record<string, unknown> {
  const permissionMode = options.dangerouslySkipPermissions
    ? "full_auto"
    : options.permissionMode ?? settings.permission?.mode;
  const maxTurns = options.maxTurns ?? settings.maxTurns;
  const systemPrompt = options.systemPrompt ?? settings.systemPrompt;
  const effort = options.effort ?? settings.effort;
  const allowedTools = options.allowedTools
    ? options.allowedTools.split(",").map((tool) => tool.trim()).filter(Boolean)
    : undefined;
  const disallowedTools = options.disallowedTools
    ? options.disallowedTools.split(",").map((tool) => tool.trim()).filter(Boolean)
    : undefined;

  const metadata = patchSessionRuntimeMetadata({}, {
    model: options.model ?? settings.model,
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    apiFormat: settings.apiFormat,
    permissionMode: typeof permissionMode === "string" && permissionMode ? permissionMode as "default" | "plan" | "full_auto" : undefined,
    maxTurns: typeof maxTurns === "number" ? maxTurns : undefined,
    systemPrompt: typeof systemPrompt === "string" && systemPrompt ? systemPrompt : undefined,
    allowedTools: allowedTools && allowedTools.length > 0 ? allowedTools : undefined,
    disallowedTools: disallowedTools && disallowedTools.length > 0 ? disallowedTools : undefined,
    effort: typeof effort === "string" && effort ? effort as "low" | "medium" | "high" : undefined,
    sessionMode: options.coordinator === true || isCoordinatorMode() ? "coordinator" : "direct",
    pluginsEnabled: options.pluginsEnabled ?? settings.plugins?.enabled,
  });
  const runtimeDefaultFields = [
    ...(options.effort === undefined ? ["effort"] : []),
    ...(options.maxTurns === undefined ? ["maxTurns"] : []),
    ...(options.systemPrompt === undefined ? ["systemPrompt"] : []),
  ];
  return runtimeDefaultFields.length > 0
    ? { ...metadata, runtimeDefaultFields }
    : metadata;
}

function runTerminalStatus(
  state: OpenHarnessClientState,
  sessionId: string,
  runId: string | undefined,
): "active" | "completed" | "failed" | "unknown" {
  if (!runId) {
    return hasActiveRun(state, sessionId) ? "active" : "unknown";
  }
  const run = state.buckets[sessionId]?.runs[runId];
  if (!run) return hasActiveRun(state, sessionId) ? "active" : "unknown";
  if (run.status === "pending" || run.status === "running") return "active";
  if (run.status === "failed") return "failed";
  return "completed";
}

async function autoReplyPermissions(
  client: PermissionClient,
  state: OpenHarnessClientState,
  sessionId: string,
  approve: boolean,
  seen: Set<string>,
): Promise<void> {
  const bucket = state.buckets[sessionId];
  if (!bucket) return;
  for (const request of Object.values(bucket.permissions)) {
    if (request.status !== "pending" || seen.has(request.id)) continue;
    seen.add(request.id);
    const status = approve ? "approved" : "denied";
    await client.permissions.reply(request.id, { status, decision: "once" });
    process.stderr.write(
      approve
        ? `[print] auto-approved permission for ${request.toolName}\n`
        : `[print] auto-denied permission for ${request.toolName}\n`,
    );
  }
}

function renderSessionEvent(
  event: SessionEventRecord | undefined,
  renderer: EventRenderer,
  outputFormat: string | undefined,
  partTextSeen: Map<string, string>,
): void {
  if (!event) return;

  if (outputFormat === "json" || outputFormat === "stream-json") {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }

  if (event.type === "session.message.part.delta") {
    const partId = typeof event.payload.partId === "string" ? event.payload.partId : undefined;
    const delta = typeof event.payload.delta === "string" ? event.payload.delta : undefined;
    const field = event.payload.field;
    if (partId && field === "text" && delta) {
      const previous = partTextSeen.get(partId) ?? "";
      partTextSeen.set(partId, previous + delta);
      void renderer.render({ type: "text_delta", delta });
    }
    return;
  }

  if (event.type === "session.message.part.updated") {
    const part = event.payload.part as SessionMessagePartRecord | undefined;
    if (!part) return;
    if (part.type === "text" && part.text) {
      const previous = partTextSeen.get(part.id) ?? "";
      if (part.text.startsWith(previous) && part.text.length > previous.length) {
        const delta = part.text.slice(previous.length);
        partTextSeen.set(part.id, part.text);
        void renderer.render({ type: "text_delta", delta });
      } else if (!previous && part.status === "completed") {
        partTextSeen.set(part.id, part.text);
        void renderer.render({ type: "text_delta", delta: part.text });
      }
      return;
    }
    if (part.type === "tool" && part.toolName) {
      if (part.status === "running" || (part.input && part.output === undefined)) {
        void renderer.render({
          type: "tool_use_start",
          toolUse: {
            type: "tool_use",
            id: part.toolUseId ?? part.id,
            name: part.toolName,
            input: part.input ?? {},
          },
        });
      }
      if (part.output !== undefined || part.status === "completed" || part.status === "failed") {
        const content = Array.isArray((part.output as { content?: unknown } | undefined)?.content)
          ? (part.output as { content: Array<{ type: string; text?: string }> }).content
          : [{ type: "text", text: part.output == null ? "" : String(part.output) }];
        void renderer.render({
          type: "tool_use_end",
          toolUseId: part.toolUseId ?? part.id,
          result: { content: content as never, isError: part.isError === true },
        });
      }
    }
  }
}

function renderSessionSnapshot(
  state: OpenHarnessClientState,
  sessionId: string,
  renderer: EventRenderer,
  outputFormat: string | undefined,
  partTextSeen: Map<string, string>,
): void {
  if (outputFormat === "json" || outputFormat === "stream-json") return;
  const bucket = state.buckets[sessionId];
  if (!bucket) return;
  for (const message of bucket.messages) {
    if (message.role !== "assistant") continue;
    const parts = bucket.partsByMessageId[message.id] ?? [];
    for (const part of parts) {
      if (part.type !== "text") continue;
      renderSessionEvent(
        {
          id: `snapshot:${part.id}`,
          seq: 0,
          type: "session.message.part.updated",
          schemaVersion: 1,
          sessionId,
          payload: { part },
          createdAt: part.updatedAt,
        },
        renderer,
        outputFormat,
        partTextSeen,
      );
    }
  }
}

function mergeSessionSnapshot(
  state: OpenHarnessClientState,
  snapshot: SessionStateSnapshot,
): OpenHarnessClientState {
  return applySessionSnapshot(state, snapshot);
}

/**
 * Headless print via daemon Session API (opencode-run style).
 */
export async function runPrintSession(
  settings: Settings,
  prompt: string,
  options: PrintSessionOptions,
): Promise<void> {

  let daemon: { url: string; token: string };
  if (options.daemonUrl) {
    if (!options.daemonToken) throw new Error("--daemon-token is required with --daemon-url");
    daemon = {
      url: normalizeDaemonBaseUrl(options.daemonUrl),
      token: options.daemonToken,
    };
  } else {
    daemon = await ensureLocalDaemon();
  }
  const client = new OpenHarnessClient({
    baseUrl: daemon.url,
    token: daemon.token,
  });

  const cwd = options.cwd ? options.cwd : process.cwd();
  const model = options.model ?? settings.model;
  const session = await client.sessions.create({
    cwd,
    model,
    title: "print",
    metadata: buildPrintSessionMetadata(settings, options),
  });

  const controller = new AbortController();
  const renderer = new EventRenderer({
    verbose: options.verbose,
    printMode: true,
    outputStyle: settings.outputStyle,
  });
  const partTextSeen = new Map<string, string>();
  const permissionSeen = new Set<string>();
  const approvePermissions = options.dangerouslySkipPermissions === true;

  let admitted = false;
  let runId: string | undefined;
  let exitCode = 0;

  const syncLoop = (async () => {
    for await (const update of syncEvents(client, {
      sessionId: session.id,
      signal: controller.signal,
    })) {
      let observedState = update.state;

      if (update.source === "snapshot" && !admitted) {
        admitted = true;
        const response = await client.sessions.admitPrompt(session.id, { id: createPromptRequestId(), items: [{ type: "text", text: prompt }] });
        runId = response.run?.id;
        observedState = mergeSessionSnapshot(update.state, await client.sessions.getState(session.id));
        renderSessionSnapshot(observedState, session.id, renderer, options.outputFormat, partTextSeen);
      }

      await autoReplyPermissions(
        client,
        observedState,
        session.id,
        approvePermissions,
        permissionSeen,
      );

      if (update.source === "live") {
        renderSessionEvent(update.event, renderer, options.outputFormat, partTextSeen);
        renderSessionSnapshot(observedState, session.id, renderer, options.outputFormat, partTextSeen);
      }

      if (!admitted) continue;
      const terminal = runTerminalStatus(observedState, session.id, runId);
      if (terminal === "active" || terminal === "unknown") continue;
      observedState = mergeSessionSnapshot(observedState, await client.sessions.getState(session.id));
      renderSessionSnapshot(observedState, session.id, renderer, options.outputFormat, partTextSeen);
      if (terminal === "failed") exitCode = 1;
      controller.abort();
      break;
    }
  })();

  try {
    await syncLoop;
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exit(1);
      return;
    }
  }

  if (!options.outputFormat || options.outputFormat === "text") {
    process.stdout.write("\n");
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
