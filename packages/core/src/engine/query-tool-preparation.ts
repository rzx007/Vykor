import type { Message, ToolUseBlock } from "../index";
import type { ToolExecutionResult, ToolRegistry } from "../types/tools";
import type { ToolFailureMemory } from "./tool-failure-memory";
import { normalizeToolInput, validateToolInput } from "./tool-input-schema";
import { resolveToolInputReuse } from "./tool-input-reuse";

export type PreparedToolCall = {
  idx: number;
  toolUse: ToolUseBlock;
  tool: NonNullable<ReturnType<ToolRegistry["get"]>>;
};

export function prepareToolCalls(
  toolUses: ToolUseBlock[],
  failedToolCalls: ToolFailureMemory | undefined,
  toolRegistry: ToolRegistry,
  history: readonly Message[] = [],
): {
  results: ToolExecutionResult[];
  readyForPermission: PreparedToolCall[];
} {
  const results: ToolExecutionResult[] = new Array(toolUses.length);
  const readyForPermission: PreparedToolCall[] = [];
  const batchIds = new Set(toolUses.map((call) => call.id));

  for (let i = 0; i < toolUses.length; i++) {
    const toolUse = toolUses[i]!;

    if (toolUse.inputError) {
      const error = toolUse.inputError;
      const detail = error.reason === "invalid_json" ? "arguments are not valid JSON" : "arguments must be a JSON object";
      const position = error.position !== undefined ? `; position=${error.position}` : "";
      const stopped = error.stopReason ? `; stopReason=${error.stopReason}` : "";
      results[i] = {
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        content: [{ type: "text", text: `Tool input parsing failed: ${detail}; argumentLength=${error.argumentLength}${position}${stopped}. The tool was not executed. Regenerate complete valid arguments; split large file writes into smaller changes if the output was truncated.` }],
        isError: true,
        failureKind: "invalid_input",
        executionState: "not_started",
        metadata: { toolInputError: error },
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

    try {
      toolUse.input = resolveToolInputReuse(tool, toolUse, history, batchIds);
    } catch (error) {
      results[i] = {
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        content: [{ type: "text", text: error instanceof Error ? error.message : "Cannot resolve tool input reference." }],
        isError: true,
        failureKind: "invalid_input",
        executionState: "not_started",
      };
      continue;
    }

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

    // Match the same effective input that is recorded after execution fails.
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

    readyForPermission.push({ idx: i, toolUse, tool });
  }

  return { results, readyForPermission };
}
