import type { SessionUserInputItem } from "@shared/session-types"

export type UserDisplayItem =
  | { kind: "text"; text: string }
  | { kind: "skill"; name: string; displayName: string }
  | { kind: "context"; name: string; displayName: string }
  | { kind: "plugin"; name: string; displayName: string }

export function renderUserItems(items: readonly SessionUserInputItem[]): UserDisplayItem[] {
  return items.flatMap((item): UserDisplayItem[] => {
    if (item.type === "text") return item.text ? [{ kind: "text", text: item.text }] : []
    if (item.type === "context")
      return [{ kind: "context", name: item.id, displayName: item.displayName }]
    if (item.type === "capability")
      return [{ kind: "plugin", name: item.pluginId, displayName: item.displayName }]
    const name = item.name.trim()
    if (!name) return []
    return [{ kind: "skill", name, displayName: item.displayName?.trim() || name }]
  })
}
