import { DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE } from "../constants/vision-tokens.js";
import type { ContentBlock, Message } from "../types/messages.js";
import type { ContextBucketId, ContextLedgerSegment } from "./types.js";

function contentBlocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function countImages(blocks: ContentBlock[]): number {
  return blocks.filter((block) => block.type === "image").length;
}

function resolveBucket(msg: Message, messages: Message[], index: number): ContextBucketId {
  if (msg.type === "system") return "system";

  if (msg.type === "assistant" || msg.type === "user") {
    if (msg.compactRole === "summary") return "summary";
    if (msg.compactRole === "boundary") return "conversation";
  }

  if (msg.type === "assistant") {
    const content = msg.content;
    if (
      content.includes("[Conversation compacted") ||
      content.startsWith("Summary:")
    ) {
      const next = messages[index + 1];
      if (next?.type === "user") {
        const nextText =
          typeof next.content === "string"
            ? next.content
            : contentBlocksToText(next.content);
        if (nextText.includes("[Compact boundary marker]")) return "summary";
      }
    }
  }

  return "conversation";
}

function assistantText(msg: Extract<Message, { type: "assistant" }>): string {
  let text = msg.content + (msg.reasoningReplay ?? "");
  if (msg.toolUses?.length) {
    for (const toolUse of msg.toolUses) {
      text += toolUse.name + JSON.stringify(toolUse.input);
    }
  }
  return text;
}

export function messagesToLedgerSegments(messages: Message[]): ContextLedgerSegment[] {
  const segments: ContextLedgerSegment[] = [];

  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index]!;
    const bucket = resolveBucket(msg, messages, index);

    switch (msg.type) {
      case "system":
        segments.push({ bucket, text: msg.content });
        break;
      case "user":
        if (typeof msg.content === "string") {
          segments.push({ bucket, text: msg.content });
        } else {
          const text = contentBlocksToText(msg.content);
          const imageCount = countImages(msg.content);
          segments.push({
            bucket,
            text,
            ...(imageCount > 0
              ? { mediaTokens: imageCount * DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE }
              : {}),
          });
        }
        break;
      case "assistant":
        segments.push({ bucket, text: assistantText(msg) });
        break;
      case "tool_result": {
        const text = contentBlocksToText(msg.content);
        const imageCount = countImages(msg.content);
        segments.push({
          bucket: "conversation",
          text,
          ...(imageCount > 0
            ? { mediaTokens: imageCount * DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE }
            : {}),
        });
        break;
      }
    }
  }

  return segments;
}
