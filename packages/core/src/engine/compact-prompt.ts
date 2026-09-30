import type { Message } from "../index";
import type { CompactContext, CompactContextSection } from "./compact-types";

/**
 * LLM 摘要提示词。
 * 要求模型先写 <analysis>（草稿/推理），再写 <summary>（正式续聊用摘要）；
 * formatSummary 会丢掉 analysis，只保留 summary 内容。
 */
export const COMPACT_PROMPT = `Summarize the following conversation between the user and an AI assistant.

Produce your summary in two sections:

<analysis>
- Briefly describe what the user was trying to accomplish
- What approach was taken
- Key findings and decisions made
- Any errors encountered and how they were resolved
</analysis>

<summary>
- Concise narrative of the conversation progress
- Key state: files modified, tools used, results obtained
- Any pending items or follow-up actions needed
</summary>

Keep the summary concise and focused on information needed for continuing the task.`;

// -------------------------------------------------------------------------
// Compact context 辅助（B.2）
// -------------------------------------------------------------------------

/**
 * 从消息历史自动提取最近访问的文件路径。
 * 扫描 assistant 的 Read / Write / Edit / MultiEdit 工具输入中的 file_path，
 * 去重后只保留最近 20 个，供摘要 prompt 的「Recently Accessed Files」段使用。
 */
export function extractRecentFiles(messages: Message[]): string[] {
  const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit"]);
  const seen = new Set<string>();
  const files: string[] = [];
  for (const msg of messages) {
    if (msg.type === "assistant" && msg.toolUses) {
      for (const tu of msg.toolUses) {
        if (FILE_TOOLS.has(tu.name)) {
          const fp = (tu.input as Record<string, unknown>)?.file_path;
          if (typeof fp === "string" && !seen.has(fp)) {
            seen.add(fp);
            files.push(fp);
          }
        }
      }
    }
  }
  return files.slice(-20);
}

/**
 * 从消息历史统计工具调用次数，生成 `ToolName×count` 形式的 work log。
 * 按调用次数降序，帮助摘要模型理解「本会话主要在做什么」。
 */
export function deriveWorkLog(messages: Message[]): string | undefined {
  const counts = new Map<string, number>();
  for (const msg of messages) {
    if (msg.type === "assistant" && msg.toolUses) {
      for (const tu of msg.toolUses) {
        counts.set(tu.name, (counts.get(tu.name) ?? 0) + 1);
      }
    }
  }
  if (counts.size === 0) return undefined;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
}

/**
 * 把 context 拼进 COMPACT_PROMPT。
 * 无任何附加上下文时直接返回基础 prompt；有上下文则包在 <context> 中，
 * 并提示模型把这些信息写进摘要以便续聊。
 */
export function buildCompactPrompt(context: CompactContext): string {
  const sections: string[] = [];
  if (context.sessionMemory) {
    sections.push(`## Session Memory Checkpoint\n${context.sessionMemory}`);
  }
  if (context.taskFocus) {
    sections.push(`## Current Task\n${context.taskFocus}`);
  }
  if (context.recentFiles?.length) {
    sections.push(`## Recently Accessed Files\n${context.recentFiles.join("\n")}`);
  }
  if (context.plan) {
    sections.push(`## Current Plan\n${context.plan}`);
  }
  if (context.workLog) {
    sections.push(`## Work Log\n${context.workLog}`);
  }
  sections.push(...formatSupplementalSections(context.supplementalSections));
  if (sections.length === 0) return COMPACT_PROMPT;
  return (
    COMPACT_PROMPT +
    "\n\n<context>\n" +
    sections.join("\n\n") +
    "\n</context>\n\nIncorporate the above context into your summary to help resume work effectively."
  );
}

function formatSupplementalSections(
  supplementalSections: CompactContextSection[] | undefined,
): string[] {
  const sections: string[] = [];
  let remainingContentChars = 32_000;
  for (const section of supplementalSections ?? []) {
    if (sections.length >= 8 || remainingContentChars <= 0) break;
    const heading = section.heading
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, 120);
    const content = section.content.trim();
    if (!heading || !content) continue;
    const boundedContent = content.slice(
      0,
      Math.min(16_000, remainingContentChars),
    );
    if (!boundedContent) continue;
    sections.push(`## ${heading}\n${boundedContent}`);
    remainingContentChars -= boundedContent.length;
  }
  return sections;
}

