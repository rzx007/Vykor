import { type ToolExecutionSpec } from "@vykor/agent-contracts";
import type { AgentScheduleEffects } from "@vykor/host-config";
import {
  createApplyPatchTool,
  askUserTool,
  briefTool,
  createAgentTool,
  createBackgroundShellTool,
  createConfigTool,
  createFeishuPushTool,
  createJobTools,
  createLspTool,
  createMcpTools,
  createScheduleTools,
  createShellTool,
  createSkillTools,
  createTeamTools,
  createTerminalTools,
  createWorkflowTool,
  enterPlanModeTool,
  enterWorktreeTool,
  exitPlanModeTool,
  exitWorktreeTool,
  createFileEditTool,
  createFileReadTool,
  createFileWriteTool,
  createGlobTool,
  createGrepTool,
  notebookEditTool,
  sleepTool,
  todoWriteTool,
  toolSearchTool,
  createWebFetchTool,
  createWebSearchTool,
  createToolResultTool,
} from "@vykor/tools";
import type { ExecutionRuntimeOwner } from "@vykor/execution-node";
import { ToolRegistry, markToolResultReader, markTrustedReadOnlyTool } from "@vykor/core";
import type { AgentDefinition } from "@vykor/coordinator/definitions";
import {
  createTeamRegistry,
  narrowTeamPort,
  type TeamPort,
} from "@vykor/coordinator/teams";
import type { AgentJobHost } from "@vykor/jobs";
import type { AgentTerminalHost } from "@vykor/terminal";

import type {
  ConfigToolPort,
  FeishuChannelPort,
  McpToolPort,
  SkillCatalogPort,
  WorkflowToolPort,
} from "@vykor/tools";
import {
  createNodeConfigPort,
  createNodeFeishuChannelPort,
  createNodeMcpPort,
  createNodeSkillCatalog,
} from "./tool-ports.js";
import { loadNodeAgentDefinitions } from "../definitions/definitions.js";
import type { ExecutionEnvironmentHandle } from "@vykor/environment";

