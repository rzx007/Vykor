import { NodeChildManager, type NodeChildManagerOptions } from "../children/node-child-manager.js";
import type { AgentChildManager } from "../../kernel/children/child-agent.js";
import type { ExecutionRuntimeOwner } from "@vykor/execution-node";
import type { Settings } from "@vykor/host-config";
import { FileWorkflowRunRepository } from "../workflow/file-workflow-run-repository.js";
import { type AgentJobHost } from "@vykor/jobs";
import { createNodeJobBindings } from "../jobs/node-job-bindings.js";
import type { WorkflowHostDirectory } from "../workflow/workflow-host-directory.js";
import type { BoundWorkflowHost } from "../workflow/workflow-host.js";
import type { AgentDefinition } from "@vykor/coordinator/definitions";
import type { AgentTerminalHost } from "@vykor/terminal";

import type {
  AgentCapabilityOverrides,
  AgentEffectOverrides,
  VykorAgentConfiguration,
} from "../agent/agent-options.js";
import {
  disabledCapability,
  resolveCapability,
  unavailableCapability,
  type ResolvedAgentCapabilities,
  type ResolvedCapability,
} from "./capability-resolution.js";
import {
  type AgentChildEnvironmentProvider,
  type AgentChildRegistry,
} from "../../kernel/children/child-agent.js";
import { createDefaultChildEnvironmentProvider } from "../children/child-environment.js";
import type { CleanupStack } from "../runtime/cleanup-stack.js";
import type { DefaultNodeTerminalResolution } from "../environment/default-node-terminal.js";
import type { AgentEventBus } from "../../kernel/event-source.js";
import {
  createAgentMemoryRuntime,
  type AgentMemoryRuntime,
} from "../memory/memory-runtime.js";

export interface ResolveDefaultAgentCapabilitiesOptions {
  runCatalogue?:import("./node-run-catalogue.js").NodeRunCatalogue;
  workflowHosts: WorkflowHostDirectory;
  agentDefinitions: readonly AgentDefinition[];
  executionOwner: ExecutionRuntimeOwner;
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
  createAgent: NodeChildManagerOptions["createAgent"];
  resolveDefaultTerminal(input: {
    override: AgentCapabilityOverrides["terminal"];
    cwd: string;
    sessionId: string;
  }): Promise<DefaultNodeTerminalResolution>;
  cleanup: CleanupStack;
}

export interface ResolvedDefaultAgentEnvironment {
  workflowHost?: import("../workflow/workflow-host.js").WorkflowHost;
  workflowTool?: BoundWorkflowHost;
  capabilities: ResolvedAgentCapabilities;
  jobs: AgentJobHost;
  childManager: AgentChildManager;
  memory: AgentMemoryRuntime | undefined;
}

/** Resolve Node defaults and host overrides into one capability snapshot. */
export async function resolveDefaultAgentCapabilities(
  options: ResolveDefaultAgentCapabilitiesOptions,
): Promise<ResolvedDefaultAgentEnvironment> {
  const overrides = options.capabilityOverrides ?? {};

  const childEnvironment = await resolveCapability(
    overrides.childEnvironment,
    async () => createDefaultChildEnvironmentProvider(),
  );
  const childManager = new NodeChildManager({
    runCatalogue:options.runCatalogue,
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
  const repository = capabilityValue(workflowRepository);
  const workflowHost = repository ? options.workflowHosts.get(repository) : undefined;
  const workflowTool = workflowHost ? workflowHost.bind({
    cwd: options.cwd, sessionId: options.sessionId,
    children: childManager, executionOwner: options.executionOwner, definitions: options.agentDefinitions,
    stopTask: async (id, reason, runId) => {
      const child = childManager.get(id);
      if (child) { const expected = runId ?? child.runId; if (expected) { await child.interruptRun(expected, reason ?? "Workflow cancelled"); await child.waitRun(expected); } return; }
      return await options.executionOwner.getDetachedProcessSupervisor({ cwd: options.cwd, sessionId: options.sessionId }).stopExecution(id);
    },
  }) : undefined;
  if (workflowTool) options.cleanup.add(() => workflowTool.close(), workflowTool);
  const terminalResolution = await options.resolveDefaultTerminal({
    override: overrides.terminal,
    cwd: options.cwd,
    sessionId: options.sessionId,
  });
  let terminal: ResolvedCapability<AgentTerminalHost>;
  if (terminalResolution.status === "disabled") {
    terminal = disabledCapability();
  } else {
    terminal = {
      status: "available",
      value: terminalResolution.value.value,
      source: terminalResolution.source,
    };
    {
      options.cleanup.add(
        terminalResolution.cleanup,
        terminalResolution.cleanupIdentity,
      );
    }
  }

  const processes = options.executionOwner.getDetachedProcessSupervisor({ cwd: options.cwd, sessionId: options.sessionId });
  const archive = options.configuration.jobArchiveForSession?.(options.sessionId);
  const bindings = createNodeJobBindings({
    child: { processes, cwd: options.cwd, sessionId: options.sessionId, children: childManager, archive: archive?.agent,
      sendChildInput: (id, expectedRunId, input, authorization) => childManager.send(id, input, authorization ? new Map([...(authorization.delegatableTools ?? []), ...(authorization.tools ?? [])]) as ReadonlyMap<string, import("@vykor/agent-contracts").RunToolBinding> : undefined, authorization?.parent as import("../../kernel/children/child-agent.js").TrustedChildRunParent | undefined ?? null, expectedRunId) },
    process: { processes, cwd: options.cwd, sessionId: options.sessionId, admission: overrides.backgroundShell || undefined, archive: archive?.process },
    terminal: terminalResolution.status === "available" ? terminalResolution.value.jobs : undefined,
    workflow: workflowTool?.jobs,
  });
  const backgroundShell = overrides.backgroundShell === false ? disabledCapability<import("@vykor/tools").AgentBackgroundShellHost>() : { status: "available" as const, value: bindings.backgroundShell, source: overrides.backgroundShell ? "override" as const : "default" as const };
  const jobs = overrides.jobs === false ? disabledCapability<AgentJobHost>() : { status: "available" as const, value: bindings.jobs, source: "default" as const };

  const memory = await resolveCapability(
    overrides.memory === false || options.settings.memory?.enabled === false
      ? false
      : undefined,
    async () => createAgentMemoryRuntime(
      options.configuration.memoryRoot ?? options.cwd,
      options.settings.memory?.maxFiles ?? 10,
      options.sessionId,
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
    workflowHost,
    workflowTool,
    jobs: bindings.jobs,
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

function unavailableChildEnvironment(): AgentChildEnvironmentProvider {
  return {
    async acquire() {
      throw new Error("Child environment capability is not available");
    },
  };
}
