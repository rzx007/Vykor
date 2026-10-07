import { useEffect, useRef, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select"
import { Switch } from "@renderer/components/ui/switch"
import { Skeleton } from "@renderer/components/ui/skeleton"
import type { DesktopNotificationEvent, NotificationSettingsSnapshot } from "@shared/notification-settings-types"
import { isDesktopNotificationMode, type DesktopNotificationMode } from "@shared/settings-types"
import { NotificationSoundSettings } from "./notification-sound-settings"
import { errorMessage } from "./settings-error-message"

const modeLabels: Record<DesktopNotificationMode, string> = { never: "从不", when_unfocused: "仅应用失去焦点时", always: "始终" }
const events: Array<{ id: DesktopNotificationEvent; label: string; detail: string }> = [
  { id: "completed", label: "任务完成", detail: "本轮任务正常完成时提醒。" },
  { id: "failed", label: "任务失败", detail: "运行失败时提醒；用户取消不作为失败通知。" },
  { id: "needs_input", label: "需要用户处理", detail: "需要批准或回复时提醒。" },
]

export function NotificationSettings() {
  const [snapshot, setSnapshot] = useState<NotificationSettingsSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState("")
  const locked = useRef(false)
  const mounted = useRef(true)

  async function run(operation: () => Promise<void>) {
    if (locked.current) return
    locked.current = true; setBusy(true); setError(null); setFeedback("")
    try { await operation() }
    catch (failure) { if (mounted.current) setError(errorMessage(failure)) }
    finally { locked.current = false; if (mounted.current) setBusy(false) }
  }
  const load = () => run(async () => { const next = await window.desktop.notificationSettings.snapshot(); if (mounted.current) setSnapshot(next) })
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false } }, [])

  return <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
    <header><h1 className="text-xl font-semibold">通知</h1><p className="mt-2 text-sm text-muted-foreground">当前设备的系统通知和音效。更改自动保存，立即应用到后续事件。</p></header>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {feedback && <p role="status" className="text-xs text-muted-foreground">{feedback}</p>}
    {!snapshot ? <><Skeleton className="h-36" /><Button variant="ghost" disabled={busy} onClick={() => void load()}>重新读取</Button></> : <>
      <section className="space-y-4" aria-labelledby="notification-system-title"><h2 className="text-base font-semibold" id="notification-system-title">系统通知</h2>
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-40 flex-1"><p className="text-sm font-medium">通知显示</p><p className="mt-1 text-xs text-muted-foreground">焦点按整个桌面应用判断；设置窗口和其他应用窗口也计算在内。</p></div>
          <Select value={snapshot.mode} onValueChange={(mode) => { if (isDesktopNotificationMode(mode)) void run(async () => { setSnapshot(await window.desktop.notificationSettings.updateMode({ mode, expectedMode: snapshot.mode })); setFeedback("通知模式已保存。") }) }}><SelectTrigger disabled={busy} aria-label="系统通知模式"><SelectValue>{modeLabels[snapshot.mode]}</SelectValue></SelectTrigger><SelectContent>{Object.entries(modeLabels).map(([id, label]) => <SelectItem key={id} value={id}>{label}</SelectItem>)}</SelectContent></Select>
        </div>
        {events.map((event) => <div key={event.id} className="flex items-center justify-between gap-4 border-t py-3"><div><p className="text-sm font-medium">{event.label}</p><p className="mt-1 text-xs text-muted-foreground">{event.detail}</p></div><Switch checked={snapshot.events[event.id]} aria-label={`${event.label}系统通知`} disabled={busy} onCheckedChange={(enabled) => void run(async () => { setSnapshot(await window.desktop.notificationSettings.updateEvents({ events: { ...snapshot.events, [event.id]: enabled }, expectedEvents: snapshot.events })); setFeedback("通知事件偏好已保存。") })} /></div>)}
        <p className="text-xs text-muted-foreground">通知正文只显示任务状态；点击后定位到对应会话。相同事件只提醒一次，重连不会重复弹出。</p>
      </section>
      <section className="space-y-4 border-t pt-6" aria-labelledby="notification-capability-title"><h2 className="text-base font-semibold" id="notification-capability-title">系统通知状态</h2><p className="text-sm" role="status">{snapshot.system.detail}</p>
        <div className="flex flex-wrap gap-2"><Button variant="ghost" disabled={busy} onClick={() => void load()}>重新检查</Button><Button disabled={busy || !snapshot.system.supported} onClick={() => void run(async () => { const result = await window.desktop.notificationSettings.test(); if (result.status === "failed") setError(result.detail); else setFeedback(result.detail) })}>发送测试通知</Button><Button variant="ghost" disabled={busy || !snapshot.system.settingsAvailable} onClick={() => void run(() => window.desktop.notificationSettings.openSystemSettings())}>打开系统通知设置</Button></div>
        <p className="text-xs text-muted-foreground">测试通知静音发送，便于检查系统权限；不受任务事件开关和应用焦点规则影响。</p>
      </section>
    </>}
    <section className="space-y-4 border-t pt-6" aria-labelledby="notification-sound-title"><h2 className="text-base font-semibold" id="notification-sound-title">音效</h2><NotificationSoundSettings /><p className="text-xs text-muted-foreground">音效与系统通知独立，查看当前会话时也会播放。选择“无声音”关闭对应音效；选择声音时会自动试听。</p></section>
  </div>
}
