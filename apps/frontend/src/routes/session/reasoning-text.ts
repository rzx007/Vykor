// 展示上限语义与桌面端 conversation-page/message/reasoning-text.ts 保持一致。
export const REASONING_DISPLAY_LIMIT = 20_000;

export function truncateReasoning(
  text: string,
  limit = REASONING_DISPLAY_LIMIT,
): { text: string; omitted: number } {
  if (text.length <= limit) return { text, omitted: 0 };
  return { text: text.slice(-limit), omitted: text.length - limit };
}
