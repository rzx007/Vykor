import type { ConversationSearchMatch } from "./conversation-find-model"

/** 使用浏览器 Range 标记文本，不插入标签、不改变复制原文或 Markdown 节点。 */
export function conversationMatchRanges(root: HTMLElement, tokens: readonly string[]): Range[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (
      node.parentElement?.closest("button, textarea, input, script, style, [contenteditable=true]")
    )
      continue
    nodes.push(node as Text)
  }
  const text = nodes
    .map((item) => item.data)
    .join("")
    .toLowerCase()
  const ranges: Range[] = []
  for (const token of tokens) {
    if (!token) continue
    let from = 0
    while ((from = text.indexOf(token, from)) !== -1) {
      const end = from + token.length
      let offset = 0
      const range = document.createRange()
      for (const textNode of nodes) {
        const next = offset + textNode.length
        if (from >= offset && from < next) range.setStart(textNode, from - offset)
        if (end > offset && end <= next) {
          range.setEnd(textNode, end - offset)
          break
        }
        offset = next
      }
      ranges.push(range)
      from = end
    }
  }
  return ranges
}

export function observeConversationMatch(
  viewport: HTMLElement,
  match: ConversationSearchMatch,
  name: string,
  recordAdjustment: () => void
) {
  let frame: number | undefined
  let positioned = false
  let selected: HTMLElement | undefined
  const clear = () => {
    selected?.removeAttribute("data-search-active")
    globalThis.CSS?.highlights?.delete(name)
  }
  const update = () => {
    frame = undefined
    clear()
    const textRoots = [...viewport.querySelectorAll<HTMLElement>("[data-chat-search-text]")].filter(
      (element) =>
        element.dataset.chatSearchMessage === match.messageId &&
        (JSON.parse(element.dataset.chatSearchParts ?? "[]") as string[]).some((id) =>
          match.partIds.includes(id)
        )
    )
    selected = textRoots[0]
    if (!selected) return
    selected.setAttribute("data-search-active", "true")
    const ranges = textRoots.flatMap((element) => conversationMatchRanges(element, match.tokens))
    if (typeof Highlight !== "undefined" && globalThis.CSS?.highlights)
      globalThis.CSS?.highlights.set(name, new Highlight(...ranges))
    if (positioned) return
    // 行先由虚拟列表挂载，再按渲染后的正文位置校准；不滚动整页或抢走输入焦点。
    const range = ranges[0]
    const rect =
      range && typeof range.getBoundingClientRect === "function"
        ? range.getBoundingClientRect()
        : selected.getBoundingClientRect()
    if (!rect.height) return
    const top = rect.top - viewport.getBoundingClientRect().top - 48
    if (Math.abs(top) > 1) {
      viewport.scrollTop += top
      recordAdjustment()
    }
    positioned = true
  }
  const schedule = () => {
    if (frame === undefined) frame = requestAnimationFrame(update)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(viewport, { childList: true, characterData: true, subtree: true })
  schedule()
  return () => {
    observer.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
    clear()
  }
}
