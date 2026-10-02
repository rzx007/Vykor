import type { ContentBlock } from "../index";
import type { ToolContext, ToolDefinition } from "../types/tools";

const DEFAULT_TOOL_TIMEOUT_MS = 300_000;

function readPositiveIntEnv(name: string, defaultValue: number, minimum: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return defaultValue;
  return Math.max(minimum, parsed);
}

export function readToolOutputInlineChars(): number {
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
  const inlineChars = readToolOutputInlineChars();
  const previewChars = toolOutputPreviewChars();
  const totalText = content.reduce((sum, b) => sum + (b.type === "text" ? b.text.length : 0), 0);
  const reference = content.find((block) => block.type === "text" &&
    block.text.length <= 96 && /^\[tool-output-ref: \S+\]$/.test(block.text));
  let seenReference = false;
  const unique = content.filter((block) => {
    if (block.type !== "text" || block.text.length > 96 || !/^\[tool-output-ref: \S+\]$/.test(block.text)) return true;
    if (seenReference) return false;
    seenReference = true;
    return true;
  });
  if (totalText <= inlineChars) return unique;

  const noticeFor = (count: number) => `\n[输出已截断：原始长度 ${totalText} 字符，仅保留前 ${count} 字符]`;
  let remaining = Math.min(previewChars, Math.max(0, inlineChars - noticeFor(previewChars).length));
  let retained = 0;
  const out: ContentBlock[] = [];
  for (const block of unique) {
    if (block.type === "image") {
      out.push(block);
      continue;
    }
    if (block === reference) continue;
    if (remaining <= 0) continue;
    if (block.text.length <= remaining) {
      out.push(block);
      remaining -= block.text.length;
      retained += block.text.length;
    } else {
      out.push({ type: "text", text: block.text.slice(0, remaining) });
      retained += remaining;
      remaining = 0;
    }
  }
  out.push({ type: "text", text: noticeFor(retained) });
  if (reference) out.push(reference);
  return out;
}

export async function executeToolWithTimeout(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  context: ToolContext,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Awaited<ReturnType<ToolDefinition["execute"]>>> {
  const controller = new AbortController();
  const timeoutError = new ToolTimeoutError(timeoutMs);
  const deadlineAt = Date.now() + timeoutMs;
  let abortListener: (() => void) | undefined;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) {
    abortFromExternal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternal, {
      once: true,
    });
  }
  const timeout = setTimeout(() => {
    controller.abort(timeoutError);
  }, timeoutMs);
  timeout.unref?.();

  const timeoutPromise = new Promise<never>((_, reject) => {
    abortListener = () => reject(controller.signal.reason ?? timeoutError);
    if (controller.signal.aborted) {
      abortListener();
    } else {
      controller.signal.addEventListener("abort", abortListener, {
        once: true,
      });
    }
  });

  try {
    return await Promise.race([
      tool.execute(input, { ...context, abortSignal: controller.signal, deadlineAt }),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeout);
    if (abortListener) {
      controller.signal.removeEventListener("abort", abortListener);
    }
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}
