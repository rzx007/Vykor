import { useEffect, useRef, useSyncExternalStore } from "react"
import { tinykeys, type KeybindingsMap } from "tinykeys"

import {
  desktopShortcuts,
  getShortcut,
  getShortcutRevision,
  subscribeShortcutChanges,
  type DesktopShortcutId,
} from "@renderer/components/desktop/desktop-shortcuts"

export type DesktopShortcutActions = Partial<Record<DesktopShortcutId, () => void>>

export function useDesktopShortcuts(actions: DesktopShortcutActions): void {
  const revision = useSyncExternalStore(subscribeShortcutChanges, getShortcutRevision)
  const actionsRef = useRef(actions)

  useEffect(() => {
    actionsRef.current = actions
  }, [actions])

  useEffect(() => {
    const keybindings: KeybindingsMap = {}
    for (const id of Object.keys(desktopShortcuts) as DesktopShortcutId[]) {
      if (!(id in actionsRef.current)) continue
      for (const binding of getShortcut(id).bindings) {
        keybindings[binding] = (event) => {
          event.preventDefault()
          actionsRef.current[id]?.()
        }
      }
    }

    return tinykeys(window, keybindings, {
      // These are application commands, so they remain active while the composer is focused.
      ignore: (event) => event.repeat || event.isComposing,
    })
  }, [revision])
}
