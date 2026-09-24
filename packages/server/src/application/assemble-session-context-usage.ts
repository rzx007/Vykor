import {
  assembleContextUsageSnapshot,
  createTip,
  messagesToLedgerSegments,
  toolSchemasToLedgerSegments,
  type ContextLedgerSegment,
  type ContextUsageSnapshot,
  type Message,
  type Settings,
  type ToolRegistrationSource,
  type ToolSchemaInput,
} from "@vykor/core";
import { buildPromptLedgerSegments } from "@vykor/prompts";
import {
  readSessionRuntimeConfig,
  type SessionRecord,
} from "@vykor/protocol";

import type { ContextUsageCache } from "./context-usage-cache.js";
import type { ModelInfo, ModelProviderInfo } from "./settings-api.js";

export interface ModelVisibleTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source: ToolRegistrationSource;
}

export interface SessionContextUsageAgent {
  getHistory(): Message[];
  listModelVisibleTools(): ModelVisibleTool[];
  getContextUsagePromptSource?(): {
    systemPrompt?: string;
    memoryReminderText?: string;
  };
}

export interface AssembleSessionContextUsageInput {
  sessionId: string;
  cwd: string;
  model: string;
  settings: Settings;
  agent: SessionContextUsageAgent;
  cache: ContextUsageCache;
  memoryReminderText?: string;
  contextWindow?: number | null;
  outputLimit?: number | null;
  previousContextWindow?: number;
  skillsList?: Array<{ name: string; description: string }>;
}

export interface ModelContextLimits {
  contextWindow: number | null;
  outputLimit: number | null;
}

/** Match session runtime.model against ModelService catalog entries. */
export function findModelInProviders(
  model: string,
  providers: ModelProviderInfo[],
  providerHint?: string,
): ModelInfo | undefined {
  const needle = model.trim();
  if (!needle) return undefined;

  const ordered = providerHint
    ? [
        ...providers.filter((p) => p.name === providerHint),
        ...providers.filter((p) => p.name !== providerHint),
      ]
    : providers;

  for (const provider of ordered) {
    const exact = provider.models.find((item) => item.id === needle);
    if (exact) return exact;
  }

  // "provider/modelId" → try modelId within that provider, then any provider.
  const slash = needle.indexOf("/");
  if (slash > 0) {
    const prefix = needle.slice(0, slash);
    const rest = needle.slice(slash + 1);
    const preferred = ordered.find((p) => p.name === prefix);
    const fromPreferred = preferred?.models.find((item) => item.id === rest);
    if (fromPreferred) return fromPreferred;
    for (const provider of ordered) {
      const hit = provider.models.find((item) => item.id === rest);
      if (hit) return hit;
      const prefixed = provider.models.find(
        (item) => item.id === needle || `${provider.name}/${item.id}` === needle,
      );
      if (prefixed) return prefixed;
    }
  }

  return undefined;
}

export async function resolveModelContextLimits(input: {
  model: string;
  providerHint?: string;
  listProviders: () => Promise<ModelProviderInfo[]> | ModelProviderInfo[];
}): Promise<ModelContextLimits> {
  try {
    const providers = await input.listProviders();
    const info = findModelInProviders(
      input.model,
      providers,
      input.providerHint,
    );
    return {
      contextWindow:
        typeof info?.contextWindow === "number" ? info.contextWindow : null,
      outputLimit:
        typeof info?.outputLimit === "number" ? info.outputLimit : null,
    };
  } catch {
    return { contextWindow: null, outputLimit: null };
  }
}

export async function resolveSessionModelContextLimits(input: {
  session: SessionRecord;
  settings: Settings;
  listProviders: () => Promise<ModelProviderInfo[]> | ModelProviderInfo[];
}): Promise<ModelContextLimits> {
  const runtime = readSessionRuntimeConfig(input.session, {
    provider: input.settings.provider,
  });
  return await resolveModelContextLimits({
    model: runtime.model,
    providerHint: runtime.provider,
    listProviders: input.listProviders,
  });
}

/** Stable serialization matching model-visible tool schema surface. */
export function serializeToolSchemaForUsage(tool: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  });
}

export function toolKindForUsage(
  tool: Pick<ModelVisibleTool, "name" | "source">,
): ToolSchemaInput["kind"] {
  if (tool.source.kind === "mcp") return "mcp";
  if (tool.name.startsWith("mcp__")) return "mcp";
  return "builtin";
}

