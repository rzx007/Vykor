import type { AgentChildSpawnInput } from "@vykor/agent-contracts";
import type { RunCapabilityView } from "../runtime/node-runtime-resources.js";

import type { Settings } from "@vykor/host-config";
import { canonicalToolName, canonicalToolNames } from "@vykor/agent-contracts";
import { settingsForApprovalMode } from "@vykor/sandbox";
import {
  readonlyMap,
  restrictRunCapabilityView,
} from "../plugins/run-capability-view.js";

import type { VykorAgentOptions } from "../agent/agent.js";
import type {
  AgentCapabilityOverrides,
  AgentEffectOverrides,
  VykorAgentConfiguration,
} from "../agent/agent-options.js";

export interface DeriveChildAgentOptionsInput {
  configuration: VykorAgentConfiguration;
  settings: Settings;
  capabilityOverrides?: AgentCapabilityOverrides;
  effects?: AgentEffectOverrides;
  child: AgentChildSpawnInput;
  cwd: string;
  sessionId: string;
  /** Trusted host-only flag: text execution without tools or integrations. */
  internalTextOnly?: boolean;
}

export interface ChildTurnBudgetInput {
  /** Explicit Agent-definition budget passed by the delegating tool or workflow. */
  roleMaxTurns?: number;
  /** Caller-requested cap from the Agent tool; it can only tighten. */
  requestedMaxTurns?: number;
  requestConfigurationMaxTurns?: number;
  settingsMaxTurns?: number;
}

/** Role budget > request configuration > settings; a caller request only tightens. */
export function resolveChildMaxTurns(
  input: ChildTurnBudgetInput,
): number | undefined {
  const base =
    input.roleMaxTurns ??
    input.requestConfigurationMaxTurns ??
    input.settingsMaxTurns;
  if (base === undefined || base === 0) return input.requestedMaxTurns;
  return input.requestedMaxTurns === undefined
    ? base
    : Math.min(base, input.requestedMaxTurns);
}

/** Derive one child runtime without widening the host's tool or capability boundary. */
export function deriveChildAgentOptions(
  input: DeriveChildAgentOptionsInput,
): VykorAgentOptions {
  const { configuration, child } = input;
  const childModel = child.model === "inherit" ? configuration.model ?? input.settings.model : child.model ?? configuration.model;
  const childEffort = child.effort !== "inherit" && isSupportedEffort(child.effort)
    ? child.effort
    : configuration.effort;
  const inheritsModel = childModel === configuration.model;
  const effortUnchanged = childEffort === configuration.effort;
  const { requestConfigurationStore: _parentReader, outputContract: _parentOutputContract, ...inherited } =
    configuration;
  const parentMode =
    configuration.permissionMode ??
    input.settings.permission?.mode ??
    "default";
  const parentApprovalMode =
    configuration.approvalMode ??
    (parentMode === "ask" ||
    parentMode === "auto_review" ||
    parentMode === "full_access"
      ? parentMode
      : undefined);
  const approvalMode =
    parentApprovalMode === "full_access" && child.permissionMode === "default"
      ? "ask"
      : parentApprovalMode;
  return {
    ...inherited,
    ownsExecutionEnvironment: false,
    approvalMode,
    requestConfigurationStore:
      configuration.requestConfigurationStoreForSession?.(input.sessionId),
    settings: settingsForApprovalMode(input.settings, approvalMode),
    cwd: input.cwd,
    sessionId: input.sessionId,
    model: child.model === "inherit" ? configuration.model ?? input.settings.model : child.model ?? configuration.model,
    systemPrompt: child.systemPrompt ?? configuration.systemPrompt,
    workMode:
      configuration.workMode === "plan" ||
      parentMode === "plan" ||
      child.permissionMode === "plan"
        ? "plan"
        : configuration.workMode,
    permissionMode:
      parentMode === "plan" || child.permissionMode === "plan"
        ? "plan"
        : parentMode !== "full_auto" && parentMode !== "full_access"
          ? parentMode
          : (child.permissionMode ?? parentMode),
    hostToolCeiling: configuration.hostToolCeiling,
    roleAllowedTools: child.allowedTools,
    ...(input.internalTextOnly ? { internalTextOnly: true } : {}),
    disallowedTools: mergeToolLists(
      configuration.disallowedTools,
      child.disallowedTools,
    ),
    maxTurns: resolveChildMaxTurns({
      roleMaxTurns: child.maxTurns,
      requestedMaxTurns: child.requestedMaxTurns,
      requestConfigurationMaxTurns: configuration.maxTurns,
      settingsMaxTurns: input.settings.maxTurns,
    }),
    effort: childEffort,
    reasoningEffort:
      inheritsModel && effortUnchanged
        ? configuration.reasoningEffort
        : undefined,
    tools: configuration.tools,
    toolOverrides: configuration.toolOverrides,
    trustedToolOverrides: configuration.trustedToolOverrides,
    // Carry host factories, never the parent's resolved execution ports.
    // Each child composition binds Terminal/Shell to its actual cwd/session
    // and rebuilds Memory, Workflow and Jobs through the same core.
    capabilityOverrides: input.capabilityOverrides,
    effects: input.effects,
  };
}

function isSupportedEffort(
  effort: string | undefined,
): effort is NonNullable<VykorAgentConfiguration["effort"]> {
  return typeof effort === "string" && effort.trim().length > 0;
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
  const availableServers = new Map([
    ...(parent.mcpAuthServers ?? []),
    ...parent.mcpServers,
  ]);
  for (const required of child.requiredMcpServers ?? []) {
    const matches = [...availableServers.values()].filter(
      (server) =>
        server.serverId === required || server.serverName === required,
    );
    if (matches.length !== 1)
      throw new Error(
        `MCP dependency is ${matches.length ? "ambiguous" : "outside parent run"}: ${required}`,
      );
    serverIds.add(matches[0]!.serverId);
  }
  const allowed =
    child.allowedTools && new Set(canonicalToolNames(child.allowedTools));
  const denied = new Set(canonicalToolNames(child.disallowedTools ?? []));
  const permits = (name: string) =>
    (!allowed || allowed.has("*") || allowed.has(canonicalToolName(name))) &&
    !denied.has("*") &&
    !denied.has(canonicalToolName(name));
  const mcpServers =
    child.requiredMcpServers === undefined
      ? parent.mcpServers
      : readonlyMap([...parent.mcpServers].filter(([id]) => serverIds.has(id)));
  const mcpAuthServers =
    child.requiredMcpServers === undefined
      ? parent.mcpAuthServers
      : readonlyMap(
          [...(parent.mcpAuthServers ?? parent.mcpServers)].filter(([id]) =>
            serverIds.has(id),
          ),
        );
  return restrictRunCapabilityView(
    { ...parent, mcpServers, mcpAuthServers },
    permits,
  );
}
