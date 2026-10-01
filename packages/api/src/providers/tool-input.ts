import type { ToolUseBlock } from "@vykor/core";

/** Keep malformed calls in the conversation so the model can correct them. */
export function parseToolInput(value: unknown): Pick<ToolUseBlock, "input" | "inputError"> {
  const argumentLength = typeof value === "string" ? value.length : 0;
  let parsed: unknown;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      // SyntaxError.message may quote private content; retain only its position.
      const position = error instanceof Error ? /\bposition (\d+)\b/.exec(error.message)?.[1] : undefined;
      return {
        input: {},
        inputError: {
          reason: "invalid_json",
          argumentLength,
          ...(position !== undefined ? { position: Number(position) } : {}),
        },
      };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { input: {}, inputError: { reason: "invalid_shape", argumentLength } };
  }
  return { input: parsed as Record<string, unknown> };
}
