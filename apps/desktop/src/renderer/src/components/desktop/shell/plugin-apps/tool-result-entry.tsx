import { useEffect, useState } from "react"
import { ArrowUpRight, AppWindow } from "lucide-react"
import type { DesktopSessionPart } from "@shared/session-types"
import { Button } from "@renderer/components/ui/button"
import { usePluginApps, usePluginAppPages } from "./provider"
const isAppResult = (part: DesktopSessionPart) => part.type === "tool" && part.status === "completed" && !part.isError && !!part.metadata.pluginAppSource

/** Only a unique catalog surface can share an entry; ambiguous tool-result apps stay distinct. */
export function PluginAppToolResultEntries({ parts }: { parts: DesktopSessionPart[] }) {
  const manager = usePluginApps()
  const [merged, setMerged] = useState<Record<string, boolean>>({})
  const candidates = parts.filter(isAppResult)
  const groups = new Map<string, DesktopSessionPart[]>()
  for (const part of candidates) {
    const source = part.metadata.pluginAppSource as Record<string, unknown>
    const key = JSON.stringify([part.sessionId, ...["pluginId", "pluginVersion", "pluginDigest", "definitionDigest", "backendId", "backendKind", "resourceUri"].map(field => source[field])])
    groups.set(key, [...(groups.get(key) ?? []), part])
  }
  // Text streaming does not change the successful Part identities or require another catalog read.
  const signature = JSON.stringify([...groups].map(([key, values]) => [key, values.map(part => [part.id, part.seq])]))
  useEffect(() => {
    let current = true
    if (!manager) return
    for (const [key, values] of groups) {
      const latest = values.reduce((a, b) => a.seq > b.seq ? a : b)
      void manager.resultSurface(latest.sessionId, latest.metadata.pluginAppSource).then(surface => {
        if (current) setMerged(prior => ({ ...prior, [key]: !!surface }))
      })
    }
    return () => { current = false }
    // groups is fully represented by signature; streaming chat text must not repeat these queries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager, signature])
  // Catalog lookup only reduces repetition; it must never gate the original open actions.
  return <>{[...groups].flatMap(([key, values]) => merged[key] ? [values.reduce((a, b) => a.seq > b.seq ? a : b)] : values)
    .map(part => <PluginAppToolResultEntry key={part.id} part={part} />)}</>
}
/** A successful committed Part offers an explicit open action; replay never opens a frame. */
export function PluginAppToolResultEntry({ part }: { part: DesktopSessionPart }) {
  const manager = usePluginApps(), pages = usePluginAppPages()
  const [title, setTitle] = useState("插件应用"), [busy, setBusy] = useState(false), [error, setError] = useState<string>()
  const [viewed, setViewed] = useState<{ sessionId: string; sourcePartId: string; pageId: string }>()
  const eligible = isAppResult(part)
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
