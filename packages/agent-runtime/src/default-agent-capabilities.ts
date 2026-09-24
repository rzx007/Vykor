import type { Settings } from "@vykor/core";
import { FileWorkflowRunRepository } from "@vykor/coordinator";
import { CompositeAgentJobHost, type AgentJobHost } from "@vykor/jobs";
import { LocalAgentJobHost } from "@vykor/tools";
import type { AgentTerminalHost } from "@vykor/terminal";

import type {
  AgentCapabilityOverrides,
  AgentEffectOverrides,
  ObservableJobProducer,
  VykorAgentConfiguration,
} from "./agent-options.js";
import {
  assertJobConfiguration,
  disabledCapability,
  resolveCapability,
  unavailableCapability,
  type ResolvedAgentCapabilities,
  type ResolvedCapability,
} from "./capability-resolution.js";
import {
  AgentChildManager,
  type AgentChildEnvironmentProvider,
  type AgentChildManagerOptions,
  type AgentChildRegistry,
} from "./child-agent.js";
import { createDefaultChildEnvironmentProvider } from "./child-environment.js";
import type { CleanupStack } from "./cleanup-stack.js";
import type { DefaultNodeTerminalResolution } from "./default-node-terminal.js";
import type { AgentEventBus } from "./event-source.js";
import {
  createAgentMemoryRuntime,
  type AgentMemoryRuntime,
} from "./memory-runtime.js";

export interface ResolveDefaultAgentCapabilitiesOptions {
  settings: Settings;
  configuration: VykorAgentConfiguration;
  configurationForChild?: () => VykorAgentConfiguration;
  capabilityOverrides?: AgentCapabilityOverrides;
  effects?: AgentEffectOverrides;
  cwd: string;
  sessionId: string;
  childIdleTtlMs?: number;
  eventBus: AgentEventBus;
  childDirectory: AgentChildRegistry;
  createAgent: AgentChildManagerOptions["createAgent"];
  resolveDefaultTerminal(input: {
    override: AgentCapabilityOverrides["terminal"];
    cwd: string;
    sessionId: string;
  }): Promise<DefaultNodeTerminalResolution>;
  cleanup: CleanupStack;
}

export interface ResolvedDefaultAgentEnvironment {
  capabilities: ResolvedAgentCapabilities;
  childManager: AgentChildManager;
  memory: AgentMemoryRuntime | undefined;
}

/** Resolve Node defaults and host overrides into one capability snapshot. */
export async function resolveDefaultAgentCapabilities(
  options: ResolveDefaultAgentCapabilitiesOptions,
): Promise<ResolvedDefaultAgentEnvironment> {
  const overrides = options.capabilityOverrides ?? {};
  assertJobConfiguration(overrides);

  const childEnvironment = await resolveCapability(
    overrides.childEnvironment,
    async () => createDefaultChildEnvironmentProvider(),
  );
  const childManager = new AgentChildManager({
    settings: options.settings,
    configuration: options.configuration,
    configurationForChild: options.configurationForChild,
    capabilityOverrides: options.capabilityOverrides,
    effects: options.effects,
    cwd: options.cwd,
    idleTtlMs: options.childIdleTtlMs,
    eventBus: options.eventBus,
    directory: options.childDirectory,
    environment:
      capabilityValue(childEnvironment) ?? unavailableChildEnvironment(),
    onWarning: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
    createAgent: options.createAgent,
  });

  const workflowRepository = await resolveCapability(
    overrides.workflowRepository,
    async () => new FileWorkflowRunRepository({ cwd: options.cwd }),
  );
  const localJobs = overrides.jobs === false
    ? undefined
    : new LocalAgentJobHost({
        cwd: options.cwd,
        sessionId: options.sessionId,
        childManager,
        workflowRepository: capabilityValue(workflowRepository),
      });

  const jobSources: AgentJobHost[] = [];
  if (localJobs) jobSources.push(localJobs);
  const terminalResolution = await options.resolveDefaultTerminal({
    override: overrides.terminal,
    cwd: options.cwd,
    sessionId: options.sessionId,
  });
  let terminal: ResolvedCapability<AgentTerminalHost>;
  if (terminalResolution.status === "disabled") {
    terminal = disabledCapability();
  } else {
    jobSources.push(terminalResolution.value.jobs);
    terminal = {
      status: "available",
      value: terminalResolution.value.value,
      source: terminalResolution.source,
    };
    if (terminalResolution.source === "default") {
      options.cleanup.add(
        terminalResolution.cleanup,
        terminalResolution.cleanupIdentity,
      );
    }
  }

  const backgroundShell = overrides.backgroundShell === undefined
    ? localJobs
      ? {
          status: "available" as const,
          value: localJobs,
          source: "default" as const,
        }
      : unavailableCapability("Default Node runtime does not provide background shell")
    : resolveProducerOverride(
        overrides.backgroundShell,
        "Default Node runtime does not provide background shell",
        jobSources,
      );
  const jobs = overrides.jobs === false
    ? disabledCapability<AgentJobHost>()
    : {
        status: "available" as const,
        value: new CompositeAgentJobHost(jobSources),
        source: hasProducerOverride(overrides)
          ? "override" as const
          : "default" as const,
      };

  const memory = await resolveCapability(
    overrides.memory === false || options.settings.memory?.enabled === false
      ? false
      : undefined,
    async () => createAgentMemoryRuntime(
      options.cwd,
      options.settings.memory?.maxFiles ?? 10,
    ),
  );
  const capabilities: ResolvedAgentCapabilities = {
    terminal,
    backgroundShell,
    jobs,
    memory,
    childEnvironment,
    workflowRepository,
    schedules: resolveOptionalOverride(
      overrides.schedules,
      "Default Node runtime does not provide schedules",
    ),
  };

  return {
    capabilities,
    childManager,
    memory: capabilityValue(memory),
  };
}

function capabilityValue<T>(
  capability: ResolvedCapability<T>,
): T | undefined {
  return capability.status === "available" ? capability.value : undefined;
}

function resolveOptionalOverride<T>(
  override: T | false | undefined,
  unavailableReason: string,
): ResolvedCapability<T> {
  if (override === false) return disabledCapability();
  if (override !== undefined) {
    return { status: "available", value: override, source: "override" };
  }
  return unavailableCapability(unavailableReason);
}

function resolveProducerOverride<T>(
  override: ObservableJobProducer<T> | false | undefined,
  unavailableReason: string,
  jobSources: AgentJobHost[],
): ResolvedCapability<T> {
  if (override === false) return disabledCapability();
  if (override === undefined) return unavailableCapability(unavailableReason);
  jobSources.push(override.jobs);
  return { status: "available", value: override.value, source: "override" };
}

function hasProducerOverride(overrides: AgentCapabilityOverrides): boolean {
  return (
    overrides.terminal !== undefined && overrides.terminal !== false
  ) || (
    overrides.backgroundShell !== undefined && overrides.backgroundShell !== false
  );
}

function unavailableChildEnvironment(): AgentChildEnvironmentProvider {
  return {
    async acquire() {
      throw new Error("Child environment capability is not available");
    },
  };
}
