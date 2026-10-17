import type { AgentExecutionLimits } from "@vykor/core";
import type { PluginSelectionResult, VykorAgent } from "@vykor/agent-runtime";
import {
  readRuntimeMetadata,
  type SessionInputRecord,
  type SessionRecord,
  type SessionRunRecord,
} from "@vykor/protocol";

export type RunPluginSelection = PluginSelectionResult & {
  status: "resolved";
  source: "explicit" | "inherited" | "auto" | "none";
};

/** Capture eligibility with the Input, independently of later session selections. */
export function capturePluginSelectionPolicy(
  session: SessionRecord,
): "auto" | "none" {
  const runtime = readRuntimeMetadata(session.metadata);
  return runtime.pluginsEnabled !== false &&
    runtime.pluginAutoSelectionEnabled !== false &&
    typeof session.metadata?.activePluginId !== "string"
    ? "auto"
    : "none";
}

/** Called only by the trusted executor, before it captures any business capability. */
export async function resolveRunPluginSelection(options: {
  session: SessionRecord;
  run: SessionRunRecord;
  input: SessionInputRecord;
  agent: Pick<VykorAgent, "selectPluginForRun" | "getHistory">;
  signal: AbortSignal;
  traceId: string;
  limits?: AgentExecutionLimits;
}): Promise<RunPluginSelection> {
  const { session, run, input, agent, signal } = options;
  signal.throwIfAborted();
  const runtime = readRuntimeMetadata(session.metadata);
  const none = (): RunPluginSelection => ({
    status: "resolved",
    source: "none",
    pluginId: null,
    reason: "no_match",
  });
  const previous = run.metadata?.pluginSelection as
    | RunPluginSelection
    | undefined;
  const request = {
    runId: run.id,
    inputId: input.id,
    traceId: options.traceId,
    signal,
    limits: options.limits,
  };
  if (previous?.status === "resolved") {
    if (previous.pluginId && runtime.pluginsEnabled === false) {
      throw new Error(`Plugin is disabled: ${previous.pluginId}`);
    }
    if (previous.source === "auto" && previous.pluginId) {
      if (!agent.selectPluginForRun)
        throw new Error("Plugin selection validation unavailable");
      await agent.selectPluginForRun("", {
        ...request,
        resolvedSelection: previous,
      });
    }
    return previous;
  }
  if (runtime.pluginsEnabled === false) return none();
  if (typeof run.metadata?.pluginId === "string")
    return {
      status: "resolved",
      pluginId: run.metadata.pluginId,
      reason: "matched",
      source: input.items.some(
        (item) => item.type === "capability" || item.type === "skill",
      )
        ? "explicit"
        : "inherited",
    };
  // Input-owned policy survives queueing, rejected steers and replay. Legacy
  // inputs retain their previous behavior; current plugin disabling is checked above.
  const policy = input.metadata.pluginSelectionPolicy;
  if (
    policy === "none" ||
    (policy !== "auto" && capturePluginSelectionPolicy(session) === "none") ||
    !agent.selectPluginForRun
  )
    return none();
  const context = agent
    .getHistory?.()
    .filter(
      (message) => message.type === "user" || message.type === "assistant",
    )
    .slice(-4)
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
    )
    .join("\n")
    .slice(-4000);
  const attachments = input.attachments.map((item) => ({
    name: item.displayName,
    type: item.mediaType,
  }));
  const result = await agent.selectPluginForRun(
    `${input.content}${attachments.length ? `\nAttachments: ${JSON.stringify(attachments)}` : ""}`,
    { ...request, context },
  );
  signal.throwIfAborted();
  return { ...result, status: "resolved", source: "auto" };
}
