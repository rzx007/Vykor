import { useEffect, useRef, useState } from "react"
import type { PluginUiInstanceRecord } from "@vykor/client"
import type { DesktopSessionPart } from "@shared/session-types"
import { Button } from "@renderer/components/ui/button"
import { toolOutputText } from "../message/message-content"
import { toolCallStatus } from "../message/message-render-model"
import { PluginUiFrame } from "./plugin-ui-frame"
import { usePluginUiHost } from "./plugin-ui-provider"

export function PluginUiCard({
  instance,
  call,
  result,
}: {
  instance: PluginUiInstanceRecord
  call: DesktopSessionPart
  result?: DesktopSessionPart
}) {
  const host = usePluginUiHost()
  const [message, setMessage] = useState("")
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const display = host?.displays.find(
    (display) =>
      display.instance.instanceId === instance.instanceId && display.surface === "tool-result"
  )
  const text = toolOutputText(result?.output ?? call.output) ?? result?.text ?? call.text
  const failed = toolCallStatus(call, result) === "failed"
  const activeAction = instance.activeActionRunId
  const canDismiss =
    host?.available &&
    host.isCurrent(instance.instanceId) &&
    instance.status === "open" &&
    host.view?.session.status !== "archived" &&
    !activeAction
  const dismiss = async () => {
    if (!canDismiss || !host) return
    controller.current?.abort()
    controller.current = new AbortController()
    const signal = controller.current.signal
    const input = { requestId: crypto.randomUUID(), expectedRevision: instance.revision }
    try {
      await host.confirm({ instance, label: "取消此次交互", args: {}, dismiss: true }, signal)
      if (signal.aborted || !host.isCurrent(instance.instanceId)) return
      await window.desktop.pluginUi.dismiss({
        sessionId: instance.sessionId,
        instanceId: instance.instanceId,
        input,
      })
      host.close(instance.instanceId)
      setMessage("已取消交互")
    } catch {
      if (!signal.aborted) setMessage("未提交取消；可以稍后重试。")
    }
  }
  return (
    <section aria-label={instance.title} className="min-w-0 overflow-hidden rounded-lg border">
      <header className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{instance.title}</h3>
          <p className="text-xs break-all text-muted-foreground">
            {instance.pluginId} · {instance.pluginVersion}
          </p>
        </div>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {message ||
            (failed
              ? "工具失败"
              : instance.status === "resolved"
                ? "已完成"
                : instance.status === "dismissed"
                  ? "已取消"
                  : activeAction
                    ? "操作中"
                    : "等待操作")}
        </span>
      </header>
      {text && (
        <pre className="max-h-64 overflow-auto px-3 pb-3 text-xs break-all whitespace-pre-wrap">
          {text}
        </pre>
      )}
      {display && <PluginUiFrame key={display.key} display={display} />}
      {host?.available && (
        <footer className="flex flex-wrap gap-1 border-t px-2 py-1">
          {instance.surfaces.includes("tool-result") &&
            (display ? (
              <Button variant="ghost" size="sm" onClick={() => host.close(instance.instanceId)}>
                关闭显示
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={(event) => host.open(instance, "tool-result", event.currentTarget)}
              >
                打开交互
              </Button>
            ))}
          {instance.surfaces.includes("session-sidebar") && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(event) => host.open(instance, "session-sidebar", event.currentTarget)}
            >
              在侧栏打开
            </Button>
          )}
          {canDismiss && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void dismiss()
              }}
            >
              取消交互
            </Button>
          )}
          {activeAction && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void window.desktop.sessions
                  .interrupt({ sessionId: instance.sessionId, expectedRunId: activeAction })
                  .catch(() => setMessage("操作未能停止，请查看会话状态。"))
              }}
            >
              停止操作
            </Button>
          )}
        </footer>
      )}
    </section>
  )
}
