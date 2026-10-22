import type {
  AgentExecutionContext,
  ToolContext,
  ToolDiscovery,
  ToolExecutionResult,
  ToolUseBlock,
} from "@vykor/agent-contracts";
import { toolRegistryView } from "./tool-registry";
import type { MutableToolRegistry as ToolRegistry } from "@vykor/agent-contracts";

export interface ToolExecutionContextOptions {
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
  toolDiscovery?: ToolDiscovery;
  readToolResult(id: string): ToolExecutionResult | undefined;
  invokeTool?: ToolContext["invokeTool"];
}

/** Builds only generic execution data; concrete capabilities live in tool factories. */
export function createToolExecutionContext(
  options: ToolExecutionContextOptions,
): ToolContext {
  const { execution } = options;
  return {
    cwd: options.cwd,
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
    invokeTool: options.invokeTool,
    ...(execution?.effects?.askUserPrompt
      ? {
          askUserPrompt: (question: string) =>
            execution.effects.askUserPrompt!(question, execution.scope),
        }
      : {}),
    ...(execution?.effects?.requestPermission
      ? {
          requestPermission: (request) =>
            execution.effects.requestPermission!(request, execution.scope),
        }
      : {}),
    agent: execution,
  };
}
