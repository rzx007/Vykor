import type { SessionMessagePartRecord } from "@vykor/protocol";

/** Only ordinary text may become a public reply or conversation memory. */
export function isPublicTextPart(part: SessionMessagePartRecord): boolean {
  return part.type === "text";
}

export function publicTextFromParts(
  parts: readonly SessionMessagePartRecord[],
  separator = "",
): string {
  return parts.filter(isPublicTextPart).map((part) => part.text ?? "").join(separator);
}
