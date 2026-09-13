import type { SessionUserInputItem } from "@shared/session-types"

export type ComposerInputItem = SessionUserInputItem

export interface ComposerDocument {
  version: 1
  items: ComposerInputItem[]
}

export const emptyComposerDocument: ComposerDocument = { version: 1, items: [] }

export function composerDocument(items: readonly ComposerInputItem[]): ComposerDocument {
  const normalized: ComposerInputItem[] = []
  for (const item of items) {
    if (item.type !== "text") {
      normalized.push({ ...item })
      continue
    }
    if (!item.text) continue
    const previous = normalized.at(-1)
    if (previous?.type === "text") previous.text += item.text
    else normalized.push({ type: "text", text: item.text })
  }
  return { version: 1, items: normalized }
}

export function selectComposerDocumentText(document: ComposerDocument): string {
  return document.items.map((item) => item.type === "text" ? item.text : item.type === "context" || item.type === "capability" ? `@${item.displayName}` : `$${item.name}`).join("")
}

export function sameComposerDocument(left: ComposerDocument, right: ComposerDocument): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
