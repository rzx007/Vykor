/** Host configuration parsing; execution algorithms receive these resolved numbers. */
function positiveInt(name: string, fallback: number, minimum: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) ? Math.max(minimum, value) : fallback;
}

export function readToolOutputPolicy(): { inlineChars: number; previewChars: number } {
  return { inlineChars: positiveInt("VYKOR_TOOL_OUTPUT_INLINE_CHARS", 16_000, 256),
    previewChars: positiveInt("VYKOR_TOOL_OUTPUT_PREVIEW_CHARS", 3_000, 128) };
}

export function readToolExecutionTimeoutMs(override?: number): number {
  return typeof override === "number" && Number.isInteger(override) && override > 0 ? override
    : positiveInt("VYKOR_TOOL_TIMEOUT_MS", 300_000, 1);
}
