import type { EditorOptions } from "@pierre/diffs/edit"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { composerDocument } from "@renderer/stores/desktop-session/composer-document"
import {
  NEW_CONVERSATION_SCOPE,
  selectDraftDocument,
  sessionComposerScope,
} from "@renderer/stores/desktop-session/composer-draft-state"
import { toast } from "@renderer/lib/toast"
import { codeSelectionText, type CodeSelectionContext } from "./code-selection-context"

function focusComposer(): void {
  document.querySelector<HTMLElement>("#message-composer, #new-conversation-composer")?.focus()
}

export function addCodeSelectionToComposer(scopeId: string, selection: CodeSelectionContext): void {
  addTextToComposer(scopeId, codeSelectionText(selection))
}

export function addTextToComposer(scopeId: string, text: string): void {
  const state = useDesktopSessionStore.getState()
  const scope = state.activeSessionId
    ? sessionComposerScope(state.activeSessionId)
    : NEW_CONVERSATION_SCOPE
  if (state.activeSessionId ? scopeId !== scope : !scopeId.startsWith("draft:"))
    throw new Error("当前聊天已变化，请重新选择代码。")
  const current = selectDraftDocument(state, scope)
  state.setComposerDraftDocument(
    scope,
    composerDocument([...current.items, { type: "text", text }])
  )
  focusComposer()
  toast.info("已添加到输入框", "已附上文件位置和选中代码。")
}

type RenderSelectionAction = NonNullable<
  EditorOptions<"file", undefined, undefined>["renderSelectionAction"]
>

export function createCodeSelectionAction(source: {
  scopeId: string
  projectPath?: string | null
  path: string
  language: string
  isUnsaved: () => boolean
}): RenderSelectionAction {
  return (context) => {
    const root = document.createElement("div")
    root.setAttribute("role", "toolbar")
    root.setAttribute("aria-label", "选中代码操作")
    root.className = "code-selection-actions"
    const metadata = (): CodeSelectionContext => {
      const { start, end } = context.selection
      return {
        projectPath: source.projectPath,
        path: source.path,
        language: source.language,
        startLine: start.line + 1,
        startColumn: start.character + 1,
        endLine: end.line + 1,
        endColumn: end.character + 1,
        text: context.getSelectionText(),
        unsaved: source.isUnsaved(),
      }
    }
    const action = (label: string, run: () => void | Promise<void>, afterClose?: () => void) => {
      const button = document.createElement("button")
      button.type = "button"
      button.textContent = label
      button.addEventListener("mousedown", (event) => event.preventDefault())
      button.addEventListener("click", () => {
        button.disabled = true
        void Promise.resolve()
          .then(run)
          .then(() => {
            context.close()
            afterClose?.()
          })
          .catch((error: unknown) => {
            toast.error(error instanceof Error ? error.message : "操作失败，请重试。")
          })
          .finally(() => {
            button.disabled = false
          })
      })
      root.append(button)
    }
    // Pierre 的 close 会聚焦代码；关闭后再把焦点交回聊天输入框。
    action(
      "添加到输入框",
      () => addCodeSelectionToComposer(source.scopeId, metadata()),
      focusComposer
    )
    action("复制代码", () => window.desktop.clipboard.writeText(context.getSelectionText()))
    action("添加到便签", async () => {
      await window.desktop.notes.create({ content: codeSelectionText(metadata()) })
      toast.success("已添加到便签")
    })
    return root
  }
}
