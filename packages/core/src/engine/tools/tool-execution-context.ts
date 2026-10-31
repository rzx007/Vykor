import type {
  AgentExecutionContext,
  ToolContext,
  ToolDiscovery,
  ToolExecutionResult,
  ToolUseBlock,
  PermissionChecker,
} from "@vykor/agent-contracts";
import { toolRegistryView } from "./tool-registry";
import { requestToolPermission } from "./tool-permission-request";
import type { MutableToolRegistry as ToolRegistry } from "@vykor/agent-contracts";

export interface ToolExecutionContextOptions {
  projectInstructions?: ToolContext["projectInstructions"];
  cwd: string;
  sessionId?: string;
  environment?: ToolContext["environment"];
  toolUse: ToolUseBlock;
  toolAttemptId: string;
  signal?: AbortSignal;
  execution?: AgentExecutionContext;
  requestConfiguration?: ToolContext["requestConfiguration"];
  setPlanMode?: ToolContext["setPlanMode"];
  toolRegistry: ToolRegistry;
  permissionChecker: PermissionChecker;
  toolDiscovery?: ToolDiscovery;
  readToolResult(id: string): ToolExecutionResult | undefined;
  invokeTool?: ToolContext["invokeTool"];
}

/** Builds only generic execution data; concrete capabilities live in tool factories. */
export function createToolExecutionContext(
  options: ToolExecutionContextOptions,
): ToolContext {
  const { execution } = options;
  const requestPermission: NonNullable<ToolContext["requestPermission"]> = (request, requestOptions) => requestToolPermission(request, {
    permissionChecker: options.permissionChecker,
    toolRegistry: options.toolRegistry,
    execution,
    signal: AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      ...(requestOptions?.signal ? [requestOptions.signal] : []),
    ]),
  });
  const agent: AgentExecutionContext | undefined = execution && {
    ...execution,
    effects: { ...execution.effects, requestPermission: (request, scope) => requestPermission(request, { signal: scope.signal }) },
  };
  return {
    cwd: options.cwd,
    ...(options.projectInstructions ? { projectInstructions: options.projectInstructions } : {}),
    sessionId: options.sessionId,
    ...(options.environment ? { environment: options.environment } : {}),
    toolCallId: options.toolUse.id,
    toolAttemptId: options.toolAttemptId,
    runAbortSignal: options.signal,
    setPlanMode: options.setPlanMode,
    ...(options.requestConfiguration
      ? { requestConfiguration: options.requestConfiguration }
      : {}),
    toolRegistry: toolRegistryView(options.toolRegistry),
    ...(options.toolDiscovery ? { toolDiscovery: options.toolDiscovery } : {}),
    readToolResult: options.readToolResult,
    ...(execution?.toolResults ? { toolResults: execution.toolResults } : {}),
    invokeTool: options.invokeTool,
    ...(execution?.effects?.askUserPrompt
      ? {
          askUserPrompt: (question: string) =>
            execution.effects.askUserPrompt!(question, execution.scope),
        }
      : {}),
    requestPermission,
    agent,
  };
}
