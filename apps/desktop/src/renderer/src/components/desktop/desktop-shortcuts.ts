import { parseKeybinding } from "tinykeys"

export const desktopShortcuts = {
  searchChats: { bindings: ["$mod+k"], keys: "K" },
  newConversation: { bindings: ["$mod+n"], keys: "N" },
  chooseProject: { bindings: ["$mod+o"], keys: "O" },
  closeConversation: { bindings: ["$mod+w"], keys: "W" },
  quit: { bindings: ["$mod+q"], keys: "Q" },
  toggleSidebar: { bindings: ["$mod+b"], keys: "B" },
  togglePanel: { bindings: ["$mod+j"], keys: "J" },
  openBrowser: { bindings: ["$mod+Shift+b"], keys: "Shift+B" },
  openFiles: { bindings: ["$mod+Shift+e"], keys: "Shift+E" },
  openTerminal: { bindings: ["$mod+Backquote"], keys: "`" },
  previousSession: { bindings: ["$mod+Shift+BracketLeft"], keys: "Shift+[" },
  nextSession: { bindings: ["$mod+Shift+BracketRight"], keys: "Shift+]" },
  goBack: { bindings: ["$mod+BracketLeft"], keys: "[" },
  goForward: { bindings: ["$mod+BracketRight"], keys: "]" },
  zoomIn: {
    bindings: ["$mod+Equal", "$mod+Shift+Equal", "$mod+NumpadAdd"],
    keys: "Shift+=",
  },
  zoomOut: { bindings: ["$mod+Minus", "$mod+NumpadSubtract"], keys: "-" },
  resetZoom: { bindings: ["$mod+Digit0", "$mod+Numpad0"], keys: "0" },
  showShortcuts: { bindings: ["$mod+Slash"], keys: "/" },
} as const

export type DesktopShortcutId = keyof typeof desktopShortcuts

type ShortcutBinding = { bindings: readonly string[]; keys: string }
const storageKey = "vykor.desktop.shortcut-overrides-v1"
const listeners = new Set<() => void>()
let revision = 0

function readOverrides(): Partial<Record<DesktopShortcutId, { binding: string; keys: string }>> {
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}") as Record<
      string,
      unknown
    >
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {}
    return Object.fromEntries(
      Object.entries(saved).filter(([id, value]) => {
        if (!(id in desktopShortcuts) || !value || typeof value !== "object") return false
        const candidate = value as { binding?: unknown; keys?: unknown }
        if (
          typeof candidate.binding !== "string" ||
          !candidate.binding.startsWith("$mod+") ||
          typeof candidate.keys !== "string" ||
          !candidate.keys.trim()
        )
          return false
        try {
          normalizedBinding(candidate.binding)
          return true
        } catch {
          return false
        }
      })
    )
  } catch {
    return {}
  }
}

let overrides = readOverrides()

export function getShortcut(id: DesktopShortcutId): ShortcutBinding {
  const override = overrides[id]
  return override ? { bindings: [override.binding], keys: override.keys } : desktopShortcuts[id]
}

function normalizedBinding(binding: string): string {
  const [modifiers, , key] = parseKeybinding(binding)[0]
  if (typeof key !== "string") throw new Error("Invalid shortcut key")
  const normalizedKey = key
    .replace(/^Key([A-Z])$/, (_, letter: string) => letter.toLowerCase())
    .replace(/^Digit(\d)$/, "$1")
  return `${modifiers.slice().sort().join("+")}+${normalizedKey.toLowerCase()}`
}

export function setShortcutBinding(
  id: DesktopShortcutId,
  binding: string,
  keys: string
): "updated" | "conflict" | "invalid" {
  if (!binding.startsWith("$mod+") || !keys.trim()) return "invalid"
  let normalized: string
  try {
    normalized = normalizedBinding(binding)
  } catch {
    return "invalid"
  }
  for (const otherId of Object.keys(desktopShortcuts) as DesktopShortcutId[]) {
    if (otherId === id) continue
    if (getShortcut(otherId).bindings.some((item) => normalizedBinding(item) === normalized)) {
      return "conflict"
    }
  }
  overrides = { ...overrides, [id]: { binding, keys } }
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(overrides))
  } catch {
    // The current window can still use the changed binding when storage is unavailable.
  }
  revision += 1
  listeners.forEach((listener) => listener())
  return "updated"
}

export function subscribeShortcutChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getShortcutRevision(): number {
  return revision
}

export function shortcutLabel(id: DesktopShortcutId, isMac = false): string {
  return `${isMac ? "⌘" : "Ctrl"}+${getShortcut(id).keys}`
}
