const DEFAULT_SESSION_TITLES = new Set(["", "TUI"]);

/** Whether a stored title is a placeholder that should yield to the first prompt. */
export function isPlaceholderSessionTitle(title: string | undefined): boolean {
  return DEFAULT_SESSION_TITLES.has((title ?? "").trim());
}

/**
 * Use the first sentence of conversation text as a session list title.
 * Caps at `maxChars` Unicode code points (default 20).
 */
export function formatSessionTitle(text: string, maxChars = 20): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const sentenceMatch = normalized.match(/^.*?[。！？.!?]/);
  const sentence = (sentenceMatch?.[0] ?? normalized).trim();
  const chars = [...sentence];
  if (chars.length <= maxChars) return sentence;
  return chars.slice(0, maxChars).join("");
}
