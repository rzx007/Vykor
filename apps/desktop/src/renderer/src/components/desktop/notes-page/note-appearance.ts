export const NOTE_APPEARANCE_KEY = "vykor.desktop.note-appearance-v1"

export const NOTE_COLORS = [
  { value: "default", label: "原色" },
  { value: "sand", label: "暖黄色" },
  { value: "rose", label: "玫瑰色" },
  { value: "mint", label: "薄荷色" },
  { value: "sky", label: "天空色" },
  { value: "clay", label: "浅橙色" },
  { value: "lilac", label: "淡紫色" },
] as const

export type NoteColor = (typeof NOTE_COLORS)[number]["value"]
export interface NoteAppearance {
  pinned: boolean
  color: NoteColor
}
export type NoteAppearances = Record<string, NoteAppearance>

export function readNoteAppearances(storage: Storage): NoteAppearances {
  try {
    const value: unknown = JSON.parse(storage.getItem(NOTE_APPEARANCE_KEY) ?? "null")
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([, entry]) =>
            entry &&
            typeof entry === "object" &&
            typeof entry.pinned === "boolean" &&
            NOTE_COLORS.some((color) => color.value === entry.color)
        )
        .map(([id, entry]) => [id, { pinned: entry.pinned, color: entry.color }])
    )
  } catch {
    return {}
  }
}

export function writeNoteAppearances(storage: Storage, appearances: NoteAppearances): void {
  storage.setItem(NOTE_APPEARANCE_KEY, JSON.stringify(appearances))
}
