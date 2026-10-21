import { useEffect, useState } from "react"
import { ArrowUpRight, AppWindow } from "lucide-react"
import type { DesktopSessionPart } from "@shared/session-types"
import { Button } from "@renderer/components/ui/button"
import { usePluginApps, usePluginAppPages } from "./provider"
/** A successful committed Part offers an explicit open action; replay never opens a frame. */
export function PluginAppToolResultEntry({ part }: { part: DesktopSessionPart }) {
  const manager = usePluginApps(), pages = usePluginAppPages()
  const [title, setTitle] = useState("插件应用"), [busy, setBusy] = useState(false), [error, setError] = useState<string>()
  const [viewed, setViewed] = useState<{ sessionId: string; sourcePartId: string; pageId: string }>()
  const eligible = part.type === "tool" && part.status === "completed" && !part.isError && !!part.metadata.pluginAppSource
  const page = pages.find(item => item.controller.state.source.sessionId === part.sessionId && (item.sourceParts?.has(part.id)
    || viewed?.sessionId === part.sessionId && viewed.sourcePartId === part.id && viewed.pageId === item.id))
  useEffect(() => {
    let current = true
    if (eligible && manager) void manager.resultTitle(part.sessionId, part.metadata.pluginAppSource).then(value => { if (current) setTitle(value) })
    return () => { current = false }
  }, [manager, eligible, part.sessionId, part.metadata.pluginAppSource])
  if (!manager || !eligible) return null
  return <div className="space-y-1 text-xs">
    <Button variant="ghost" shape="pill" size="sm" disabled={busy} onClick={() => {
      setBusy(true)
      const open = async () => {
        if (page) manager.focus(page)
        else {
          // Only Main can resolve an unknown Part to a page; resources may be shared by distinct surfaces.
          const opened = await manager.presentToolResult(part.sessionId, part.id)
          if (opened) setViewed({ sessionId: part.sessionId, sourcePartId: part.id, pageId: opened.id })
        }
      }
      void open().then(() => setError(undefined), () => setError("应用来源不可用，请检查插件状态。")).finally(() => setBusy(false))
    }}><AppWindow data-icon="inline-start" />{busy ? "正在打开…" : `查看${page?.title ?? title}`}<ArrowUpRight data-icon="inline-end" /></Button>
    {page && <span className="text-muted-foreground">已在右侧面板打开</span>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>
}
