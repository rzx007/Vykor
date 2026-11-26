import { useState } from "react"
import { Switch } from "@renderer/components/ui/switch"
import {
  useInteractiveUiPreference,
  type InteractiveUiPreference,
} from "@renderer/stores/interactive-ui-preference"
import { errorMessage } from "../shared/settings-error-message"

export function InteractiveUiControl({
  preference = "generation",
}: {
  preference?: InteractiveUiPreference
}) {
  const { enabled, error: readError } = useInteractiveUiPreference(preference)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState("")
  const error = readError || saveError

  async function update(next: boolean) {
    setSaving(true)
    setSaveError("")
    try {
      if (preference === "rich") {
        await window.desktop.settings.updateRichUiEnabled(next)
      } else {
        await window.desktop.settings.updateInteractiveUiEnabled(next)
      }
    } catch (failure) {
      setSaveError(errorMessage(failure))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Switch
        id={preference === "rich" ? "general-rich-ui" : "general-interactive-ui"}
        checked={enabled === true}
        disabled={enabled === null || saving}
        onCheckedChange={(next) => void update(next)}
      />
      {error ? (
        <p role="alert" className="max-w-64 text-right text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
