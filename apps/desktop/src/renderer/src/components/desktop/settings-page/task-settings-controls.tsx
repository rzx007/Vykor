import { useEffect, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import { Switch } from "@renderer/components/ui/switch"
import type { TaskLimitsSnapshot } from "@shared/configuration-settings-types"
import { errorMessage } from "./settings-error-message"

export function AutoReviewControl() {
  const [mode, setMode] = useState<"off" | "risk_based" | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    let alive = true
    void window.desktop.configurationSettings.review().then(
      (value) => {
        if (alive) setMode(value.mode)
      },
      (failure) => {
        if (alive) setError(errorMessage(failure))
      }
    )
    return () => {
      alive = false
    }
  }, [])
  async function update(enabled: boolean) {
    if (mode === null || busy) return
    setBusy(true)
    setError("")
    try {
      setMode(
        (
          await window.desktop.configurationSettings.updateReview({
            mode: enabled ? "risk_based" : "off",
            expected: mode,
          })
        ).mode
      )
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col items-end gap-1.5">
      <Switch
        id="auto-review-mode"
        aria-label="完成后自动检查"
        disabled={mode === null || busy}
        checked={mode === "risk_based"}
        onCheckedChange={(enabled) => void update(enabled)}
      />
      {error ? (
        <p role="alert" className="max-w-64 text-right text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function TaskLimitControl() {
  const [snapshot, setSnapshot] = useState<TaskLimitsSnapshot | null>(null)
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  useEffect(() => {
    let alive = true
    if (typeof window.desktop.configurationSettings.limits !== "function") {
      setError("重启应用后可使用新的任务轮数设置。")
      return () => {
        alive = false
      }
    }
    void window.desktop.configurationSettings.limits().then(
      (next) => {
        if (alive) {
          setSnapshot(next)
          setValue(String(next.maxTurns))
        }
      },
      (failure) => {
        if (alive) setError(errorMessage(failure))
      }
    )
    return () => {
      alive = false
    }
  }, [])
  async function save() {
    if (!snapshot || busy || !snapshot.editable) return
    if (!Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 1000) {
      setError("请输入 1–1000 的整数。")
      return
    }
    setBusy(true)
    setError("")
    setNotice("")
    try {
      const next = await window.desktop.configurationSettings.updateLimits({
        maxTurns: Number(value),
        expectedMaxTurns: snapshot.maxTurns,
      })
      setSnapshot(next)
      setValue(String(next.maxTurns))
      setNotice("已保存，后续任务生效。")
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  async function reread() {
    if (busy || typeof window.desktop.configurationSettings.limits !== "function") return
    setBusy(true)
    setError("")
    setNotice("")
    try {
      const next = await window.desktop.configurationSettings.limits()
      setSnapshot(next)
      setValue(String(next.maxTurns))
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <Input
          id="general-max-turns"
          aria-label="任务轮数上限"
          type="number"
          min={1}
          max={1000}
          placeholder="默认 50"
          className="w-24"
          value={value}
          disabled={!snapshot?.editable || busy}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!snapshot?.editable || busy || Number(value) === snapshot?.maxTurns}
          onClick={() => void save()}
        >
          保存
        </Button>
      </div>
      {error ? (
        <div className="flex max-w-72 items-center gap-2">
          <p role="alert" className="text-right text-xs text-destructive">
            {error}
          </p>
          {typeof window.desktop.configurationSettings.limits === "function" ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reread()}>
              重新读取
            </Button>
          ) : null}
        </div>
      ) : snapshot?.reason ? (
        <p className="max-w-72 text-right text-xs text-muted-foreground">{snapshot.reason}</p>
      ) : notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </div>
  )
}
