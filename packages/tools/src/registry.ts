import { ToolRegistry, type ToolExecutionSpec } from "@vykor/core";
import {
  agentTool,
  createAgentTool,
  teamCreateTool,
  teamDeleteTool,
  createWorkflowTool,
} from "./agent/index.js";
import type { AgentDefinition, WorkflowRunRepository } from "@vykor/coordinator";
import type { ExecutionEnvironmentHandle } from "@vykor/environment";
import { feishuPushTool } from "./channels/index.js";
import {
  fileEditTool,
  fileReadTool,
  fileWriteTool,
  globTool,
} from "./file/index.js";
import {
  askUserTool,
  briefTool,
  configTool,
  listSkillsTool,
  skillTool,
  sleepTool,
  todoWriteTool,
  toolSearchTool,
} from "./meta/index.js";
import {
  enterPlanModeTool,
  enterWorktreeTool,
  exitPlanModeTool,
  exitWorktreeTool,
} from "./mode/index.js";
import {
  listMcpResourcesTool,
  mcpAuthTool,
  mcpToolCallTool,
  readMcpResourceTool,
} from "./mcp/index.js";
import { notebookEditTool } from "./notebook/index.js";
import {
  scheduleCreateTool,
  scheduleDeleteTool,
  scheduleListTool,
  scheduleRunNowTool,
  scheduleUpdateTool,
} from "./schedule/index.js";
import { grepTool, lspTool } from "./search/index.js";
import { createShellTool } from "./shell/index.js";
import { createBackgroundShellTool } from "./background-shell/index.js";
import { webFetchTool, webSearchTool } from "./web/index.js";
import { terminalTools } from "./terminal/index.js";
import { jobTools } from "./job/index.js";

export function createDefaultToolRegistry(
  options: {
    schedules?: boolean;
    terminal?: boolean;
    jobs?: boolean;
    backgroundShell?: boolean;
    childEnvironment?: boolean;
    agentDefinitions?: AgentDefinition[];
    workflowRepository?: WorkflowRunRepository;
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
    createShellTool(options.environment?.info.shellDescriptor, undefined),
    environment(),
  );
  registerBuiltin(fileReadTool, environment());
  registerBuiltin(fileWriteTool, environment());
  registerBuiltin(fileEditTool, environment());
  registerBuiltin(globTool, environment());
  registerBuiltin(grepTool, environment());
  registerBuiltin(webFetchTool, controlPlane(true));
  registerBuiltin(webSearchTool, controlPlane(true));
  registerBuiltin(todoWriteTool, controlPlane());
  registerBuiltin(configTool, controlPlane());
  registerBuiltin(sleepTool, controlPlane());
  registerBuiltin(skillTool, controlPlane());
  registerBuiltin(listSkillsTool, controlPlane());
  registerBuiltin(toolSearchTool, controlPlane());
  registerBuiltin(askUserTool, controlPlane());
  registerBuiltin(briefTool, controlPlane());
  if (options.backgroundShell !== false) {
    registerBuiltin(
      createBackgroundShellTool(options.environment?.info.shellDescriptor),
      environment(),
    );
  }
  registerBuiltin(enterPlanModeTool, controlPlane());
  registerBuiltin(exitPlanModeTool, controlPlane());
  registerBuiltin(enterWorktreeTool, localEnvironment());
  registerBuiltin(exitWorktreeTool, localEnvironment());
  registerBuiltin(notebookEditTool, localEnvironment());
  if (options.childEnvironment !== false) {
    registerBuiltin(
      options.agentDefinitions === undefined
        ? agentTool
        : createAgentTool({ agentDefinitions: options.agentDefinitions }),
      controlPlane(),
    );
  }
  if (options.workflowRepository) {
    registerBuiltin(createWorkflowTool({ repository: options.workflowRepository }), controlPlane());
  }
  registerBuiltin(teamCreateTool, controlPlane());
  registerBuiltin(teamDeleteTool, controlPlane());
  if (options.schedules) {
    registerBuiltin(scheduleCreateTool, controlPlane());
    registerBuiltin(scheduleUpdateTool, controlPlane());
    registerBuiltin(scheduleDeleteTool, controlPlane());
    registerBuiltin(scheduleListTool, controlPlane());
    registerBuiltin(scheduleRunNowTool, controlPlane());
  }
  if (options.terminal) {
    for (const tool of terminalTools) registerBuiltin(tool, environment());
  }
  if (options.jobs) {
    for (const tool of jobTools) registerBuiltin(tool, controlPlane());
  }
  registerBuiltin(mcpToolCallTool, controlPlane(true));
  registerBuiltin(listMcpResourcesTool, controlPlane(true));
  registerBuiltin(readMcpResourceTool, controlPlane(true));
  registerBuiltin(mcpAuthTool, controlPlane(true));
  registerBuiltin(lspTool, environment());
  registerBuiltin(feishuPushTool, controlPlane(true));
  return registry;
}
