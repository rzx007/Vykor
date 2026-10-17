import type { ToolContext } from "@vykor/core";

/** One explicit choice, shared by host-owned installation tools and the desktop approval card. */
export async function askInstallConfirmation(
  ask: NonNullable<ToolContext["askUserPrompt"]>,
  question: string,
  confirmLabel: string,
): Promise<boolean> {
  const answer = (await ask(JSON.stringify({
    kind: "question",
    questions: [{ question, type: "radio", options: [confirmLabel, "取消"] }],
  }))).trim();
  // Text-only hosts retain their existing explicit confirmation contract.
  if (answer === confirmLabel) return true;
  try {
    const value: unknown = JSON.parse(answer);
    if (!record(value) || !record(value.selected) || !record(value.custom)) return false;
    if ([...Object.keys(value.selected), ...Object.keys(value.custom)].some(key => key !== "0")) return false;
    const selected = value.selected["0"] ?? [];
    const custom = value.custom["0"] ?? "";
    if (!Array.isArray(selected) || typeof custom !== "string") return false;
    // Conflicting/custom responses must never implicitly inherit an affirmative selection.
    if (custom.trim()) return selected.length === 0 && custom.trim() === confirmLabel;
    return selected.length === 1 && selected[0] === 0;
  } catch {
    return false;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
