import type {
  AgentBackgroundShellHost,
  AgentScheduleEffects,
} from "@vykor/core";
import type { WorkflowRunRepository } from "@vykor/coordinator";
import type { AgentJobHost } from "@vykor/jobs";
import type { AgentTerminalHost } from "@vykor/terminal";

import type {
  AgentCapabilityOverrides,
  CapabilityOverride,
} from "./agent-options.js";
import type { AgentChildEnvironmentProvider } from "./child-environment.js";
import type { AgentMemoryRuntime } from "./memory-runtime.js";

export type ResolvedCapability<T> =
  | { status: "available"; value: T; source: "default" | "override" }
  | { status: "disabled" }
  | { status: "unavailable"; reason: string };

export interface ResolvedAgentCapabilities {
  terminal: ResolvedCapability<AgentTerminalHost>;
  backgroundShell: ResolvedCapability<AgentBackgroundShellHost>;
  jobs: ResolvedCapability<AgentJobHost>;
  memory: ResolvedCapability<AgentMemoryRuntime>;
  childEnvironment: ResolvedCapability<AgentChildEnvironmentProvider>;
  workflowRepository: ResolvedCapability<WorkflowRunRepository>;
  schedules: ResolvedCapability<AgentScheduleEffects>;
}

export type CapabilitySnapshot =
  | { status: "available"; source: "default" | "override" }
  | { status: "disabled" }
  | { status: "unavailable"; reason: string };

export type AgentCapabilitySnapshot = {
  [K in keyof ResolvedAgentCapabilities]: CapabilitySnapshot;
};

export async function resolveCapability<T>(
  override: CapabilityOverride<T> | undefined,
  createDefault: () => Promise<T>,
): Promise<ResolvedCapability<T>> {
  if (override === false) return disabledCapability();
  if (override !== undefined) {
    return { status: "available", value: override, source: "override" };
  }
  return {
    status: "available",
    value: await createDefault(),
    source: "default",
  };
}

export function disabledCapability<T = never>(): ResolvedCapability<T> {
  return { status: "disabled" };
}

export function unavailableCapability<T = never>(
  reason: string,
): ResolvedCapability<T> {
  return { status: "unavailable", reason };
}

export function toCapabilitySnapshot<T>(
  capability: ResolvedCapability<T>,
): CapabilitySnapshot {
  switch (capability.status) {
    case "available":
      return { status: "available", source: capability.source };
    case "disabled":
      return disabledCapability();
    case "unavailable":
      return unavailableCapability(capability.reason);
  }
}

export function toAgentCapabilitySnapshot(
  capabilities: ResolvedAgentCapabilities,
): AgentCapabilitySnapshot {
  return {
    terminal: toCapabilitySnapshot(capabilities.terminal),
    backgroundShell: toCapabilitySnapshot(capabilities.backgroundShell),
    jobs: toCapabilitySnapshot(capabilities.jobs),
    memory: toCapabilitySnapshot(capabilities.memory),
    childEnvironment: toCapabilitySnapshot(capabilities.childEnvironment),
    workflowRepository: toCapabilitySnapshot(capabilities.workflowRepository),
    schedules: toCapabilitySnapshot(capabilities.schedules),
  };
}

export function assertJobConfiguration(
  overrides: AgentCapabilityOverrides,
): void {
  if (overrides.jobs !== false) return;

  const producers: Array<[keyof AgentCapabilityOverrides, string]> = [
    ["terminal", "terminal"],
    ["backgroundShell", "background shell"],
    ["childEnvironment", "child environment"],
    ["workflowRepository", "workflow repository"],
  ];
  for (const [key, name] of producers) {
    if (overrides[key] !== false) {
      throw new Error(`Jobs are disabled; ${name} must also be disabled.`);
    }
  }
}
