import { useState } from "react"
import type { PluginUiInstanceRecord } from "@rzx/client"
import type { DesktopSessionPart } from "@shared/session-types"
import { toolOutputText } from "../models/message-content"
import { useToolDetails } from "./use-tool-details"
/** Historical output remains readable; retired UI never mounts or issues requests. */
export function PluginUiHistoryCard({
  instance,
  call,
  result,
}: {
  instance: PluginUiInstanceRecord
  call: DesktopSessionPart
  result?: DesktopSessionPart
}) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const outputPreview = (result?.output != null ? result : call).bodyView?.output === "preview"
  const details = useToolDetails(call, result, detailsOpen && outputPreview)
  const text =
    toolOutputText(details.result?.output ?? details.call.output) ?? result?.text ?? call.text
  return (
    <section
      aria-label={instance.title}
      className="min-w-0 overflow-hidden rounded-2xl border border-border/60 bg-background"
    >
      <header className="px-4 py-3">
        <h3 className="text-sm font-medium">{instance.title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">旧插件界面已停用，历史结果保留。</p>
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
    </section>
  )
}
