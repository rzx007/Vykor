import { useSyncExternalStore } from "react"
import { X } from "lucide-react"
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentTitle } from "@renderer/components/ui/attachment"
import { pluginAppModelContexts } from "./plugin-app-model-context"
import { usePluginAppPages } from "./provider"
export function PluginAppComposerContext({ sessionId, readOnly }: { sessionId: string | null; readOnly: boolean }) {
  const pages = usePluginAppPages()
  const entries = useSyncExternalStore(pluginAppModelContexts.subscribe, pluginAppModelContexts.snapshot).filter(entry => entry.source.sessionId === sessionId)
  if (!entries.length) return null
  return <AttachmentGroup aria-label="插件上下文" className="px-3 pt-2">
    {entries.map(entry => <Attachment key={entry.id} size="sm">
      <AttachmentContent>
        <AttachmentTitle>{pages.find(page => page.controller.state.source.appId === entry.source.appId && page.controller.state.source.sessionId === entry.source.sessionId)?.title ?? "应用引用"}</AttachmentTitle>
        <AttachmentDescription className="max-w-72 truncate">{entry.text || "已引用应用中选择的内容"}</AttachmentDescription>
        <details className="mt-1 max-w-80 text-xs"><summary className="cursor-pointer text-muted-foreground">查看引用内容</summary><div className="max-h-48 overflow-auto whitespace-pre-wrap break-all pt-2">{entry.text}<pre className="mt-2 whitespace-pre-wrap text-xs">{JSON.stringify(entry.data, null, 2)}</pre></div></details>
      </AttachmentContent>
      <AttachmentActions><AttachmentAction type="button" shape="circle" disabled={readOnly} aria-label={`移除 ${entry.pluginId} 上下文`} title="移除上下文" onClick={() => pluginAppModelContexts.remove(entry.id)}><X /></AttachmentAction></AttachmentActions>
    </Attachment>)}
  </AttachmentGroup>
}
