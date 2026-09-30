import type { ContentBlock } from "../index";

const DEFAULT_TOOL_TIMEOUT_MS = 300_000;

function readPositiveIntEnv(name: string, defaultValue: number, minimum: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return defaultValue;
  return Math.max(minimum, parsed);
}

function toolOutputInlineChars(): number {
  return readPositiveIntEnv("VYKOR_TOOL_OUTPUT_INLINE_CHARS", 16_000, 256);
}

function toolOutputPreviewChars(): number {
  return readPositiveIntEnv("VYKOR_TOOL_OUTPUT_PREVIEW_CHARS", 3_000, 128);
}

export function toolExecutionTimeoutMs(override: number | undefined): number {
  if (typeof override === "number" && Number.isInteger(override) && override > 0) return override;
  return readPositiveIntEnv("VYKOR_TOOL_TIMEOUT_MS", DEFAULT_TOOL_TIMEOUT_MS, 1);
}

export class ToolTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Tool execution timed out after ${timeoutMs} ms`);
    this.name = "ToolTimeoutError";
  }
}

/** Keep image blocks; truncate oversized text before it reaches model history. */
export function applyToolOutputBudget(content: ContentBlock[]): ContentBlock[] {
  const inlineChars = toolOutputInlineChars();
  const previewChars = toolOutputPreviewChars();

  const totalText = content.reduce((sum, b) => sum + (b.type === "text" ? b.text.length : 0), 0);
  if (totalText <= inlineChars) return content;

  const notice = `\n[输出已截断：原始长度 ${totalText} 字符，仅保留前 ${previewChars} 字符]`;
  let remaining = previewChars;
  const out: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === "image") {
      out.push(block);
      continue;
    }
    if (remaining <= 0) continue;
    if (block.text.length <= remaining) {
      out.push(block);
      remaining -= block.text.length;
    } else {
      out.push({ type: "text", text: block.text.slice(0, remaining) + notice });
      remaining = 0;
    }
  }
  return out;
}
