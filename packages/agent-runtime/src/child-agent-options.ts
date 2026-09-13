import type { AgentChildSpawnInput, RunCapabilityView, Settings } from "@openharness/core";
import { canonicalToolName, canonicalToolNames } from "@openharness/core";
import { readonlyMap } from "./run-capability-view.js";

import type { OpenHarnessAgentOptions } from "./agent.js";
import type {
  AgentCapabilityOverrides,
  AgentEffectOverrides,
  OpenHarnessAgentConfiguration,
} from "./agent-options.js";

export interface DeriveChildAgentOptionsInput {
  configuration: OpenHarnessAgentConfiguration;
  settings: Settings;
  capabilityOverrides?: AgentCapabilityOverrides;
  effects?: AgentEffectOverrides;
  child: AgentChildSpawnInput;
  cwd: string;
  sessionId: string;
}

/** Derive one child runtime without widening the host's tool or capability boundary. */
export function deriveChildAgentOptions(
  input: DeriveChildAgentOptionsInput,
): OpenHarnessAgentOptions {
  const { configuration, child } = input;
  return {
    ...configuration,
    settings: input.settings,
    cwd: input.cwd,
    sessionId: input.sessionId,
    model: child.model ?? configuration.model,
    systemPrompt: child.systemPrompt ?? configuration.systemPrompt,
    permissionMode: child.permissionMode ?? configuration.permissionMode,
    hostToolCeiling: configuration.hostToolCeiling,
    roleAllowedTools: child.allowedTools,
    disallowedTools: mergeToolLists(
      configuration.disallowedTools,
      child.disallowedTools,
    ),
    maxTurns: child.maxTurns ?? configuration.maxTurns,
    effort: isSupportedEffort(child.effort)
      ? child.effort
      : configuration.effort,
    tools: configuration.tools,
    toolOverrides: configuration.toolOverrides,
    trustedToolOverrides: configuration.trustedToolOverrides,
    // Host overrides/effects are borrowed unchanged by the whole root session
    // tree. Resolved defaults are deliberately not propagated: the child
    // composition rebuilds Memory, Workflow and Jobs for its cwd/session.
    capabilityOverrides: input.capabilityOverrides,
    effects: input.effects,
  };
}

function isSupportedEffort(
  effort: string | undefined,
): effort is NonNullable<OpenHarnessAgentConfiguration["effort"]> {
  return effort === "low" || effort === "medium" || effort === "high";
}

function mergeToolLists(
  inherited: string[] | undefined,
  child: string[] | undefined,
): string[] | undefined {
  const merged = [...(inherited ?? []), ...(child ?? [])];
  return merged.length > 0 ? [...new Set(merged)] : undefined;
}

/** Keep the parent's captured bindings, even when the child discovers a different cwd. */
export function deriveChildCapabilityView(
  parent: RunCapabilityView | undefined,
  child: AgentChildSpawnInput,
): RunCapabilityView | undefined {
  if (!parent) return undefined;
  const serverIds = new Set<string>();
  for (const required of child.requiredMcpServers ?? []) {
    const matches = [...parent.mcpServers.values()].filter((server) => server.serverId === required || server.serverName === required);
    if (matches.length !== 1) throw new Error(`MCP dependency is ${matches.length ? "ambiguous" : "outside parent run"}: ${required}`);
    serverIds.add(matches[0]!.serverId);
  }
  const allowed = child.allowedTools && new Set(canonicalToolNames(child.allowedTools));
  const denied = new Set(canonicalToolNames(child.disallowedTools ?? []));
  const permits = (name: string) =>
    (!allowed || allowed.has("*") || allowed.has(canonicalToolName(name))) &&
    !denied.has("*") && !denied.has(canonicalToolName(name));
  const mcpServers = child.requiredMcpServers === undefined ? parent.mcpServers
    : readonlyMap([...parent.mcpServers].filter(([id]) => serverIds.has(id)));
  return Object.freeze({
    ...parent,
    tools: readonlyMap([...parent.tools].filter(([name, binding]) => permits(name) && (!binding.serverId || mcpServers.has(binding.serverId)))),
    mcpServers,
  });
}
