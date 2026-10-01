import type { DesktopSessionPart } from "@shared/session-types"

export function messageTextContent(parts: DesktopSessionPart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
}

export function toolOutputText(value: unknown): string | null {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return null
  const content = "content" in value ? value.content : undefined
  if (!Array.isArray(content)) return null
  const block = content.find(
    (item): item is { type: "text"; text: string } =>
      !!item &&
      typeof item === "object" &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string"
  )
  return block?.text ?? null
}
