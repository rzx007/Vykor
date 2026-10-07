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

function readOverrides(strict = false): Partial<Record<DesktopShortcutId, { binding: string; keys: string }>> {
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
        if (candidate.binding === "" && candidate.keys === "") return true
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
  } catch (error) {
    if (strict) throw error
    return {}
  }
}

let overrides = readOverrides()

function readLatestOverrides(): boolean {
  try {
    const next = readOverrides(true)
    if (JSON.stringify(next) !== JSON.stringify(overrides)) {
      overrides = next
      revision += 1
      listeners.forEach((listener) => listener())
    }
    return true
  }
  catch { return false }
}

if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key !== storageKey && event.key !== null) return
  readLatestOverrides()
})

export function getShortcut(id: DesktopShortcutId): ShortcutBinding {
  const override = overrides[id]
  return override ? { bindings: override.binding ? [override.binding] : [], keys: override.keys } : desktopShortcuts[id]
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
): "updated" | "conflict" | "invalid" | "reserved" | "storage_error" {
  if (!readLatestOverrides()) return "storage_error"
  if (!binding.startsWith("$mod+") || !keys.trim()) return "invalid"
  let normalized: string
  try {
    normalized = normalizedBinding(binding)
  } catch {
    return "invalid"
  }
  const reserved = ["$mod+a", "$mod+c", "$mod+v", "$mod+x", "$mod+z", "$mod+y", "$mod+Shift+c", "$mod+Shift+v", "$mod+Shift+z", "$mod+Space", "$mod+Alt+Delete", "$mod+Enter", "$mod+Shift+Enter", "$mod+Backspace", "$mod+Delete", ...["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].flatMap((key) => [`$mod+${key}`, `$mod+Shift+${key}`])].map(normalizedBinding)
  if (reserved.includes(normalized)) return "reserved"
  for (const otherId of Object.keys(desktopShortcuts) as DesktopShortcutId[]) {
    if (otherId === id) continue
    if (getShortcut(otherId).bindings.some((item) => normalizedBinding(item) === normalized)) {
      return "conflict"
    }
  }
  return persistOverrides({ ...overrides, [id]: { binding, keys } })
}

function persistOverrides(next: typeof overrides): "updated" | "storage_error" {
  try {
    if (Object.keys(next).length) window.localStorage.setItem(storageKey, JSON.stringify(next))
    else window.localStorage.removeItem(storageKey)
  } catch {
    return "storage_error"
  }
  overrides = next
  revision += 1
  listeners.forEach((listener) => listener())
  return "updated"
}

export function clearShortcutBinding(id: DesktopShortcutId): "updated" | "storage_error" {
  if (!readLatestOverrides()) return "storage_error"
  return persistOverrides({ ...overrides, [id]: { binding: "", keys: "" } })
}

export function resetShortcutBinding(id: DesktopShortcutId): "updated" | "storage_error" | "conflict" {
  if (!readLatestOverrides()) return "storage_error"
  for (const otherId of Object.keys(desktopShortcuts) as DesktopShortcutId[]) {
    if (otherId !== id && getShortcut(otherId).bindings.some((binding) => desktopShortcuts[id].bindings.some((defaultBinding) => normalizedBinding(binding) === normalizedBinding(defaultBinding)))) return "conflict"
  }
  const next = { ...overrides }; delete next[id]
  return persistOverrides(next)
}

export function resetAllShortcutBindings(): "updated" | "storage_error" {
  return persistOverrides({})
}

export function subscribeShortcutChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getShortcutRevision(): number {
  return revision
}

export function shortcutLabel(id: DesktopShortcutId, isMac = false): string {
  if (!getShortcut(id).bindings.length) return "未设置"
  return `${isMac ? "⌘" : "Ctrl"}+${getShortcut(id).keys}`
}
