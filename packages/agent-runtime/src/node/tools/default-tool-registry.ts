import {
  applyPatchTool,
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
  fileEditTool,
  fileReadTool,
  fileWriteTool,
  globTool,
  grepTool,
  notebookEditTool,
  sleepTool,
  todoWriteTool,
  toolSearchTool,
  webFetchTool,
  webSearchTool,
} from "@vykor/tools";
import type { ExecutionRuntimeOwner } from "@vykor/execution-node";
import { ToolRegistry, type ToolExecutionSpec } from "@vykor/core";
import type { AgentDefinition } from "@vykor/coordinator/definitions";
import {
  createTeamRegistry,
  narrowTeamPort,
  type TeamPort,
} from "@vykor/coordinator/teams";
import type { AgentJobHost } from "@vykor/jobs";
import type { AgentTerminalHost } from "@vykor/terminal";
import type { AgentScheduleEffects } from "@vykor/core";
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
import { loadNodeAgentDefinitions } from "../definitions.js";
import type { ExecutionEnvironmentHandle } from "@vykor/environment";

export function createDefaultToolRegistry(
  options: {
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
    createShellTool(options.environment?.info.shellDescriptor, undefined, options.terminal),
    environment(),
  );
  registerBuiltin(fileReadTool, environment());
  registerBuiltin(fileWriteTool, environment());
  registerBuiltin(fileEditTool, environment());
  registerBuiltin(applyPatchTool, environment());
  registerBuiltin(globTool, environment());
  registerBuiltin(grepTool, environment());
  registerBuiltin(webFetchTool, controlPlane(true));
  registerBuiltin(webSearchTool, controlPlane(true));
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
  registerBuiltin(askUserTool, controlPlane());
  registerBuiltin(briefTool, controlPlane());
  if (options.backgroundShell !== false) {
    registerBuiltin(
      createBackgroundShellTool(options.environment?.info.shellDescriptor, options.terminal),
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
    registerBuiltin(createWorkflowTool(options.workflow), controlPlane());
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
    for (const tool of createJobTools(options.jobs))
      registerBuiltin(tool, controlPlane());
  }
  for (const tool of createMcpTools(options.mcp ?? createNodeMcpPort()))
    registerBuiltin(tool, controlPlane(true));
  registerBuiltin(
    createLspTool(
      options.executionOwner?.withLspClient.bind(options.executionOwner),
    ),
    environment(),
  );
  registerBuiltin(
    createFeishuPushTool(options.channels ?? createNodeFeishuChannelPort()),
    controlPlane(true),
  );
  return registry;
}
