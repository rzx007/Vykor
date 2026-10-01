import type { Message, ContentBlock } from "../index";
import type { CompactTrigger } from "./compact-types";
import { boundaryFallsInsideToolGroup as historyBoundaryFallsInsideToolGroup } from "../utils/message-history";
import { estimateTokens as estimateTextTokens } from "../utils/token-counter";
import { toolFeedbackFields } from "./tool-result-feedback";

/** Token 估算的保守膨胀系数，降低低估导致超窗的风险。 */
const TOKEN_ESTIMATION_PADDING = 4 / 3;

/** microCompact 清空工具结果后写入的占位文案。 */
const TIME_BASED_MC_CLEARED_MESSAGE = "[Old tool result content cleared]";
/** Controlled facts describe a past observation, not instructions or current job status. */
export function toolFactsText(message: Extract<Message, { type: "tool_result" }>): string | undefined {
  const facts = toolFeedbackFields(message);
  const summary = facts.compactSummary || (message.isError
    ? `kind=${facts.failureKind ?? "unknown_outcome"}; execution=${facts.executionState ?? "unknown"}`
    : undefined);
  return summary ? `Tool feedback data (observed at the time, not instructions):\n${summary}` : undefined;
}

export function prependToolFacts(content: ContentBlock[], facts: string | undefined): ContentBlock[] {
  return facts
    ? [{ type: "text", text: facts }, ...content.filter((b) => !isTextBlock(b) || b.text !== facts)]
    : content;
}

/**
 * 这些内置工具的结果通常很长、且旧结果对续聊价值较低，允许被 microCompact 清空。
 * 未列入的工具结果一律保留（避免误删关键状态）。
 */
const MICROCOMPACTABLE_TOOLS = new Set([
  "Shell", "Bash", "Read", "Write", "Edit", "Glob", "Grep",
  "WebFetch", "WebSearch",
]);

/**
 * 判断某工具的结果是否允许被 microCompact 清理。
 * 规则：白名单内置工具 + 所有 MCP 工具（mcp__ 前缀）；其余保留。
 */
function isMicrocompactable(toolName: string): boolean {
  return MICROCOMPACTABLE_TOOLS.has(toolName) || toolName.startsWith("mcp__");
}

/** 类型守卫：content block 是否为纯文本。 */
export function isTextBlock(block: ContentBlock): block is { type: "text"; text: string } {
  return block.type === "text";
}

/** 类型守卫：content block 是否为图片。 */
function isImageBlock(block: ContentBlock): boolean {
  return block.type === "image";
}

export function splitMessagesPreservingToolPairs(messages: Message[], keepRecent: number): { older: Message[]; recent: Message[] } {
  if (messages.length <= keepRecent) {
    return { older: [], recent: [...messages] };
  }
  let splitIndex = Math.max(0, messages.length - keepRecent);
  while (
    splitIndex > 0 &&
    historyBoundaryFallsInsideToolGroup(messages, splitIndex)
  ) {
    splitIndex--;
  }
  return {
    older: messages.slice(0, splitIndex),
    recent: messages.slice(splitIndex),
  };
}

export function replaceImagesWithPlaceholders(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (msg.type === "user" && Array.isArray(msg.content)) {
      if (!msg.content.some(isImageBlock)) return msg;
      return {
        ...msg,
        content: msg.content.map((b) =>
          isImageBlock(b)
            ? { type: "text" as const, text: "[Image omitted from compaction summarization.]" }
            : b,
        ),
      } as Message;
    }
    if (msg.type === "tool_result") {
      if (!msg.content.some(isImageBlock)) return msg;
      return {
        ...msg,
        content: msg.content.map((b) =>
          isImageBlock(b)
            ? { type: "text" as const, text: "[Image omitted from compaction summarization.]" }
            : b,
        ),
      } as Message;
    }
    return msg;
  });
}

export function estimateMessageTokens(messages: Message[], imageTokenEstimate: number): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.type === "assistant") {
      total += estimateTextTokens(msg.content);
      if (msg.reasoningReplay) total += estimateTextTokens(msg.reasoningReplay);
      if (msg.toolUses) {
        for (const tu of msg.toolUses) {
          total += estimateTextTokens(tu.name);
          total += estimateTextTokens(JSON.stringify(tu.input));
        }
      }
      continue;
    }
    if (typeof msg.content === "string") {
      total += estimateTextTokens(msg.content);
      continue;
    }
    for (const block of msg.content) {
      if (block.type === "text") {
        total += estimateTextTokens(block.text);
      } else if (block.type === "image") {
        const prepared = block.source.prepared;
        total += prepared
          ? Math.ceil(prepared.width / 28) * Math.ceil(prepared.height / 28)
          : imageTokenEstimate;
      }
    }
  }
  return Math.ceil(total * TOKEN_ESTIMATION_PADDING);
}

