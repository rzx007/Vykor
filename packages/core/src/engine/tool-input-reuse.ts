import type { Message, ToolUseBlock } from "../types/messages";
import type { ToolDefinition, ToolExecutionResult } from "../types/tools";

function reusableInput(
  toolName: string,
  sourceId: string,
  property: string,
  history: readonly Message[],
  batchIds: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (batchIds.has(sourceId)) return undefined;
  let source: ToolUseBlock | undefined;
  let sourceIndex = -1;
  let matches = 0;
  let batchIndex = history.length;
  // ponytail: scan retained history on reference use; index only if profiling warrants it.
  for (const [index, message] of history.entries()) {
    if (message.type !== "assistant") continue;
    for (const call of message.toolUses ?? []) {
      if (batchIds.has(call.id)) batchIndex = Math.min(batchIndex, index);
      if (call.id === sourceId) {
        matches++;
        source = call;
        sourceIndex = index;
      }
    }
  }
  if (matches !== 1 || !source || source.name !== toolName || source.inputError
    || typeof source.input[property] !== "string") return undefined;
  const settled = history.some((message, index) => index > sourceIndex && index < batchIndex
    && message.type === "tool_result" && message.toolUseId === sourceId);
  return settled ? source.input : undefined;
}

export function resolveToolInputReuse(
  tool: ToolDefinition,
  toolUse: ToolUseBlock,
  history: readonly Message[],
  batchIds: ReadonlySet<string>,
): Record<string, unknown> {
  if (!tool.inputReuse) return toolUse.input;
  const { property, referenceProperty } = tool.inputReuse;
  const input = toolUse.input;
  const hasContent = Object.hasOwn(input, property);
  const hasReference = Object.hasOwn(input, referenceProperty);
  if (hasContent === hasReference) {
    throw new Error(`Provide exactly one of ${property} or ${referenceProperty}.`);
  }
  if (hasContent) {
    if (typeof input[property] !== "string") throw new Error(`${property} must be a string.`);
    return input;
  }
  const sourceId = input[referenceProperty];
  if (typeof sourceId !== "string" || sourceId.length === 0) {
    throw new Error(`${referenceProperty} must be a non-empty tool call ID.`);
  }
  const source = reusableInput(tool.name, sourceId, property, history, batchIds);
  if (!source) {
    throw new Error(`Cannot resolve ${referenceProperty}: source must be a unique, settled ${tool.name} call with retained string ${property}.`);
  }
  const resolved = { ...input, [property]: source[property] };
  delete resolved[referenceProperty];
  return resolved;
}

export function withToolInputReuseHint(
  tool: ToolDefinition | undefined,
  toolUse: ToolUseBlock,
  result: ToolExecutionResult,
  history: readonly Message[],
): ToolExecutionResult {
  if (!result.isError || !tool?.inputReuse || toolUse.inputError) return result;
  const { property, referenceProperty } = tool.inputReuse;
  const settledHistory: Message[] = [...history, {
    type: "tool_result", toolUseId: toolUse.id, content: result.content,
  }];
  if (!reusableInput(tool.name, toolUse.id, property, settledHistory, new Set())) return result;
  const stateHint = result.executionState === "unknown" ? "Inspect the target state first; the previous outcome is unknown. " : "";
  const text = `${stateHint}${property} in the current retained history is available to ${tool.name} through ${referenceProperty}=${JSON.stringify(toolUse.id)} instead of resending it. Restoration or compaction may invalidate this reference. Supply the target and corrected options explicitly; this only reuses data, and normal permissions and state checks still apply.`;
  if (text.length > 1000) return result;
  return { ...result, content: [...result.content, { type: "text", text }] };
}
