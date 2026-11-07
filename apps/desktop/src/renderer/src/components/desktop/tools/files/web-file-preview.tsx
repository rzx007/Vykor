import { useState } from "react"
import { BrowserTool, type BrowserToolTab } from "../browser/browser-tool"
import { displayBrowserUrl, toLocalFileUrl } from "../browser/browser-navigation"
import { NEW_CONVERSATION_SCOPE } from "@renderer/stores/desktop-session/composer-draft-state"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"

/** Use the isolated browser for HTML and SVG, including their relative assets. */
export function WebFilePreview({
  scopeId,
  preview,
  projectPath,
  visible,
}: {
  scopeId: string
  preview: WorkspaceReadFileResult
  projectPath?: string | null
  visible: boolean
}) {
  const [tab, setTab] = useState<BrowserToolTab>(() => {
    const url = new URL(toLocalFileUrl(projectPath ?? "", preview.path)).href
    return {
      id: `web-file-preview-${crypto.randomUUID()}`,
      title: preview.name,
      url,
      input: displayBrowserUrl(url),
      loading: true,
      canGoBack: false,
      canGoForward: false,
    }
  })

  return (
    <div className="relative h-full min-h-0 min-w-0">
      <BrowserTool
        tab={tab}
        composerScope={scopeId.startsWith("session:") ? scopeId : NEW_CONVERSATION_SCOPE}
        active={visible}
        visible={visible}
        onUpdate={(patch) => setTab((current) => ({ ...current, ...patch }))}
      />
    </div>
  )
}