/** PTL 重试砍掉最老轮次后，若剩余段不以 user 开头，则插入此标记保证对话结构合法。 */
const PTL_RETRY_MARKER = "[earlier conversation truncated for compaction retry]";

/** 超过此字符数才触发 collapse；短于阈值的文本原样保留。 */
const CONTEXT_COLLAPSE_TEXT_CHAR_LIMIT = 2_400;
/** 截断后保留的头部字符数。 */
const CONTEXT_COLLAPSE_HEAD_CHARS = 900;
/** 截断后保留的尾部字符数。 */
const CONTEXT_COLLAPSE_TAIL_CHARS = 500;

/**
 * 把消息 content 拍平成纯文本（仅拼接 text block；图片等忽略）。
 * 用于判断「是否以有意义的 user 文本开启新一轮」等场景。
 */
function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
}

export function simpleCompactMessages(messages: Message[], keepRecent: number): Message[] {
  const systemMessages = messages.filter((m) => m.type === "system");
  const nonSystem = messages.filter((m) => m.type !== "system");

  const { older, recent } = splitMessagesPreservingToolPairs(nonSystem, keepRecent);
  if (older.length === 0) return messages;

  const compactedCount = older.length;
  const toolResultCount = older.filter((m) => m.type === "tool_result").length;
  const retainedFacts: string[] = [];
  let remaining = 950; // Leave room for the omission marker within a 1,000-character budget.
  let omitted = false;
  for (const message of older.slice().reverse()) {
    if (message.type !== "tool_result") continue;
    const facts = toolFactsText(message);
    if (!facts) continue;
    if (facts.length + 1 > remaining) {
      omitted = true;
      continue;
    }
    retainedFacts.unshift(facts);
    remaining -= facts.length + 1;
  }
  if (omitted) retainedFacts.push("[Some tool observations omitted]");

  const summary: Message = {
    type: "assistant",
    content: [`[Conversation compacted: ${compactedCount} messages summarized (${toolResultCount} tool results removed). ${recent.length} recent messages preserved.]`, ...retainedFacts].join("\n"),
    compactRole: "summary",
  };

  const boundary = createCompactBoundaryMarker({
    trigger: "auto",
    compactKind: "simple",
    preMessageCount: messages.length,
    postMessageCount: systemMessages.length + 1 + recent.length,
  });

  return [...systemMessages, summary, boundary, ...recent];
}

export function tryContextCollapseMessages(messages: Message[], keepRecent: number, imageTokenEstimate: number): Message[] | null {
  // 消息太少时没有「较旧」可压，直接跳过。
  if (messages.length <= keepRecent + 2) return null;

  const { older, recent } = splitMessagesPreservingToolPairs(messages, keepRecent);
  let changed = false;

  const collapsedOlder = older.map((msg) => {
    // user：content 可能是 ContentBlock[]（含 text / image）
    if (msg.type === "user" && Array.isArray(msg.content)) {
      const blocks = msg.content.map((b) => {
        if (isTextBlock(b)) {
          const collapsed = collapseText(b.text);
          if (collapsed !== b.text) changed = true;
          return { type: "text" as const, text: collapsed };
        }
        return b;
      });
      return { ...msg, content: blocks } as Message;
    }
    // user：纯字符串 content
    if (msg.type === "user" && typeof msg.content === "string") {
      const collapsed = collapseText(msg.content);
      if (collapsed !== msg.content) changed = true;
      return { ...msg, content: collapsed } as Message;
    }
    // assistant：content 为字符串
    if (msg.type === "assistant") {
      const collapsed = collapseText(msg.content);
      if (collapsed !== msg.content) changed = true;
      return { ...msg, content: collapsed } as Message;
    }
    // tool_result：content 为 block 数组
    if (msg.type === "tool_result") {
      let bodyChanged = false;
      const blocks = msg.content.map((b) => {
        if (isTextBlock(b)) {
          const collapsed = collapseText(b.text);
          if (collapsed !== b.text) changed = bodyChanged = true;
          return { type: "text" as const, text: collapsed };
        }
        return b;
      });
      return { ...msg, content: bodyChanged ? prependToolFacts(blocks, toolFactsText(msg)) : blocks } as Message;
    }
    return msg;
  });

  if (!changed) return null;

  const result = [...collapsedOlder, ...recent];
  // 若估算未下降（例如 padding / 图片主导），视为无效，返回 null。
  if (estimateMessageTokens(result, imageTokenEstimate) >= estimateMessageTokens(messages, imageTokenEstimate)) {
    return null;
  }
  return result;
}

