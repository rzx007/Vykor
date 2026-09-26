import {
  isCommittedModelPart,
  isSupersededModelPart,
  type SessionMessagePartRecord,
} from "@vykor/protocol";

/** Only ordinary, non-superseded text may become a public reply. */
export function isPublicTextPart(part: SessionMessagePartRecord): boolean {
  return part.type === "text" && !isSupersededModelPart(part);
}

/**
 * Public text that is also confirmed committed. Memory/summary consumers must
 * use this so an interrupted generation's partial text never becomes durable.
 */
export function isCommittedPublicTextPart(part: SessionMessagePartRecord): boolean {
  return part.type === "text" && isCommittedModelPart(part);
}

export function publicTextFromParts(
  parts: readonly SessionMessagePartRecord[],
  separator = "",
  options: { requireCommitted?: boolean } = {},
): string {
  const predicate = options.requireCommitted ? isCommittedPublicTextPart : isPublicTextPart;
  return parts.filter(predicate).map((part) => part.text ?? "").join(separator);
}
