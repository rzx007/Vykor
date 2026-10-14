import type { ModelTokenMetering } from "@vykor/core";

export function normalizeTokenMetering(
  raw: { input: unknown; output: unknown; cacheCreation?: unknown; cacheRead?: unknown },
  inputIncludesCache: boolean,
  finalReport: boolean,
): ModelTokenMetering {
  const valid = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const inputs = inputIncludesCache ? [raw.input] : [raw.input, raw.cacheCreation, raw.cacheRead];
  let knownInputTokens = 0;
  let inputComplete = true;
  let anyKnown = valid(raw.output);
  for (const value of inputs) {
    if (!valid(value)) { inputComplete = false; continue; }
    anyKnown = true;
    if (!Number.isSafeInteger(knownInputTokens + value)) { inputComplete = false; continue; }
    knownInputTokens += value;
  }
  return {
    knownInputTokens,
    knownOutputTokens: valid(raw.output) ? raw.output : 0,
    completeness: finalReport && inputComplete && valid(raw.output) && Number.isSafeInteger(knownInputTokens + raw.output)
      ? "complete" : anyKnown ? "partial" : "unknown",
    inputIncludesCache,
    raw: { ...raw },
  };
}
