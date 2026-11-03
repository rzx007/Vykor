let hostResponseLocale: string | undefined;

function canonicalLocale(locale: string | undefined): string | undefined {
  if (!locale) return undefined;
  try { return Intl.getCanonicalLocales(locale)[0]; } catch { return undefined; }
}

/** Desktop hosts supply their preferred display language; standalone hosts use Intl. */
export function setHostResponseLocale(locale: string | undefined): void {
  hostResponseLocale = canonicalLocale(locale);
}

export function getResponseLocale(): string {
  if (hostResponseLocale) return hostResponseLocale;
  try { return canonicalLocale(new Intl.DateTimeFormat().resolvedOptions().locale) ?? "en"; }
  catch { return "en"; }
}

/** A default only: explicit user or personal language preferences remain authoritative. */
export function buildResponseLanguageInstruction(): string {
  return `# Response Language\nDefault response language: ${getResponseLocale()} (host system language).\nUse this language for user-facing replies, progress updates, clarification questions, approval reasons and summaries by default. Explicit response-language preferences in the current user request, personal profile or custom instructions take precedence. Preserve code, paths, identifiers and quoted text as needed.`;
}

/** Fixed application messages currently have Chinese and English translations. */
export function responseText(chinese: string, english: string): string {
  return getResponseLocale().toLowerCase().startsWith("zh") ? chinese : english;
}
