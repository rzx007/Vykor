import { MonitorCog } from "lucide-react"
import { useEffect, useState } from "react"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import type { DesktopAgentEnvironment } from "@shared/settings-types"
import { runtimeEnvironmentLabel, runtimeEnvironmentNotice } from "./runtime-setting-model"

export function RuntimeSettingControl(): React.JSX.Element {
  const [environment, setEnvironment] = useState<DesktopAgentEnvironment>("native")
  const [wslSupported, setWslSupported] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.desktop.settings
      .snapshot()
      .then((snapshot) => {
        if (!cancelled) {
          setEnvironment(snapshot.agentEnvironment)
          setRestartRequired(snapshot.restartRequired)
          setWslSupported(snapshot.wslSupported ?? false)
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const update = (next: "native" | "wsl"): void => {
    if (saving || next === environment) return
    const previous = environment
    setEnvironment(next)
    setSaving(true)
    setError(null)
    void window.desktop.settings
      .updateAgentEnvironment({ environment: next })
      .then((snapshot) => {
        setEnvironment(snapshot.agentEnvironment)
        setRestartRequired(snapshot.restartRequired)
      })
      .catch((caught: unknown) => {
        setEnvironment(previous)
        setError(errorMessage(caught))
      })
      .finally(() => setSaving(false))
  }

  const notice = runtimeEnvironmentNotice(restartRequired)
  return (
    <div className="flex flex-col items-end gap-1.5" aria-busy={loading || saving}>
      <Select
        value={environment}
        onValueChange={(value) => {
          if (value === "native" || value === "wsl") update(value)
        }}
      >
        <SelectTrigger
          aria-label="智能体运行环境"
          aria-invalid={Boolean(error)}
          disabled={loading || saving}
          className="min-w-44"
        >
          <MonitorCog />
          <SelectValue>{runtimeEnvironmentLabel(environment)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="native">本机</SelectItem>
            {wslSupported ? <SelectItem value="wsl">WSL</SelectItem> : null}
          </SelectGroup>
        </SelectContent>
      </Select>
      {error ? (
        <p role="alert" className="text-ui-caption max-w-72 text-right text-destructive">
          {error}
        </p>
      ) : notice ? (
        <p className="text-ui-caption max-w-72 text-right text-muted-foreground">{notice}</p>
      ) : null}
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
