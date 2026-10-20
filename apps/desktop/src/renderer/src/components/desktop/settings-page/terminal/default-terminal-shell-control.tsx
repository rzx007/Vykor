import { TerminalSquare } from "lucide-react"
import { useEffect, useState } from "react"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import type { DesktopDetectedTerminalShell } from "@shared/terminal-types"

import { errorMessage } from "../shared/settings-error-message"
import {
  resolveSelectedTerminalShellId,
  SYSTEM_TERMINAL_SHELL_ID,
} from "./resolve-selected-terminal-shell"

export function DefaultTerminalShellControl(): React.JSX.Element {
  const [shells, setShells] = useState<DesktopDetectedTerminalShell[]>([])
  const [defaultTerminalShellId, setDefaultTerminalShellId] = useState<string | null>(null)
  const [preferenceReady, setPreferenceReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resolvedId = preferenceReady
    ? resolveSelectedTerminalShellId(defaultTerminalShellId, shells)
    : ""
  const currentLabel = labelFor(resolvedId, shells)
  const disabled = loading || saving

  useEffect(() => {
    let cancelled = false
    void Promise.all([window.desktop.settings.snapshot(), window.desktop.terminal.listShells()])
      .then(([snapshot, nextShells]) => {
        if (cancelled) return
        setDefaultTerminalShellId(snapshot.defaultTerminalShellId)
        setShells(nextShells)
        setPreferenceReady(true)
      })
      .catch((loadError: unknown) => {
        if (cancelled) return
        setShells([])
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
    const persisted = nextId === SYSTEM_TERMINAL_SHELL_ID ? null : nextId
    if (saving || persisted === defaultTerminalShellId) return
    const previous = defaultTerminalShellId
    setDefaultTerminalShellId(persisted)
    setSaving(true)
    setError(null)
    void window.desktop.settings
      .updateDefaultTerminalShell({ defaultTerminalShellId: persisted })
      .then((snapshot) => setDefaultTerminalShellId(snapshot.defaultTerminalShellId))
      .catch((saveError: unknown) => {
        setDefaultTerminalShellId(previous)
        setError(errorMessage(saveError))
      })
      .finally(() => setSaving(false))
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Select
        value={resolvedId}
        onValueChange={(value) => {
          if (typeof value === "string" && value) update(value)
        }}
      >
        <SelectTrigger aria-label="集成终端 Shell" disabled={disabled} className="min-w-36">
          <SelectValue>
            {preferenceReady ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <TerminalSquare className="size-3.5 shrink-0" />
                <span className="truncate">{currentLabel}</span>
              </span>
            ) : (
              "正在读取…"
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value={SYSTEM_TERMINAL_SHELL_ID}>系统默认</SelectItem>
            {shells.map((shell) => (
              <SelectItem key={shell.id} value={shell.id}>
                {shell.label}
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

function labelFor(id: string, shells: DesktopDetectedTerminalShell[]): string {
  if (id === SYSTEM_TERMINAL_SHELL_ID || !id) return "系统默认"
  return shells.find((shell) => shell.id === id)?.label ?? "系统默认"
}
