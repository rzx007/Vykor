import {
  VykorClient,
  applySessionSnapshot,
  createPromptRequestId,
  hasActiveRun,
  normalizeDaemonBaseUrl,
  patchSessionRuntimeMetadata,
  readSessionModelUsage,
  readSessionModelRetryState,
  selectVisibleSessionMessagesWithParts,
  syncEvents,
  type VykorClientState,
  type SessionEventRecord,
  type SessionMessagePartRecord,
  type SessionStateSnapshot,
} from "@vykor/client";
import type { Settings } from "@vykor/core";
import { isCoordinatorMode } from "@vykor/coordinator";

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

type PermissionClient = Pick<VykorClient, "permissions">;

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
  state: VykorClientState,
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
  state: VykorClientState,
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
  state?: VykorClientState,
  supersededParts?: Set<string>,
): void {
  if (!event) return;

  if (outputFormat === "json") return;
  if (outputFormat === "stream-json") {
    const part = event.type === "session.message.part.updated"
      ? event.payload.part as SessionMessagePartRecord | undefined
      : event.type === "session.message.part.delta"
        ? state?.buckets[event.sessionId ?? ""]?.partsByMessageId[String(event.payload.messageId)]?.find((row) => row.id === event.payload.partId)
        : undefined;
    const generation = part?.metadata.modelGeneration;
    process.stdout.write(`${JSON.stringify(generation ? { ...event, modelGeneration: generation } : event)}\n`);
    if (part && typeof generation === "object" && generation !== null && "superseded" in generation && generation.superseded === true && !supersededParts?.has(part.id)) {
      supersededParts?.add(part.id);
      process.stdout.write(`${JSON.stringify({ type: "session.model.generation.superseded", sessionId: event.sessionId, partId: part.id, modelGeneration: generation })}\n`);
    }
    return;
  }

  if (event.type === "session.run.updated") {
    const run = event.payload.run;
    if (run && typeof run === "object" && "metadata" in run && run.metadata && typeof run.metadata === "object") {
      const retry = readSessionModelRetryState(run.metadata as Record<string, unknown>);
      if (retry) void renderer.render({ type: "model_retry", ...retry });
    }
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
    if (!part || part.metadata.modelGeneration && typeof part.metadata.modelGeneration === "object" && "superseded" in part.metadata.modelGeneration && part.metadata.modelGeneration.superseded === true) return;
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
  state: VykorClientState,
  sessionId: string,
  renderer: EventRenderer,
  outputFormat: string | undefined,
  partTextSeen: Map<string, string>,
): void {
  if (outputFormat === "json" || outputFormat === "stream-json") return;
  const bucket = state.buckets[sessionId];
  if (!bucket) return;
  for (const { message, parts } of selectVisibleSessionMessagesWithParts(bucket)) {
    if (message.role !== "assistant") continue;
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
  state: VykorClientState,
  snapshot: SessionStateSnapshot,
): VykorClientState {
  return applySessionSnapshot(state, snapshot);
}

function finalOutput(state: VykorClientState, sessionId: string, runId: string | undefined) {
  const bucket = state.buckets[sessionId];
  const run = runId ? bucket?.runs[runId] : undefined;
  const text = selectVisibleSessionMessagesWithParts(bucket)
    .filter(({ message }) => message.role === "assistant" && (!runId || message.runId === runId))
    .flatMap(({ parts }) => parts.filter((part) => part.type === "text").map((part) => part.text ?? ""))
    .join("");
  const attempts = Object.values(bucket?.attempts ?? {}).filter((attempt) => attempt.runId === runId);
  const usage = run ? readSessionModelUsage(run.metadata) : undefined;
  return {
    sessionId,
    runId,
    status: run?.status ?? "unknown",
    text,
    usage: {
      inputTokens: attempts.reduce((sum, attempt) => sum + (attempt.inputTokens ?? 0), 0),
      outputTokens: attempts.reduce((sum, attempt) => sum + (attempt.outputTokens ?? 0), 0),
      incomplete: usage?.incomplete ?? false,
      unknownAttempts: usage?.unknownAttempts ?? 0,
      partialAttempts: usage?.partialAttempts ?? 0,
    },
  };
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
  const client = new VykorClient({
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
  const supersededParts = new Set<string>();
  const permissionSeen = new Set<string>();
  const approvePermissions = options.dangerouslySkipPermissions === true;

  let admitted = false;
  let runId: string | undefined;
  let exitCode = 0;
  let finalState: VykorClientState | undefined;

  const syncLoop = (async () => {
    for await (const update of syncEvents(client, {
      sessionId: session.id,
      signal: controller.signal,
    })) {
      let observedState = update.state;
      finalState = observedState;

      if (update.source === "snapshot" && !admitted) {
        admitted = true;
        const response = await client.sessions.admitPrompt(session.id, { id: createPromptRequestId(), items: [{ type: "text", text: prompt }] });
        runId = response.run?.id;
        observedState = mergeSessionSnapshot(update.state, await client.sessions.getState(session.id));
        finalState = observedState;
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
        renderSessionEvent(update.event, renderer, options.outputFormat, partTextSeen, observedState, supersededParts);
        renderSessionSnapshot(observedState, session.id, renderer, options.outputFormat, partTextSeen);
      }

      if (!admitted) continue;
      const terminal = runTerminalStatus(observedState, session.id, runId);
      if (terminal === "active" || terminal === "unknown") continue;
      observedState = mergeSessionSnapshot(observedState, await client.sessions.getState(session.id));
      finalState = observedState;
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

  const output = finalState ? finalOutput(finalState, session.id, runId) : undefined;
  if (!options.outputFormat || options.outputFormat === "text") {
    process.stdout.write("\n");
    if (output?.usage.incomplete) {
      process.stderr.write(`已知用量：${output.usage.inputTokens} 输入 / ${output.usage.outputTokens} 输出；部分请求用量未知\n`);
    }
  } else if (output && (options.outputFormat === "json" || options.outputFormat === "stream-json")) {
    process.stdout.write(`${JSON.stringify(options.outputFormat === "json" ? output : { type: "session.output.final", ...output })}\n`);
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
