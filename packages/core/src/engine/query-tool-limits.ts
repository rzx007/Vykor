import type { ContentBlock } from "@vykor/agent-contracts";
import type { ToolContext, ToolDefinition } from "@vykor/agent-contracts";

export interface ToolOutputPolicy {
  inlineChars: number;
  previewChars: number;
}
const DEFAULT_TOOL_OUTPUT_POLICY: Readonly<ToolOutputPolicy> = Object.freeze({
  inlineChars: 16_000,
  previewChars: 3_000,
});

export function toolExecutionTimeoutMs(override: number | undefined): number {
  return typeof override === "number" &&
    Number.isInteger(override) &&
    override > 0
    ? override
    : 300_000;
}

export class ToolTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Tool execution timed out after ${timeoutMs} ms`);
    this.name = "ToolTimeoutError";
  }
}

/** Keep image blocks; truncate oversized text before it reaches model history. */
export function applyToolOutputBudget(
  content: ContentBlock[],
  policy: Readonly<ToolOutputPolicy> = DEFAULT_TOOL_OUTPUT_POLICY,
): ContentBlock[] {
  const { inlineChars, previewChars } = policy;
  const totalText = content.reduce(
    (sum, b) => sum + (b.type === "text" ? b.text.length : 0),
    0,
  );
  const reference = content.find(
    (block) =>
      block.type === "text" &&
      block.text.length <= 96 &&
      /^\[tool-output-ref: \S+\]$/.test(block.text),
  );
  let seenReference = false;
  const unique = content.filter((block) => {
    if (
      block.type !== "text" ||
      block.text.length > 96 ||
      !/^\[tool-output-ref: \S+\]$/.test(block.text)
    )
      return true;
    if (seenReference) return false;
    seenReference = true;
    return true;
  });
  if (totalText <= inlineChars) return unique;

  const noticeFor = (count: number) =>
    `\n[输出已截断：原始长度 ${totalText} 字符，仅保留前 ${count} 字符]`;
  let remaining = Math.min(
    previewChars,
    Math.max(0, inlineChars - noticeFor(previewChars).length),
  );
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
      tool.execute(input, {
        ...context,
        abortSignal: controller.signal,
        deadlineAt,
      }),
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