export function createDefaultToolRegistry(
  options: {
    toolDecorators?: readonly {
      name: string;
      decorate(
        base: import("@vykor/agent-contracts").ToolDefinition,
      ): import("@vykor/agent-contracts").ToolDefinition;
    }[];
    host?: import("@vykor/tools").FileToolHost &
      import("@vykor/tools").ShellToolHost;
    authorization?: import("@vykor/jobs").AgentJobAuthorization;
    backgroundShellHost?: import("@vykor/tools").AgentBackgroundShellHost;
    executionOwner?: ExecutionRuntimeOwner;
    schedules?: AgentScheduleEffects;
    terminal?: AgentTerminalHost;
    jobs?: AgentJobHost;
    backgroundShell?: boolean;
    childEnvironment?: boolean;
    agentDefinitions?: readonly AgentDefinition[];
    workflow?: WorkflowToolPort;
    teams?: TeamPort;
    skills?: SkillCatalogPort;
    config?: ConfigToolPort;
    mcp?: McpToolPort;
    channels?: FeishuChannelPort;
    environment?: ExecutionEnvironmentHandle;
  } = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  const registerBuiltin = (
    tool: Parameters<ToolRegistry["register"]>[0],
    execution: ToolExecutionSpec,
  ) => {
    tool.execution = execution;
    registry.register(tool, { kind: "builtin" });
  };
  const environment = (): ToolExecutionSpec => ({
    domain: "environment",
    supportedEnvironments: ["local", "wsl"],
  });
  const localEnvironment = (): ToolExecutionSpec => ({
    domain: "environment",
    supportedEnvironments: ["local"],
  });
  const controlPlane = (network = false): ToolExecutionSpec => ({
    domain: "control_plane",
    supportedEnvironments: ["local", "wsl"],
    ...(network ? { network: true } : {}),
  });
  registerBuiltin(
    createShellTool(
      options.environment?.info.shellDescriptor,
      undefined,
      options.terminal,
      { ...options.host, backgroundShell: options.backgroundShellHost },
    ),
    environment(),
  );
  registerBuiltin(markTrustedReadOnlyTool(createFileReadTool(options.host)), environment());
  registerBuiltin(createFileWriteTool(options.host), environment());
  registerBuiltin(createFileEditTool(options.host), environment());
  registerBuiltin(createApplyPatchTool(options.host), environment());
  registerBuiltin(markTrustedReadOnlyTool(createGlobTool(options.host)), environment());
  registerBuiltin(markTrustedReadOnlyTool(createGrepTool(options.host)), environment());
  registerBuiltin(
    createWebFetchTool(undefined, options.host),
    controlPlane(true),
  );
  registerBuiltin(
    createWebSearchTool(undefined, options.host),
    controlPlane(true),
  );
  registerBuiltin(todoWriteTool, controlPlane());
  registerBuiltin(
    createConfigTool(options.config ?? createNodeConfigPort()),
    controlPlane(),
  );
  registerBuiltin(sleepTool, controlPlane());
  for (const tool of createSkillTools(
    options.skills ?? createNodeSkillCatalog(),
  ))
    registerBuiltin(tool, controlPlane());
  registerBuiltin(toolSearchTool, controlPlane());
  registerBuiltin(markTrustedReadOnlyTool(markToolResultReader(createToolResultTool())), controlPlane());
  registerBuiltin(askUserTool, controlPlane());
  registerBuiltin(briefTool, controlPlane());
  if (options.backgroundShell !== false) {
    registerBuiltin(
      createBackgroundShellTool(
        options.environment?.info.shellDescriptor,
        options.terminal,
        { ...options.host, backgroundShell: options.backgroundShellHost },
      ),
      environment(),
    );
  }
  registerBuiltin(enterPlanModeTool, controlPlane());
  registerBuiltin(exitPlanModeTool, controlPlane());
  registerBuiltin(enterWorktreeTool, localEnvironment());
  registerBuiltin(exitWorktreeTool, localEnvironment());
  registerBuiltin(notebookEditTool, localEnvironment());
  const teams = options.teams ?? narrowTeamPort(createTeamRegistry());
  if (options.childEnvironment !== false) {
    registerBuiltin(
      createAgentTool({
        definitions: options.agentDefinitions ?? loadNodeAgentDefinitions(),
        teams,
      }),
      controlPlane(),
    );
  }
  if (options.workflow)
    registerBuiltin(
      createWorkflowTool(options.workflow, options.agentDefinitions),
      controlPlane(),
    );
  for (const tool of createTeamTools(teams))
    registerBuiltin(tool, controlPlane());
  if (options.schedules) {
    for (const tool of createScheduleTools(options.schedules))
      registerBuiltin(tool, controlPlane());
  }
  if (options.terminal) {
    for (const tool of createTerminalTools(options.terminal))
      registerBuiltin(tool, environment());
  }
  if (options.jobs) {
    for (const tool of createJobTools(options.jobs, options.authorization)) {
      if (tool.name === "JobList" || tool.name === "JobRead" || tool.name === "JobWait")
        markTrustedReadOnlyTool(tool);
      registerBuiltin(tool, controlPlane());
    }
  }
  for (const tool of createMcpTools(options.mcp ?? createNodeMcpPort()))
    registerBuiltin(tool, controlPlane(true));
  registerBuiltin(
    createLspTool(
      options.executionOwner?.withLspClient.bind(options.executionOwner),
      options.host,
    ),
    environment(),
  );
  registerBuiltin(
    createFeishuPushTool(options.channels ?? createNodeFeishuChannelPort()),
    controlPlane(true),
  );
  for (const decorator of options.toolDecorators ?? []) {
    const base = registry.get(decorator.name);
    if (!base)
      throw new Error(
        `Tool decorator target is unavailable: ${decorator.name}`,
      );
    const decorated = decorator.decorate(base);
    if (decorated.name !== base.name)
      throw new Error(
        `Tool decorator must preserve the tool name: ${base.name}`,
      );
    decorated.execution ??= base.execution;
    registry.override(decorated, { kind: "builtin" });
  }
  return registry;
}
