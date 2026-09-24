/**
 * 工具输出上下文预算。
 *
 * 三个字符阈值均可经环境变量覆盖（非法值回退默认、低于下限钳制）：
 * - inline：工具结果整段内联进上下文的上限；
 * - preview：被外置后保留的预览长度；
 * - microcompact：老工具结果可被「微压缩」清理的体量门槛。
 */

export const DEFAULT_TOOL_OUTPUT_INLINE_CHARS = 16_000;
export const DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS = 3_000;
export const DEFAULT_MICROCOMPACT_TOOL_RESULT_CHARS = 4_000;

function readPositiveIntEnv(name: string, defaultValue: number, minimum: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return defaultValue;
  return Math.max(minimum, parsed);
}

export function toolOutputInlineChars(): number {
  return readPositiveIntEnv("VYKOR_TOOL_OUTPUT_INLINE_CHARS", DEFAULT_TOOL_OUTPUT_INLINE_CHARS, 256);
}

export function toolOutputPreviewChars(): number {
  return readPositiveIntEnv("VYKOR_TOOL_OUTPUT_PREVIEW_CHARS", DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS, 128);
}

export function microcompactToolResultChars(): number {
  return readPositiveIntEnv(
    "VYKOR_MICROCOMPACT_TOOL_RESULT_CHARS",
    DEFAULT_MICROCOMPACT_TOOL_RESULT_CHARS,
    256,
  );
}

/** 工具结果是否可被老结果清理：MCP 工具一律可；其余按体量门槛。 */
export function isMicrocompactableToolResult(toolName: string, content: string): boolean {
  const normalized = toolName.trim();
  if (normalized.startsWith("mcp__")) return true;
  return content.length >= microcompactToolResultChars();
}
