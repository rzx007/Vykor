import type { ContentBlock, Message, ToolContext, ToolExecutionResult, ToolResult } from "@vykor/agent-contracts";

function completeRule(text: string, key: string): boolean {
  return text.includes(`<project-instruction key="${key}"`) && text.includes(`</project-instruction key="${key}">`);
}

/** These bounded host blocks are context, so an ordinary result preview must not cut them in half. */
export function protectedProjectInstructionBlocks(result: Pick<ToolResult, "content" | "hostProjectInstructionKeys">): ContentBlock[] {
  const keys = validProjectInstructionKeys(result.hostProjectInstructionKeys) ?? [];
  let remaining = 42_000;
  return result.content.filter(block => {
    if (block.type !== "text" || !keys.some(key => completeRule(block.text, key))) return false;
    const bytes = Buffer.byteLength(block.text, "utf8");
    if (bytes > remaining) return false;
    remaining -= bytes;
    return true;
  });
}

export function validProjectInstructionKeys(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length <= 24 && value.every(key => typeof key === "string" && /^[a-f0-9]{64}$/.test(key))
    ? value : undefined;
}

export function hasProjectInstructionDelivery(result: ToolResult): boolean {
  return !!validProjectInstructionKeys(result.hostProjectInstructionKeys)?.length
    && protectedProjectInstructionBlocks(result).length > 0;
}

export function isProjectInstructionWait(result: ToolResult): boolean {
  return result.isError === true && result.failureKind === "precondition" && result.executionState === "not_started"
    && result.metadata?.hostProjectInstructionHardLimit !== true
    && validProjectInstructionKeys(result.hostProjectInstructionKeys) !== undefined;
}

/** Classify once from exactly the budgeted bodies retained for this model batch. */
export function projectInstructionProgress(results: readonly ToolExecutionResult[]): ReadonlySet<string> {
  if (!results.some(hasProjectInstructionDelivery)) return new Set();
  return new Set(results.filter(isProjectInstructionWait).map(result => result.toolUseId));
}

/** A fresh batch owns pending claims; only complete, host-marked visible history is reusable. */
export function projectInstructionState(
  messages: readonly Message[], canRead: NonNullable<ToolContext["projectInstructions"]>["canRead"],
): NonNullable<ToolContext["projectInstructions"]> {
  const visible = new Set<string>(), pending = new Set<string>();
  for (const message of messages) {
    if (message.type !== "tool_result") continue;
    const text = message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    for (const key of validProjectInstructionKeys(message.hostProjectInstructionKeys) ?? []) {
      if (completeRule(text, key)) visible.add(key);
    }
  }
  return { canRead, claim(key) {
    if (visible.has(key)) return "visible";
    if (pending.has(key)) return "pending";
    pending.add(key);
    return "new";
  } };
}
