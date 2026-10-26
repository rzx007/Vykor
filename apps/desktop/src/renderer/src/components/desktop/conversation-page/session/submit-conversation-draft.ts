import { pluginAppModelContexts } from "../../shell/plugin-apps/plugin-app-model-context"
/** The page's submission gate is shared with its action-level regression tests. */
export async function submitConversationDraft(
  input: {
    sessionId: string | null
    content: string
    attachmentCount: number
    ready: boolean
    blocked: boolean
    goalMode: boolean
  },
  submit: () => Promise<void>
): Promise<void> {
  const hasContext =
    !input.goalMode && pluginAppModelContexts.forSession(input.sessionId).length > 0
  if (
    (!input.content.trim() && input.attachmentCount === 0 && !hasContext) ||
    !input.ready ||
    input.blocked
  )
    return
  await submit()
}
