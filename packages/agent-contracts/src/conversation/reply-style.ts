/** How an agent explains findings and delivers results, independently of update timing. */
export type ReplyStyle = "collaborative" | "direct" | "explanatory";

export const DEFAULT_REPLY_STYLE: ReplyStyle = "collaborative";

export function isReplyStyle(value: unknown): value is ReplyStyle {
  return value === "collaborative" || value === "direct" || value === "explanatory";
}
