import { toast } from "@renderer/lib/toast"
import { useEffect, useRef, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import { Switch } from "@renderer/components/ui/switch"
import { Skeleton } from "@renderer/components/ui/skeleton"
import type {
  DesktopNotificationEvent,
  NotificationSettingsSnapshot,
} from "@shared/notification-settings-types"
import { NotificationSoundSettings } from "./notification-sound-settings"
import { errorMessage } from "./settings-error-message"
import { SettingsGroup, SettingsRow } from "./settings-group"
import { NotificationModeSelect } from "./general-quick-controls"
import { ChevronDown } from "lucide-react"

const events: Array<{ id: DesktopNotificationEvent; label: string; detail: string }> = [
  { id: "completed", label: "任务完成", detail: "本轮任务正常完成时提醒。" },
  { id: "failed", label: "任务失败", detail: "手动取消不提醒。" },
  { id: "needs_input", label: "需要用户处理", detail: "需要批准或回复时提醒。" },
]

export function NotificationSettings() {
  const [snapshot, setSnapshot] = useState<NotificationSettingsSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locked = useRef(false)
  const mounted = useRef(true)

  async function run(operation: () => Promise<void>) {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure))
    } finally {
      locked.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const load = () =>
    run(async () => {
      const next = await window.desktop.notificationSettings.snapshot()
      if (mounted.current) setSnapshot(next)
    })
  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
    }
  }, [])

  return (
    <div className="settings-content-column">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">通知</h1>
        <p className="text-xs text-muted-foreground">
          选择何时提醒你，以及提醒声音。更改自动保存。
        </p>
      </header>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {!snapshot ? (
        <>
          <Skeleton className="h-36" />
          <Button variant="ghost" disabled={busy} onClick={() => void load()}>
            重新读取
          </Button>
        </>
      ) : (
        <SettingsGroup title="系统通知" id="notification-system-title">
          <div className="divide-y divide-border">
            <SettingsRow
              title="通知显示"
              description="选择何时收到任务提醒。"
              control={
                <NotificationModeSelect
                  value={snapshot.mode}
                  disabled={busy}
                  onChange={(mode) =>
                    void run(async () => {
                      setSnapshot(
                        await window.desktop.notificationSettings.updateMode({
                          mode,
                          expectedMode: snapshot.mode,
                        })
                      )
                      toast.success("通知模式已保存。")
                    })
                  }
                />
              }
            />
            {snapshot.mode !== "never"
              ? events.map((event) => (
                  <SettingsRow
                    key={event.id}
                    title={event.label}
                    description={event.detail}
                    control={
                      <Switch
                        checked={snapshot.events[event.id]}
                        aria-label={`${event.label}系统通知`}
                        disabled={busy}
                        onCheckedChange={(enabled) =>
                          void run(async () => {
                            setSnapshot(
                              await window.desktop.notificationSettings.updateEvents({
                                events: { ...snapshot.events, [event.id]: enabled },
                                expectedEvents: snapshot.events,
                              })
                            )
                            toast.success("通知事件偏好已保存。")
                          })
                        }
                      />
                    }
                  />
                ))
              : null}
          </div>
          <p className="border-t py-3 text-xs text-muted-foreground">
            通知只显示任务状态，点击可打开对应会话。
          </p>
        </SettingsGroup>
      )}
      <SettingsGroup title="音效" id="notification-sound-title">
        <NotificationSoundSettings />
        <p className="border-t py-3 text-xs text-muted-foreground">
          音效独立于系统通知，选择后试听；“无声音”关闭。
        </p>
      </SettingsGroup>
      {snapshot ? (
        <details id="notification-capability-title" className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span>通知排查与测试</span>
            <ChevronDown
              className="size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </summary>
          <div className="mt-4">
            <SettingsGroup title="系统状态">
              <div className="flex flex-col gap-4 py-4">
                <p className="text-sm" role="status">
                  {snapshot.system.detail}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="ghost" disabled={busy} onClick={() => void load()}>
                    重新检查
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || !snapshot.system.supported}
                    onClick={() =>
                      void run(async () => {
                        const result = await window.desktop.notificationSettings.test()
                        if (result.status === "failed") setError(result.detail)
                        else if (result.status === "shown") toast.success(result.detail)
                        else toast.info(result.detail)
                      })
                    }
                  >
                    发送测试通知
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy || !snapshot.system.settingsAvailable}
                    onClick={() =>
                      void run(() => window.desktop.notificationSettings.openSystemSettings())
                    }
                  >
                    打开系统通知设置
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  测试通知静音发送，不受上述通知规则限制。
                </p>
              </div>
            </SettingsGroup>
          </div>
        </details>
      ) : null}
    </div>
  )
}
