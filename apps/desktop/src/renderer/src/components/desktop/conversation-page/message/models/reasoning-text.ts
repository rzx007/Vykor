export const REASONING_DISPLAY_LIMIT = 20_000

export function truncateReasoning(
  text: string,
  limit = REASONING_DISPLAY_LIMIT
): { text: string; omitted: number } {
  if (text.length <= limit) return { text, omitted: 0 }
  return { text: text.slice(-limit), omitted: text.length - limit }
}
