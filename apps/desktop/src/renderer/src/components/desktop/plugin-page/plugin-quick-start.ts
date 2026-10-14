import type { DesktopPluginInfo } from "@shared/plugin-types"
import type { DesktopSessionState } from "@renderer/stores/desktop-session/types"
import { composerDocument } from "@renderer/stores/desktop-session/composer-document"
import {
  NEW_CONVERSATION_SCOPE,
  selectDraftDocument,
} from "@renderer/stores/desktop-session/composer-draft-state"

type QuickStartState = Pick<
  DesktopSessionState,
  "startNewConversation" | "setGoalMode" | "setComposerDraftDocument" | "composerDraftsByScope"
>

export async function preparePluginConversation(
  plugin: DesktopPluginInfo,
  prompt: string,
  getState: () => QuickStartState
): Promise<void> {
  if (
    !plugin.enabled ||
    plugin.installation !== "installed" ||
    plugin.permissions.missing.length > 0 ||
    plugin.runtimeStatus.state === "failed"
  ) {
    throw new Error("请先在管理中启用插件，并处理缺失权限或加载问题。")
  }
  await getState().startNewConversation()
  getState().setGoalMode(NEW_CONVERSATION_SCOPE, false)
  const state = getState()
  const current = selectDraftDocument(state, NEW_CONVERSATION_SCOPE)
  // Keep unfinished text and attachments; replace only the previous plugin selection.
  const remaining = current.items.filter((item) => item.type !== "capability")
  const hasText = remaining.some((item) => item.type === "text" && item.text.trim())
  state.setComposerDraftDocument(
    NEW_CONVERSATION_SCOPE,
    composerDocument([
      {
        type: "capability",
        kind: "plugin",
        pluginId: plugin.identity.id,
        displayName: plugin.identity.displayName ?? plugin.identity.name,
      },
      { type: "text", text: " " },
      ...remaining,
      ...(prompt ? [{ type: "text" as const, text: `${hasText ? "\n\n" : ""}${prompt}` }] : []),
    ])
  )
}
