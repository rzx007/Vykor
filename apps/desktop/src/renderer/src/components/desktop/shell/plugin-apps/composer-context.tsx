import { useSyncExternalStore } from "react"
import { X } from "lucide-react"
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentTitle } from "@renderer/components/ui/attachment"
import { pluginAppModelContexts } from "./plugin-app-model-context"
export function PluginAppComposerContext({ sessionId, readOnly }: { sessionId: string | null; readOnly: boolean }) {
  const entries = useSyncExternalStore(pluginAppModelContexts.subscribe, pluginAppModelContexts.snapshot).filter(entry => entry.source.sessionId === sessionId)
  if (!entries.length) return null
  return <AttachmentGroup aria-label="插件上下文" className="px-3 pt-2">
    {entries.map(entry => <Attachment key={entry.id} size="sm">
      <AttachmentContent>
        <AttachmentTitle>{entry.pluginId}</AttachmentTitle>
        <AttachmentDescription className="max-w-72 truncate" title={`${entry.text}\n${JSON.stringify(entry.data)}`}>{entry.text || JSON.stringify(entry.data)}</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions><AttachmentAction type="button" shape="circle" disabled={readOnly} aria-label={`移除 ${entry.pluginId} 上下文`} title="移除上下文" onClick={() => pluginAppModelContexts.remove(entry.id)}><X /></AttachmentAction></AttachmentActions>
    </Attachment>)}
  </AttachmentGroup>
}
