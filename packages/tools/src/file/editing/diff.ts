import { createTwoFilesPatch } from "diff";
import { computeFileChange } from "../preview.js";

/**
 * 生成单文件改动的 unified diff 文本（基于 jsdiff `createTwoFilesPatch`）。
 *
 * 去掉 jsdiff 默认的 `Index:` / `===` 头两行，只留 `--- / +++ / @@` 的标准
 * unified diff 主体，便于在 TUI 权限框里逐行着色（+ 绿 / - 红）。
 *
 * @param path   文件路径（同时用作 diff 的 old/new 文件名）。
 * @param before 改动前内容。
 * @param after  改动后内容。
 * @param context 上下文行数（默认 3）。
 */
export function buildUnifiedDiff(
  path: string,
  before: string,
  after: string,
  context = 3,
): string {
  const patch = createTwoFilesPatch(path, path, before, after, "", "", { context });
  // createTwoFilesPatch 头部是 "Index: …\n===…\n--- …"；丢掉前两行噪声。
  const lines = patch.split("\n");
  if (lines[0]?.startsWith("Index:")) lines.splice(0, 2);
  return lines.join("\n");
}

/** 跨进程传输的 diff 最多保留多少行，避免超大 Write 把 diff 全量塞进事件载荷。 */
export const MAX_DIFF_PAYLOAD_LINES = 400;

/** 把 diff 文本截到 maxLines 行，超出时追加省略提示（按源截断，控制载荷大小）。 */
export function truncateDiff(diff: string, maxLines = MAX_DIFF_PAYLOAD_LINES): string {
  const lines = diff.replace(/\n$/, "").split("\n");
  if (lines.length <= maxLines) return diff;
  const kept = lines.slice(0, maxLines);
  kept.push(`… diff truncated (${lines.length - maxLines} more line(s))`);
  return kept.join("\n");
}

/**
 * 便捷组合：对 Edit/Write 工具调用算出改动并生成 unified diff。
 *
 * 非文件工具、或无法预览（见 {@link computeFileChange}）时返回 `null`。
 * 改动前后内容相同（无实际改动）时也返回 `null`。
 * diff 文本按 {@link MAX_DIFF_PAYLOAD_LINES} 截断，避免超大改动撑爆事件载荷。
 */
export async function computeToolDiff(
  toolName: string,
  input: Record<string, unknown>,
  context = 3,
): Promise<{ path: string; diff: string } | null> {
  const change = await computeFileChange(toolName, input);
  if (!change) return null;
  if (change.before === change.after) return null;
  const full = buildUnifiedDiff(change.path, change.before, change.after, context);
  return { path: change.path, diff: truncateDiff(full) };
}
