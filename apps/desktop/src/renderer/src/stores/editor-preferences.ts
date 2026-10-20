import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

interface EditorPreferences {
  readOnly: boolean
  wordWrap: boolean
  tabSize: 2 | 4
}
const defaults: EditorPreferences = { readOnly: false, wordWrap: true, tabSize: 2 }
export const useEditorPreferences = create<
  EditorPreferences & {
    update(preferences: Partial<EditorPreferences>): void
  }
>()(
  persist((set) => ({ ...defaults, update: (preferences) => set(preferences) }), {
    name: "vykor.desktop.editor-preferences",
    storage: createJSONStorage(() => localStorage),
    partialize: ({ readOnly, wordWrap, tabSize }) => ({ readOnly, wordWrap, tabSize }),
    merge: (saved, current) => {
      const value = saved as Partial<EditorPreferences> | undefined
      return {
        ...current,
        readOnly: typeof value?.readOnly === "boolean" ? value.readOnly : defaults.readOnly,
        wordWrap: typeof value?.wordWrap === "boolean" ? value.wordWrap : defaults.wordWrap,
        tabSize: value?.tabSize === 4 ? 4 : 2,
      }
    },
  })
)