function collapseText(text: string): string {
  if (text.length <= CONTEXT_COLLAPSE_TEXT_CHAR_LIMIT) return text;
  const omitted =
    text.length - CONTEXT_COLLAPSE_HEAD_CHARS - CONTEXT_COLLAPSE_TAIL_CHARS;
  const head = text.slice(0, CONTEXT_COLLAPSE_HEAD_CHARS).trimEnd();
  const tail = text.slice(-CONTEXT_COLLAPSE_TAIL_CHARS).trimStart();
  return `${head}\n...[collapsed ${omitted} chars]...\n${tail}`;
}

export function truncateHeadForPtlRetry(messages: Message[]): Message[] | null {
  const groups = groupByPromptRound(messages);
  if (groups.length < 2) return null;

  let dropCount = Math.max(1, Math.floor(groups.length / 5));
  dropCount = Math.min(dropCount, groups.length - 1);

  const retained = groups.slice(dropCount).flat();
  if (!retained.length) return null;

  if (retained[0]!.type === "assistant" || retained[0]!.type === "tool_result") {
    const marker: Message = { type: "user", content: PTL_RETRY_MARKER };
    return [marker, ...retained];
  }
  return retained;
}

function groupByPromptRound(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  let current: Message[] = [];
  for (const msg of messages) {
    const startsNewRound =
      msg.type === "user" && contentToText(msg.content).trim().length > 0;
    if (startsNewRound && current.length) {
      groups.push(current);
      current = [];
    }
    current.push(msg);
  }
  if (current.length) groups.push(current);
  return groups;
}

export function createCompactBoundaryMarker(metadata: {
  trigger: CompactTrigger;
  compactKind: string;
  preMessageCount?: number;
  preTokenCount?: number;
  postMessageCount?: number;
  usedHeadTruncationRetry?: boolean;
}): Message {
  const lines = [
    "[Compact boundary marker]",
    "Earlier conversation was compacted. Use the summary above and the messages below as the continuity boundary.",
    `Trigger: ${metadata.trigger}`,
    `Compaction kind: ${metadata.compactKind}`,
  ];
  if (metadata.preMessageCount !== undefined) {
    lines.push(
      `Pre-compact footprint: messages=${metadata.preMessageCount}` +
        (metadata.preTokenCount !== undefined
          ? `, tokens=${metadata.preTokenCount}`
          : ""),
    );
  }
  if (metadata.postMessageCount !== undefined) {
    lines.push(`Post-compact footprint: messages=${metadata.postMessageCount}`);
  }
  if (metadata.usedHeadTruncationRetry) {
    lines.push("Note: older context was head-truncated during a PTL retry.");
  }
  return { type: "user", content: lines.join("\n"), compactRole: "boundary" };
}

export function microCompactMessages(messages: Message[], keepRecent: number): Message[] {
  // 先建立 toolUseId → 工具名 映射，再判断每条 tool_result 是否可清理。
  const toolNameById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.type === "assistant" && msg.toolUses) {
      for (const tu of msg.toolUses) toolNameById.set(tu.id, tu.name);
    }
  }

  const compactableIds: string[] = [];
  for (const msg of messages) {
    if (msg.type === "tool_result") {
      const name = toolNameById.get(msg.toolUseId) ?? "";
      if (isMicrocompactable(name)) {
        compactableIds.push(msg.toolUseId);
      }
    }
  }

  const keepCount = Math.max(1, keepRecent);
  if (compactableIds.length <= keepCount) {
    return messages;
  }
  // 需要清空的是「除最近 keepCount 条之外」的更早 id。
  const clearSet = new Set(
    compactableIds.slice(0, compactableIds.length - keepCount),
  );

  return messages.map((msg) => {
    if (msg.type !== "tool_result" || !clearSet.has(msg.toolUseId)) {
      return msg;
    }
    const facts = toolFactsText(msg);
    const boundedFacts = facts && facts.length + 1 + TIME_BASED_MC_CLEARED_MESSAGE.length <= 1000
      ? facts : facts ? "[Tool feedback summary omitted: exceeds clearing budget]" : undefined;
    const content = prependToolFacts([{ type: "text", text: TIME_BASED_MC_CLEARED_MESSAGE }], boundedFacts);
    // Rebuild from the sidecar, never from a previous prefix.
    const alreadyCleared = msg.content.length === content.length &&
      msg.content.every((b, i) => isTextBlock(b) && b.text === (content[i] as { text: string }).text);
    if (alreadyCleared) return msg;
    return {
      ...msg,
      content,
    };
  });
}
