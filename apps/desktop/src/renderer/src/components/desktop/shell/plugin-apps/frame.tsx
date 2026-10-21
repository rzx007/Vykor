import { useEffect, useRef, useSyncExternalStore } from "react"
import type { ResidentAppPage } from "./page-manager"
import { PluginAppTransport } from "./transport"
export function PluginAppFrame({ page }: { page: ResidentAppPage }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const lifetime = useRef(0)
  const state = useSyncExternalStore(page.controller.subscribe, page.controller.snapshot)
  useEffect(() => {
    if (!frame.current) return
    const generation = ++lifetime.current
    const transport = page.transport ?? new PluginAppTransport(frame.current, page.controller, page)
    if (!page.transport) {
      page.transport = transport
      if (page.initial) { transport.queueInitial(page.initial); delete page.initial }
      for (const result of page.results?.values() ?? []) transport.queueToolResult(result)
      page.results?.clear()
      void transport.connect().catch(error => { page.controller.suspend(); page.onInitializationError?.(error) })
    }
    const appearance = new MutationObserver(() => transport.updateContext())
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-reduced-motion"] })
    return () => { appearance.disconnect(); queueMicrotask(() => { if (lifetime.current === generation) void transport.close() }) }
  }, [page])
  const notice = !state.online ? "连接已断开，页面草稿仍在。恢复连接前不能执行操作。"
    : state.availability.reason === "action-unconfirmed" ? "上次操作结果待核实。已暂停新操作，草稿仍在。"
    : state.app.status !== "open" ? "应用已关闭或授权已撤销，草稿仍在。"
    : !state.availability.canInvokeTools ? "只读页面，当前不能执行工具操作。" : undefined
  return <div ref={node => { page.element = node ?? undefined }} data-plugin-app-mount={page.id}
    className="fixed z-20 flex flex-col overflow-hidden bg-background"
    style={{ visibility: "hidden", pointerEvents: "none", width: 1, height: 1 }} aria-hidden="true" inert>
    {notice && <p role="status" className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground">{notice}</p>}
    <iframe ref={frame} title={page.title} className="min-h-0 w-full flex-1 border-0" sandbox="allow-scripts"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'" />
  </div>
}
