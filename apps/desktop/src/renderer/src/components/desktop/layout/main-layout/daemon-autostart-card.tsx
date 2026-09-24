import { useEffect, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { Spinner } from "@renderer/components/ui/spinner"
import type { DesktopDaemonAutoStartSnapshot } from "@shared/settings-types"
import { errorMessage } from "../../settings-page/settings-error-message"

export function DaemonAutoStartCard(): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<DesktopDaemonAutoStartSnapshot | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!window.desktop?.daemonAutoStart) return
    let cancelled = false
    void window.desktop.daemonAutoStart
      .snapshot()
      .then((value) => {
        if (!cancelled) setSnapshot(value)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  if (!snapshot?.showOnboarding) return null

  const run = async (action: "enable" | "dismiss"): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const next =
        action === "enable"
          ? await window.desktop.daemonAutoStart.enable()
          : await window.desktop.daemonAutoStart.dismissOnboarding()
      setSnapshot(next)
    } catch (actionError) {
      setError(errorMessage(actionError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-w-0 px-2 py-2">
      <section
        aria-label="保持后台运行"
        aria-busy={saving}
        className="rounded-md bg-background p-3 shadow-sm ring-1 ring-black/5"
      >
        <h2 className="text-ui-small font-medium">保持后台运行</h2>
        <p className="mt-1 text-xs leading-5 text-sidebar-muted">
          关闭 Vykor 后，定时任务和后台工作仍可继续。
        </p>
        {error ? (
          <p role="alert" className="mt-1 text-xs leading-5 text-destructive">
            {error}
          </p>
        ) : null}
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" disabled={saving} onClick={() => void run("enable")}>
            {saving ? <Spinner data-icon="inline-start" /> : null}
            {error ? "重试" : "开启"}
          </Button>
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => void run("dismiss")}>
            暂不开启
          </Button>
        </div>
      </section>
    </div>
  )
}
