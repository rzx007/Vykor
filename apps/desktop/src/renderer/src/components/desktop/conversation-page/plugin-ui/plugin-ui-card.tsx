import { useEffect, useRef, useState } from "react"
import { CircleStop, CircleX, PanelsTopLeft, PanelRightOpen, X } from "lucide-react"
import type { PluginUiInstanceRecord } from "@vykor/client"
import type { DesktopSessionPart } from "@shared/session-types"
import { Button } from "@renderer/components/ui/button"
import { toolOutputText } from "../message/message-content"
import { toolCallStatus } from "../message/message-render-model"
import { PluginUiFrame } from "./plugin-ui-frame"
import { usePluginUiHost } from "./plugin-ui-provider"
import { useToolDetails } from "../message/use-tool-details"

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
  const [detailsOpen, setDetailsOpen] = useState(false)
  const outputPreview = (result?.output != null ? result : call).bodyView?.output === "preview"
  const details = useToolDetails(call, result, detailsOpen && outputPreview)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const display = host?.displays.find(
    (display) =>
      display.instance.instanceId === instance.instanceId && display.surface === "tool-result"
  )
  const text =
    toolOutputText(details.result?.output ?? details.call.output) ?? result?.text ?? call.text
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
    <section
      aria-label={instance.title}
      className="min-w-0 overflow-hidden rounded-2xl border border-border/60 bg-background"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{instance.title}</h3>
          <p className="mt-1 text-xs break-all text-muted-foreground">
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
      {text && outputPreview ? (
        <details
          className="px-4 pb-4 text-xs"
          onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-muted-foreground">
            {details.preview ? "结果预览 · 查看完整结果" : "完整结果"}
          </summary>
          {details.preview ? (
            <p role="status" className="py-2 text-muted-foreground">
              {details.error ??
                (detailsOpen ? "正在加载完整详情；当前仅显示预览。" : "当前仅显示预览。")}
            </p>
          ) : null}
          <pre className="max-h-64 overflow-auto pt-2 break-all whitespace-pre-wrap">{text}</pre>
        </details>
      ) : text ? (
        <pre className="max-h-64 overflow-auto px-4 pb-4 text-xs break-all whitespace-pre-wrap">
          {text}
        </pre>
      ) : null}
      {display && <PluginUiFrame key={display.key} display={display} />}
      {host?.available && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-border/60 px-4 py-3">
          {instance.surfaces.includes("tool-result") &&
            (display ? (
              <Button
                variant="ghost"
                size="sm"
                shape="pill"
                title="只收起界面，结果保留，可重新打开"
                onClick={() => host.close(instance.instanceId)}
              >
                <X data-icon="inline-start" />
                关闭显示
              </Button>
            ) : (
              <Button
                variant="control"
                size="sm"
                shape="pill"
                onClick={(event) => host.open(instance, "tool-result", event.currentTarget)}
              >
                <PanelsTopLeft data-icon="inline-start" />
                打开交互
              </Button>
            ))}
          {instance.surfaces.includes("session-sidebar") && (
            <Button
              variant="ghost"
              size="sm"
              shape="pill"
              title="只改变显示位置，不执行插件工具"
              onClick={(event) => host.open(instance, "session-sidebar", event.currentTarget)}
            >
              <PanelRightOpen data-icon="inline-start" />
              在侧栏打开
            </Button>
          )}
          {canDismiss && (
            <Button
              variant="destructive"
              size="sm"
              shape="pill"
              className="ml-auto"
              title="确认后结束交互，保留原始结果"
              onClick={() => {
                void dismiss()
              }}
            >
              <CircleX data-icon="inline-start" />
              取消交互
            </Button>
          )}
          {activeAction && (
            <Button
              variant="destructive"
              size="sm"
              shape="pill"
              onClick={() => {
                void window.desktop.sessions
                  .interrupt({ sessionId: instance.sessionId, expectedRunId: activeAction })
                  .catch(() => setMessage("操作未能停止，请查看会话状态。"))
              }}
            >
              <CircleStop data-icon="inline-start" />
              停止操作
            </Button>
          )}
        </footer>
      )}
    </section>
  )
}