export function modelVisibleToolsToSchemaInputs(
  tools: ModelVisibleTool[],
): ToolSchemaInput[] {
  return tools.map((tool) => ({
    kind: toolKindForUsage(tool),
    text: serializeToolSchemaForUsage(tool),
  }));
}

/**
 * Assemble a live_assembly snapshot from the same prompt/tools/messages the
 * session agent would send next, then write it into the session usage cache.
 */
export async function assembleSessionContextUsage(
  input: AssembleSessionContextUsageInput,
): Promise<ContextUsageSnapshot> {
  const rebuiltPromptSegments = await buildPromptLedgerSegments({
    customPrompt: input.settings.systemPrompt,
    cwd: input.cwd,
    permissionMode: input.settings.permission.mode,
    workStyle: input.settings.workStyle,
    fastMode: input.settings.fastMode,
    effort: input.settings.effort,
    passes: input.settings.passes,
    skillsList: input.skillsList,
  });
  const runtimePrompt = input.agent.getContextUsagePromptSource?.();
  const promptSegments = promptSegmentsFromRuntime(
    rebuiltPromptSegments,
    runtimePrompt?.systemPrompt,
  );
  const memoryReminderText =
    runtimePrompt?.memoryReminderText ?? input.memoryReminderText;
  if (memoryReminderText?.trim()) {
    promptSegments.push({
      bucket: "conversation",
      text: memoryReminderText.trim(),
    });
  }

  const toolSegments = toolSchemasToLedgerSegments(
    modelVisibleToolsToSchemaInputs(input.agent.listModelVisibleTools()),
  );
  const messageSegments = messagesToLedgerSegments(input.agent.getHistory());

  const segments: ContextLedgerSegment[] = [
    ...promptSegments,
    ...toolSegments,
    ...messageSegments,
  ];

  const snapshot = assembleContextUsageSnapshot({
    segments,
    model: input.model,
    contextWindow: input.contextWindow ?? null,
    outputLimit: input.outputLimit,
    source: "live_assembly",
    modelSwitch:
      input.previousContextWindow != null
        ? { previousContextWindow: input.previousContextWindow }
        : undefined,
  });

  input.cache.set(input.sessionId, snapshot);
  return snapshot;
}

function promptSegmentsFromRuntime(
  rebuilt: ContextLedgerSegment[],
  runtimeSystemPrompt: string | undefined,
): ContextLedgerSegment[] {
  if (runtimeSystemPrompt === undefined) return rebuilt;
  const rebuiltPrompt = rebuilt
    .filter((segment) => segment.bucket !== "conversation")
    .map((segment) => segment.text)
    .join("\n\n");
  if (rebuiltPrompt === runtimeSystemPrompt) {
    return rebuilt.filter((segment) => segment.bucket !== "conversation");
  }
  return runtimeSystemPrompt.trim()
    ? [{ bucket: "system", text: runtimeSystemPrompt }]
    : [];
}

export type AssembleLiveContextUsageInput = {
  sessionId: string;
  cwd: string;
  previousContextWindow?: number;
};

/**
 * Resolve a warm (or newly acquired) session agent and assemble usage.
 * Returns null when the agent/runtime is unavailable so callers can degrade.
 */
export async function tryAssembleSessionContextUsageLive(input: {
  sessionId: string;
  cwd: string;
  model: string;
  cache: ContextUsageCache;
  settings: Settings;
  previousContextWindow?: number;
  contextWindow?: number | null;
  outputLimit?: number | null;
  memoryReminderText?: string;
  skillsList?: Array<{ name: string; description: string }>;
  getAgent: () => Promise<SessionContextUsageAgent | undefined>;
}): Promise<ContextUsageSnapshot | null> {
  let agent: SessionContextUsageAgent | undefined;
  try {
    agent = await input.getAgent();
  } catch {
    return null;
  }
  if (!agent) return null;
  if (typeof agent.listModelVisibleTools !== "function") return null;

  try {
    return await assembleSessionContextUsage({
      sessionId: input.sessionId,
      cwd: input.cwd,
      model: input.model,
      settings: input.settings,
      agent,
      cache: input.cache,
      memoryReminderText: input.memoryReminderText,
      contextWindow: input.contextWindow,
      outputLimit: input.outputLimit,
      previousContextWindow: input.previousContextWindow,
      skillsList: input.skillsList,
    });
  } catch {
    return null;
  }
}

/** Tip helper kept next to assembly for static fallback paths. */
export function conversationOmittedTip() {
  return createTip("conversation_omitted");
}
