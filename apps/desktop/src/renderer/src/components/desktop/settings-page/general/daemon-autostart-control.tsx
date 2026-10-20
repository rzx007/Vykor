import { useCallback, useEffect, useState } from "react"

import { Switch } from "@renderer/components/ui/switch"
import type { DesktopDaemonAutoStartSnapshot } from "@shared/settings-types"
import { errorMessage } from "../shared/settings-error-message"

export function DaemonAutoStartControl(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopDaemonAutoStartSnapshot | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setSnapshot(await window.desktop.daemonAutoStart.snapshot())
      setError(null)
    } catch (loadError) {
      setError(errorMessage(loadError))
    }
  }, [])

  useEffect(() => {
    const run = () => {
      void refresh()
    }

    queueMicrotask(run)

    const handleFocus = () => {
      void refresh()
    }

    window.addEventListener("focus", handleFocus)
    return () => window.removeEventListener("focus", handleFocus)
  }, [refresh])

  const update = async (enabled: boolean): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      setSnapshot(
        enabled
          ? await window.desktop.daemonAutoStart.enable()
          : await window.desktop.daemonAutoStart.disable()
      )
    } catch (updateError) {
      setError(errorMessage(updateError))
      await refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Switch
        aria-label="后台持续运行"
        checked={snapshot?.enabled ?? false}
        disabled={!snapshot || saving}
        onCheckedChange={(checked) => void update(checked)}
      />
      {error ? (
        <p role="alert" className="text-ui-caption max-w-64 text-right text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
