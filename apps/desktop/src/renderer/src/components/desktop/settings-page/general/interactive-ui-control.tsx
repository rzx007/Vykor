import { useState } from "react"
import { Switch } from "@renderer/components/ui/switch"
import { useInteractiveUiPreference } from "@renderer/stores/interactive-ui-preference"
import { errorMessage } from "../shared/settings-error-message"

export function InteractiveUiControl() {
  const { enabled, error: readError } = useInteractiveUiPreference()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState("")
  const error = readError || saveError

  async function update(next: boolean) {
    setSaving(true)
    setSaveError("")
    try {
      await window.desktop.settings.updateInteractiveUiEnabled(next)
    } catch (failure) {
      setSaveError(errorMessage(failure))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Switch
        id="general-interactive-ui"
        checked={enabled === true}
        disabled={enabled === null || saving}
        onCheckedChange={(next) => void update(next)}
      />
      {error ? <p role="alert" className="max-w-64 text-right text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
