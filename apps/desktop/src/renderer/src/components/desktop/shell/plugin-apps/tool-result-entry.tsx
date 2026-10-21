import { useState } from "react"
import type { DesktopSessionPart } from "@shared/session-types"
import { Button } from "@renderer/components/ui/button"
import { usePluginApps } from "./provider"
import { PluginAppAnchor } from "./panel"
/** A successful committed Part offers an explicit open action; replay never opens a frame. */
export function PluginAppToolResultEntry({ part }: { part: DesktopSessionPart }) {
  const manager = usePluginApps(), [pageId, setPageId] = useState<string>(), [error, setError] = useState<string>()
  const [placement, setPlacement] = useState(0)
  if (!manager || part.type !== "tool" || part.status !== "completed" || part.isError || !part.metadata.pluginAppSource) return null
  return <div>
    <Button variant="ghost" onClick={() => { void manager.openToolResult(part.sessionId, part.id).then(page => { setPageId(page.id); setPlacement(value => value + 1); setError(undefined) }, () => setError("应用来源不可用，请检查插件状态。")) }}>打开工具应用</Button>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {pageId && <div className="h-96"><PluginAppAnchor key={placement} pageId={pageId} visible /></div>}
  </div>
}
