import type { ContentBlock, Message } from "@vykor/agent-contracts";
import type { SessionMessagePartRecord } from "@vykor/domain-contracts/sessions";
import type { ReplaceTranscriptMessageInput, ReplaceTranscriptPartInput } from "@vykor/services";

import { agentMessagesToTranscript } from "../../agent/agent-transcript.js";
import { generatedImageReferences, type GeneratedImageReference } from "../tools/attachment-access.js";
import { attachmentResourceUri } from "../tools/attachment-uri.js";

const FOOTER_MARKER = "\n\n[Host generated attachment resources]\n";

export function preserveCompactedAttachments(input: {
  sessionId: string;
  history: Message[];
  parts: SessionMessagePartRecord[];
}): { history: Message[]; messages: ReplaceTranscriptMessageInput[] } {
  // Never trust resource URLs or summaries as ownership proof; carry only checked durable facts.
  const references = [...new Map(generatedImageReferences(input.parts, input.sessionId)
    .map(reference => [reference.assetId, reference])).values()];
  const history = input.history.map(message => message.type === "user" && message.compactRole === "boundary"
    ? { ...message, content: withFooter(message.content, "") } : message);
  const messages = agentMessagesToTranscript(history);
  const archived: GeneratedImageReference[] = [];
  for (const reference of references) {
    const sourceMessages = new Set(input.parts.filter(part => part.sessionId === input.sessionId &&
      part.type === "tool" && part.toolUseId === reference.toolUseId).map(part => part.messageId));
    const retained = messages.filter(message => message.parts.some(part =>
      part.type === "tool" && part.toolName === "ImageGeneration" && part.toolUseId === reference.toolUseId &&
      part.status === "completed" && !part.isError,
    ));
    // Reused call IDs cannot identify the original recent message; keep their proof with the summary instead.
    if (sourceMessages.size === 1 && retained.length === 1) retained[0]!.parts.push(attachmentPart(reference));
    else archived.push(reference);
  }

  const footer = resourceFooter(references);
  const boundaryIndex = history.findIndex(message => message.type === "user" && message.compactRole === "boundary");
  if (boundaryIndex >= 0) {
    const boundary = history[boundaryIndex] as Extract<Message, { type: "user" }>;
    history[boundaryIndex] = { ...boundary, content: withFooter(boundary.content, footer) };
    const row = messages.find(message => message.parts.some(part => part.metadata?.compactRole === "boundary"))!;
    row.parts = agentMessagesToTranscript([history[boundaryIndex]!])[0]!.parts;
  } else if (archived.length) {
    const boundary: Message = { type: "user", compactRole: "boundary", content: `[Compact boundary marker]${footer}` };
    history.push(boundary);
    messages.push(agentMessagesToTranscript([boundary])[0]!);
  }

  const completion: ReplaceTranscriptMessageInput = {
    role: "system", metadata: { presentation: { kind: "context_compaction", phase: "completed" } },
    parts: [{ type: "text", status: "completed", text: "已压缩上下文" }],
  };
  const tools = new Set<string>();
  for (const reference of archived) {
    if (!tools.has(reference.toolUseId)) {
      completion.parts.push({ type: "tool", status: "completed", toolName: "ImageGeneration", toolUseId: reference.toolUseId, isError: false });
      tools.add(reference.toolUseId);
    }
    completion.parts.push(attachmentPart(reference));
  }
  const boundaryRow = messages.findIndex(message => message.parts.some(part => part.metadata?.compactRole === "boundary"));
  messages.splice(archived.length && boundaryRow >= 0 ? boundaryRow : messages.length, 0, completion);
  return { history, messages };
}

function attachmentPart(reference: GeneratedImageReference): ReplaceTranscriptPartInput {
  return {
    type: "attachment", status: "completed", assetId: reference.assetId, intent: "tool_resource",
    displayName: reference.displayName, mediaType: reference.mediaType, sizeBytes: reference.sizeBytes,
    metadata: { source: "image_generation", toolUseId: reference.toolUseId },
  };
}

function resourceFooter(references: GeneratedImageReference[]): string {
  if (!references.length) return "";
  let footer = `${FOOTER_MARKER}Use Read or ImageGeneration images with these conversation-owned resources:`;
  for (const reference of references.slice(-20)) {
    const line = `\n- ${attachmentResourceUri(reference.assetId, reference.displayName)}`;
    if (footer.length + line.length > 12_000) break;
    footer += line;
  }
  return footer;
}

function withFooter(content: string | ContentBlock[], footer: string): string | ContentBlock[] {
  const strip = (text: string) => {
    const index = text.indexOf(FOOTER_MARKER);
    return index < 0 ? text : text.slice(0, index);
  };
  if (typeof content === "string") return strip(content) + footer;
  const blocks = content.flatMap((block): ContentBlock[] => {
    if (block.type !== "text") return [block];
    const text = strip(block.text);
    return text ? [{ ...block, text }] : [];
  });
  if (footer) blocks.push({ type: "text", text: footer });
  return blocks;
}
