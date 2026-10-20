import { useEffect, useState } from "react"

import { OpenerIcon } from "@renderer/components/desktop/open-with/opener-icon"
import { resolveSelectedOpener } from "@renderer/components/desktop/open-with/resolve-selected-opener"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import type { WorkspaceOpener } from "@shared/workspace-types"

import { errorMessage } from "../shared/settings-error-message"

export function DefaultOpenerControl(): React.JSX.Element {
  const [openers, setOpeners] = useState<WorkspaceOpener[]>([])
  const [defaultOpenerId, setDefaultOpenerId] = useState<string | null>(null)
  const [preferenceReady, setPreferenceReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resolved = preferenceReady ? resolveSelectedOpener(openers, defaultOpenerId) : null
  const empty = !loading && openers.length === 0
  const disabled = loading || saving || empty

  useEffect(() => {
    let cancelled = false
    void Promise.all([window.desktop.settings.snapshot(), window.desktop.workspace.listOpeners()])
      .then(([snapshot, nextOpeners]) => {
        if (cancelled) return
        setDefaultOpenerId(snapshot.defaultOpenerId)
        setOpeners(nextOpeners)
        setPreferenceReady(true)
      })
      .catch((loadError: unknown) => {
        if (cancelled) return
        setOpeners([])
        setPreferenceReady(true)
        setError(errorMessage(loadError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const update = (nextId: string): void => {
    if (saving || nextId === resolved?.id) return
    const previous = defaultOpenerId
    setDefaultOpenerId(nextId)
    setSaving(true)
    setError(null)
    void window.desktop.settings
      .updateDefaultOpener({ defaultOpenerId: nextId })
      .then((snapshot) => setDefaultOpenerId(snapshot.defaultOpenerId))
      .catch((saveError: unknown) => {
        setDefaultOpenerId(previous)
        setError(errorMessage(saveError))
      })
      .finally(() => setSaving(false))
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Select
        value={resolved?.id ?? ""}
        onValueChange={(value) => {
          if (typeof value === "string" && value) update(value)
        }}
      >
        <SelectTrigger aria-label="默认文件打开目标" disabled={disabled} className="min-w-36">
          <SelectValue>
            {empty ? (
              "未找到可用的打开方式"
            ) : resolved ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <OpenerIcon opener={resolved} />
                <span className="truncate">{resolved.label}</span>
              </span>
            ) : (
              "正在读取…"
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {openers.map((opener) => (
              <SelectItem key={opener.id} value={opener.id}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <OpenerIcon opener={opener} />
                  <span className="truncate">{opener.label}</span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {error ? (
        <p role="alert" className="text-ui-caption max-w-56 text-right text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
