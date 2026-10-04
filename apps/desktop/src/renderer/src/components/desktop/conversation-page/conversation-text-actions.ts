import type { MouseEvent } from "react"
import { toast } from "@renderer/lib/toast"

function endpointElement(node: Node | null): Element | null {
  return node instanceof Element ? node : (node?.parentElement ?? null)
}
function isInside(node: Node | null, viewport: HTMLElement): boolean {
  let element = endpointElement(node)
  while (element) {
    if (element.closest('textarea,input,[contenteditable]:not([contenteditable="false"])'))
      return false
    if (viewport.contains(element)) return true
    const root = element.getRootNode()
    element = root instanceof ShadowRoot ? root.host : null
  }
  return false
}

export function readConversationSelection(
  viewport: HTMLElement
): { text: string; range: Range } | null {
  const selected = window.getSelection()
  if (
    !selected?.rangeCount ||
    !selected.toString() ||
    !isInside(selected.anchorNode, viewport) ||
    !isInside(selected.focusNode, viewport)
  )
    return null
  return { text: selected.toString(), range: selected.getRangeAt(0).cloneRange() }
}

export async function copyConversationText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    await window.desktop.clipboard.writeText(text)
    toast.success("已复制")
    return true
  } catch {
    toast.error("复制失败，请重试")
    return false
  }
}

export async function openConversationTextMenu(event: MouseEvent<HTMLElement>): Promise<void> {
  if (
    endpointElement(event.target as Node)?.closest(
      'textarea,input,[contenteditable]:not([contenteditable="false"])'
    )
  )
    return
  event.preventDefault()
  event.stopPropagation()
  const viewport = event.currentTarget
  const selectedText = readConversationSelection(viewport)?.text ?? ""
  try {
    const action = await window.desktop.clipboard.showTextMenu({
      editable: false,
      hasSelection: !!selectedText,
    })
    if (!viewport.isConnected) return
    if (action === "copy") await copyConversationText(selectedText)
    if (action === "select-all") {
      const range = document.createRange()
      range.selectNodeContents(viewport)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
  } catch {
    toast.error("菜单打开失败，请重试")
  }
}

export async function openComposerTextMenu(
  event: MouseEvent<HTMLElement>,
  disabled: boolean
): Promise<void> {
  event.preventDefault()
  event.stopPropagation()
  const editor = event.currentTarget
  if (disabled || editor.getAttribute("contenteditable") === "false") return
  const selection = window.getSelection()
  const hasSelection =
    !!selection?.toString() &&
    editor.contains(selection.anchorNode) &&
    editor.contains(selection.focusNode)
  try {
    await window.desktop.clipboard.showTextMenu({ editable: true, hasSelection })
  } catch {
    toast.error("菜单打开失败，请重试")
  }
}
