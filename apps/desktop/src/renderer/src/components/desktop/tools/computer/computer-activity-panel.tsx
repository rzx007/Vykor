import { CirclePause, CirclePlay, CircleStop, MonitorCog } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover"
import type { DesktopComputerActivity, DesktopComputerControl } from "@shared/computer-types"

const statusText: Record<Exclude<DesktopComputerActivity["phase"], "stopped">, string> = {
  ready: "电脑操作",
  observing: "电脑操作",
  foreground: "正在使用键鼠",
  paused: "已暂停",
}

export function ComputerActivityMenu({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const [activity, setActivity] = useState<DesktopComputerActivity | null>(null)

  useEffect(() => {
    const computer = window.desktop?.computer
    if (!computer?.onActivity || !computer.getActivity) return
    let mounted = true
    let received = false
    let current: DesktopComputerActivity | null = null
    const show = (snapshot: DesktopComputerActivity | null) => {
      current = snapshot
      setActivity(snapshot)
    }
    const unsubscribe = computer.onActivity((update) => {
      if (update.sessionId !== sessionId || !mounted) return
      received = true
      show(update.activity)
    })
    void computer.getActivity(sessionId).then((snapshot) => {
      if (mounted && !received) show(snapshot)
    }).catch(() => {})
    return () => {
      mounted = false
      unsubscribe()
      if (current && current.phase !== "paused" && current.phase !== "stopped") {
        void computer.control({ sessionId, runId: current.runId, action: "pause" }).catch(() => {})
      }
    }
  }, [sessionId])

  if (!activity || activity.sessionId !== sessionId) return null
  const cleanupVisible = activity.inputRelease !== undefined || activity.captureRevocation !== undefined
  if (activity.phase === "stopped" && !cleanupVisible) return null
  if ((activity.phase === "ready" || activity.phase === "observing") &&
    !cleanupVisible && !activity.preview) return null
  return <ComputerActivityControls key={activity.runId} activity={activity} />
}

function ComputerActivityControls({ activity }: { activity: DesktopComputerActivity }): React.JSX.Element | null {
  const previewId = useId()
  const [showPreview, setShowPreview] = useState(false)
  const [pending, setPending] = useState<DesktopComputerControl["action"] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const latest = useRef<symbol | undefined>(undefined)
  const { sessionId, runId, phase, preview, captureRevocation, inputRelease } = activity
  const captureEnabled = activity.captureEnabled !== false
  const canShowPreview = captureEnabled && phase !== "paused" && phase !== "stopped" && Boolean(preview)
  const expanded = canShowPreview && showPreview
  const target =
    activity.title && activity.title !== activity.app
      ? [activity.app, activity.title].filter(Boolean).join(" · ")
      : activity.app
  const captureStatus = captureRevocation === "pending" ? "正在撤回后台待发送的截图" : "无法确认后台截图已撤回"
  const status = inputRelease === "pending" ? "正在释放键鼠"
    : inputRelease === "failed" ? "无法确认键鼠已释放"
    : phase === "stopped" ? captureStatus : statusText[phase]
  const canDismiss = phase === "stopped" && inputRelease !== "pending" && captureRevocation !== "pending"

  async function request(action: DesktopComputerControl["action"]): Promise<void> {
    const attempt = Symbol()
    latest.current = attempt
    setPending(action)
    setError(null)
    try {
      const accepted = await window.desktop.computer.control({ sessionId, runId, action })
      if (!accepted && latest.current === attempt) {
        setError(action === "resume" ? "暂时无法继续，请检查目标窗口后重试。"
          : action === "stop" ? "未收到完整停止回执。" : "未能确认这次操作完成。")
      }
    } catch {
      if (latest.current === attempt) setError(action === "stop" ? "未收到完整停止回执。" : "无法完成请求，请重试。")
    } finally {
      if (latest.current === attempt) setPending(null)
    }
  }

  if (canDismiss && dismissed) return null
  const menuLabel = phase === "paused" ? "电脑操作已暂停" :
    phase === "stopped" ? "电脑操作清理状态" : "电脑操作选项"
  return (
    <Popover>
      <PopoverTrigger render={
        <Button type="button" size="sm" shape="pill" variant="ghost" aria-label={menuLabel} title={menuLabel} />
      }>
        <MonitorCog className="size-3.5" aria-hidden="true" />
        {phase === "paused" ? "已暂停" : null}
      </PopoverTrigger>
      <PopoverContent
        aria-label="电脑操作"
        side="top"
        align="start"
        sideOffset={8}
        className="w-80 max-w-(--available-width) gap-2 motion-reduce:data-open:animate-none motion-reduce:data-closed:animate-none"
      >
        <div className="flex min-w-0 items-baseline gap-2 px-2" role="status">
          <span className="max-w-full shrink-0 text-sm font-medium break-words">{status}</span>
          {target ? (
            <>
              {" "}
              <span
                className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                title={target}
              >
                {target}
              </span>
            </>
          ) : null}
        </div>
        {phase === "paused" && activity.reason ? (
          <p className="px-2 text-xs break-words text-muted-foreground">{activity.reason}</p>
        ) : null}
        {captureRevocation && (phase !== "stopped" || inputRelease) ? (
          <p role="status" className="px-2 text-xs text-muted-foreground">
            {captureStatus}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="px-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {phase !== "stopped" ? (
          <div className="flex flex-wrap items-center gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {canShowPreview ? (
                <Button
                  type="button"
                  shape="pill"
                  size="sm"
                  variant="ghost"
                  aria-expanded={expanded}
                  aria-controls={previewId}
                  onClick={() => setShowPreview(!expanded)}
                >
                  {expanded ? "收起预览" : "窗口预览"}
                </Button>
              ) : null}
              <Button
                type="button"
                shape="pill"
                size="sm"
                variant="ghost"
                disabled={captureRevocation !== undefined || pending !== null}
                onClick={() => void request(captureEnabled ? "disable_capture" : "enable_capture")}
              >
                {captureEnabled ? "关闭截图" : "允许截图"}
              </Button>
            </div>
            <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
              {phase === "paused" ? (
                <Button
                  type="button"
                  shape="pill"
                  size="sm"
                  disabled={
                    inputRelease !== undefined ||
                    captureRevocation !== undefined ||
                    pending !== null
                  }
                  onClick={() => void request("resume")}
                >
                  <CirclePlay data-icon="inline-start" />
                  继续
                </Button>
              ) : (
                <Button
                  type="button"
                  shape="pill"
                  size="sm"
                  variant="ghost"
                  aria-label="暂停并接管"
                  disabled={pending !== null}
                  onClick={() => void request("pause")}
                >
                  <CirclePause data-icon="inline-start" />
                  暂停
                </Button>
              )}
              <Button
                type="button"
                shape="pill"
                size="sm"
                variant="destructive"
                aria-label="停止电脑操作"
                disabled={pending === "stop"}
                onClick={() => void request("stop")}
              >
                <CircleStop data-icon="inline-start" />
                停止
              </Button>
            </div>
          </div>
        ) : canDismiss ? (
          <Button
            type="button"
            shape="pill"
            size="sm"
            variant="ghost"
            className="self-end"
            onClick={() => setDismissed(true)}
          >
            关闭提示
          </Button>
        ) : null}
        {expanded && preview ? (
          <img
            id={previewId}
            className="max-h-[35vh] w-auto max-w-full rounded-lg border border-border object-contain"
            src={preview.dataUrl}
            width={preview.width}
            height={preview.height}
            alt="当前目标窗口画面"
            draggable={false}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
