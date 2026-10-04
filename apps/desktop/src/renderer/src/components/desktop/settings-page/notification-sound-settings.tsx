import { Fragment, useEffect, useState } from "react"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@renderer/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import { Separator } from "@renderer/components/ui/separator"
import { playNotificationSound } from "@renderer/lib/notification-sound"
import {
  DESKTOP_SOUND_OPTIONS,
  isDesktopSoundId,
  normalizeNotificationSounds,
} from "@shared/settings-types"
import type { DesktopNotificationSound, DesktopNotificationSounds } from "@shared/settings-types"
import { errorMessage } from "./settings-error-message"

const options = [
  { status: "completed", title: "智能体", description: "当智能体完成本轮任务时播放声音。" },
  { status: "needs_input", title: "权限", description: "当需要你授权时播放声音。" },
  { status: "failed", title: "错误", description: "发生运行错误时播放声音。" },
] as const

export function NotificationSoundSettings(): React.JSX.Element {
  const [sounds, setSounds] = useState<DesktopNotificationSounds>(() =>
    normalizeNotificationSounds(undefined)
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.desktop.settings
      .snapshot()
      .then((snapshot) => {
        if (!cancelled) setSounds(normalizeNotificationSounds(snapshot.notificationSounds))
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function update(status: DesktopNotificationSound, id: string): Promise<void> {
    if (saving || sounds[status] === id) return
    setSaving(true)
    setError(null)
    const nextSounds = { ...sounds, [status]: id }
    void playNotificationSound(id)
    try {
      const snapshot = await window.desktop.settings.updateNotificationSounds({
        notificationSounds: nextSounds,
      })
      setSounds(normalizeNotificationSounds(snapshot.notificationSounds ?? nextSounds))
    } catch (saveError) {
      setError(errorMessage(saveError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <FieldGroup className="gap-0">
      {options.map(({ status, title, description }, index) => (
        <Fragment key={status}>
          {index > 0 ? <Separator /> : null}
          <Field
            orientation="horizontal"
            className="min-h-20 gap-6 py-4"
            data-disabled={loading || saving}
          >
            <FieldContent>
              <FieldLabel htmlFor={`sound-${status}`}>{title}</FieldLabel>
              <FieldDescription>{description}</FieldDescription>
            </FieldContent>
            <Select
              items={DESKTOP_SOUND_OPTIONS}
              value={sounds[status]}
              onValueChange={(value) => {
                if (isDesktopSoundId(value)) void update(status, value)
              }}
            >
              <SelectTrigger
                id={`sound-${status}`}
                aria-label={`${title}音效`}
                disabled={loading || saving}
                className="min-w-40"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                align="end"
                alignItemWithTrigger={false}
                className="max-h-[min(18rem,var(--available-height))] min-w-44"
              >
                <SelectGroup>
                  {DESKTOP_SOUND_OPTIONS.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </Fragment>
      ))}
      {error ? (
        <p role="alert" className="pb-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </FieldGroup>
  )
}
