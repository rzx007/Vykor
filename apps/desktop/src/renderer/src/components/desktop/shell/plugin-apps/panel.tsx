import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import { usePluginApps, usePluginAppPages } from "./provider"
import type { AppDisplayMode } from "./page-manager"
import type { DesktopPluginAppsAPI } from "@shared/plugin-app-types"
/** A measurement-only anchor. The frame remains attached to the root owner for its entire life. */
export function PluginAppAnchor({ pageId, visible, mode = "inline" }: { pageId: string; visible: boolean; mode?: AppDisplayMode }) {
  const ref = useRef<HTMLDivElement>(null), manager = usePluginApps()
  useLayoutEffect(() => {
    const anchor = Symbol("app-anchor")
    let handle = 0
    const position = () => {
      const rect = visible && ref.current?.isConnected ? ref.current.getBoundingClientRect() : null
      manager?.place(pageId, rect && rect.width > 0 && rect.height > 0 ? rect : null, anchor, mode)
      handle = requestAnimationFrame(position)
    }
    position()
    return () => { cancelAnimationFrame(handle); manager?.releaseAnchor(pageId, anchor) }
  }, [manager, pageId, visible, mode])
  return <div ref={ref} className="h-full w-full" aria-label="插件应用显示区域" />
}
export function PluginAppCatalog({ sessionId, onSelect }: { sessionId: string | null; onSelect(id: string): void }) {
  const manager = usePluginApps(), pages = usePluginAppPages()
  const rejected = pages.filter(page => page.menuRejection && page.controller.state.source.sessionId === sessionId)
  const [catalog, setCatalog] = useState<Awaited<ReturnType<DesktopPluginAppsAPI["catalog"]>>>()
  const [error, setError] = useState<string>(), [busy, setBusy] = useState(false)
  useEffect(() => {
    let current = true
    setCatalog(undefined); setError(undefined)
    if (manager && sessionId) void manager.api.catalog({ sessionId }).then(value => { if (current) setCatalog(value) }, () => { if (current) setError("暂时无法读取插件应用。") })
    return () => { current = false }
  }, [manager, sessionId])
  return <div className="flex h-full flex-col gap-3 overflow-auto p-4">
    <h2 className="text-sm font-medium">插件应用</h2>
    {!sessionId ? <p className="text-xs text-muted-foreground">请先打开一个会话。</p> : null}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {rejected.map(page => <div key={page.id} className="space-y-2 text-xs">
      <p>{page.title}：{page.menuRejection} 关闭会影响共享此应用的窗口。</p>
      <Button variant="ghost" disabled={busy} onClick={() => {
        if (!manager) return
        setBusy(true)
        void manager.remove(page.id, true).catch(cause => setError(String(cause))).finally(() => setBusy(false))
      }}>关闭应用并释放名额</Button>
    </div>)}
    {catalog?.backends.flatMap(backend => backend.surfaces.map(surface => <Button key={`${backend.pluginId}:${surface.id}`}
      variant="ghost" disabled={busy} className="justify-start" onClick={() => {
        if (!manager || !sessionId) return
        setBusy(true)
        void manager.open(sessionId, backend.pluginId, surface.id, surface.title).then(page => onSelect(page.id), cause => setError(String(cause))).finally(() => setBusy(false))
      }}>{surface.title}</Button>))}
    {catalog && !catalog.backends.some(backend => backend.surfaces.length) && <p className="text-xs text-muted-foreground">此会话没有可打开的插件应用。</p>}
  </div>
}
