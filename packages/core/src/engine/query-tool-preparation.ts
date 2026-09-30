import type { ToolUseBlock } from "../index";
import type { ToolExecutionResult, ToolRegistry } from "../types/tools";
import type { ToolFailureMemory } from "./tool-failure-memory";
import { normalizeToolInput, validateToolInput } from "./tool-input-schema";

export type PreparedToolCall = {
  idx: number;
  toolUse: ToolUseBlock;
  tool: NonNullable<ReturnType<ToolRegistry["get"]>>;
};

export function prepareToolCalls(
  toolUses: ToolUseBlock[],
  failedToolCalls: ToolFailureMemory | undefined,
  toolRegistry: ToolRegistry,
): {
  results: ToolExecutionResult[];
  readyForPermission: PreparedToolCall[];
} {
  const results: ToolExecutionResult[] = new Array(toolUses.length);
  const readyForPermission: PreparedToolCall[] = [];

  for (let i = 0; i < toolUses.length; i++) {
    const toolUse = toolUses[i]!;

    if (failedToolCalls?.shouldReplayFailure(toolUse.name, toolUse.input)) {
      results[i] = {
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        content: [
          {
            type: "text" as const,
            text: "Tool call already failed with the same input. Do not repeat it unless the input or underlying condition changes; choose another approach or explain the blocker.",
          },
        ],
        isError: true,
        failureKind: "policy",
        executionState: "not_started",
        metadata: { recoveryGuard: "repeated_failed_call" },
      };
      continue;
    }

    const tool = toolRegistry.get(toolUse.name);
    if (!tool) {
      results[i] = {
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        content: [{ type: "text" as const, text: `Unknown tool: ${toolUse.name}` }],
        isError: true,
        failureKind: "invalid_input",
        executionState: "not_started",
      };
      continue;
    }

    toolUse.input = normalizeToolInput(tool.inputSchema, toolUse.input) as Record<
      string,
      unknown
    >;

    const validationError = validateToolInput(tool.inputSchema, toolUse.input);
    if (validationError) {
      results[i] = {
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        content: [
          {
            type: "text" as const,
            text: `Tool input validation failed: ${validationError}`,
          },
        ],
        isError: true,
        failureKind: "invalid_input",
        executionState: "not_started",
      };
      continue;
    }

    readyForPermission.push({ idx: i, toolUse, tool });
  }

  return { results, readyForPermission };
}
