import { isContextLengthExceededMessage, ModelRequestFailure, type Message } from "@vykor/agent-contracts";
import type { CompactClient } from "./compact-types";
import { COMPACT_PROMPT } from "./compact-prompt";
import { buildCompactTranscript } from "./compact-transcript";

/** A completed model response that cannot safely replace conversation history. */
export class CompactSummaryValidationError extends Error {
  constructor(message = "Compaction requires one closed, non-empty <summary> section.", options?: ErrorOptions) {
    super(message, options);
    this.name = "CompactSummaryValidationError";
  }
}

/**
 * 把待摘要消息序列化成对话文本，拼进 prompt，流式收集摘要模型输出。
 * 转录器保留调用配对与有界参数，每条消息最多 4000 字符。
 */
// ---------------------------------------------------------------------------
// 错误分类：识别 llama.cpp / OpenAI 兼容接口的「上下文溢出」类错误
// ---------------------------------------------------------------------------

/**
 * 判断错误是否属于 Prompt Too Long（上下文溢出）。
 * 主请求与摘要共用这一窄匹配；有提供商结构化标记时由调用方优先使用。
 */
export function isPromptTooLongError(err: unknown): boolean {
  if (err instanceof ModelRequestFailure) {
    if (err.info.kind !== "invalid_request") return false;
    if (err.info.contextLengthExceeded !== undefined) return err.info.contextLengthExceeded;
  }
  const text = String(
    err instanceof Error ? err.message : err,
  ).toLowerCase();
  return isContextLengthExceededMessage(text);
}

export async function collectSummary(
  client: CompactClient | undefined,
  messages: Message[],
  customPrompt?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!client) throw new Error("No LLM client");

  const conversationText = buildCompactTranscript(messages);

  const basePrompt = customPrompt ?? COMPACT_PROMPT;
  const prompt = `${basePrompt}\n\n<conversation>\n${conversationText}\n</conversation>`;

  let summaryText = "";
  for await (const event of client.submitMessage(prompt, { signal })) {
    if (event.type === "text_delta") {
      summaryText += event.delta;
    } else if (event.type === "error") {
      throw event.error;
    }
  }
  if (!summaryText.trim()) {
    throw new CompactSummaryValidationError("Compaction returned an empty summary.");
  }
  return summaryText;
}

/**
 * 后处理原始摘要：去掉 <analysis> 草稿区；
 * 只接纳一个闭合且正文非空的 <summary>；压缩多余空行。
 */
export function formatSummary(raw: string): string {
  const text = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, "");
  const m = text.match(/<summary>([\s\S]*?)<\/summary>/);
  if (!m || text.match(/<\/?summary>/g)?.length !== 2 || /<\/?analysis>/.test(text)) {
    throw new CompactSummaryValidationError();
  }
  const body = m[1]!.replace(/\n\n+/g, "\n\n").trim();
  if (!body) throw new CompactSummaryValidationError();
  return `Summary:\n${body}`;
}
