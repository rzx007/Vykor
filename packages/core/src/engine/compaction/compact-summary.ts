import { isContextLengthExceededMessage, ModelRequestFailure, type Message } from "@vykor/agent-contracts";
import type { CompactClient } from "./compact-types";
import { isTextBlock, toolFactsText } from "./compact-messages";
import { COMPACT_PROMPT } from "./compact-prompt";

/**
 * 把待摘要消息序列化成对话文本，拼进 prompt，流式收集摘要模型输出。
 * 每条消息最多 4000 字符；完整受控事实在前，剩余预算再放正文。
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

  const conversationText = messages
    .map((m) => {
      const role =
        m.type === "user"
          ? "User"
          : m.type === "assistant"
            ? "Assistant"
            : m.type === "tool_result"
              ? "ToolResult"
              : "System";
      const facts = m.type === "tool_result" ? toolFactsText(m) : undefined;
      const body = m.type === "tool_result" && facts
        ? m.content.filter((b) => !isTextBlock(b) || b.text !== facts)
        : m.content;
      const content =
        typeof body === "string" ? body : JSON.stringify(body);
      const prefix = facts ? `${facts}\n` : "";
      return `${role}: ${prefix}${content.slice(0, 4000 - prefix.length)}`;
    })
    .join("\n\n");

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
    throw new Error("Compaction interrupted before a complete summary was returned.");
  }
  return summaryText;
}

/**
 * 后处理原始摘要：去掉 <analysis> 草稿区；
 * 若有 <summary> 则改写成 `Summary:\n...` 形式；压缩多余空行。
 */
export function formatSummary(raw: string): string {
  let text = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, "");
  const m = text.match(/<summary>([\s\S]*?)<\/summary>/);
  if (m) {
    text = text.replace(m[0], `Summary:\n${m[1]!.trim()}`);
  }
  return text.replace(/\n\n+/g, "\n\n").trim();
}
