import { useEffect } from "react"

import { attachDesktopSessionEvents } from "@renderer/stores/desktop-session"

export function DesktopSessionEventBridge({ enabled }: { enabled: boolean }): null {
  useEffect(() => {
    if (!enabled) return
    return attachDesktopSessionEvents()
  }, [enabled])

  return null
}
