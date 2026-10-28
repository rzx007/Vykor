type MarkdownNode = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: MarkdownNode[]
}

// 异体字选择符与前面的汉字保持在一起，不拆开代理对或汉字字形。
const chineseRun =
  /(?:\p{Script=Han}[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]*|[\u3000-\u303F\uFF01-\uFF60\uFFE0-\uFFE6])+/gu
const literalElements = new Set(["pre", "code", "kbd", "samp", "math", "svg"])

function emphasizeChineseText(node: MarkdownNode): MarkdownNode[] {
  const text = node.value ?? ""
  const result: MarkdownNode[] = []
  let offset = 0
  for (const match of text.matchAll(chineseRun)) {
    if (match.index > offset) result.push({ type: "text", value: text.slice(offset, match.index) })
    result.push({
      type: "element",
      tagName: "span",
      properties: { dataCjkEmphasis: "true" },
      children: [{ type: "text", value: match[0] }],
    })
    offset = match.index + match[0].length
  }
  if (!result.length) return [node]
  if (offset < text.length) result.push({ type: "text", value: text.slice(offset) })
  return result
}

function visitEmphasis(node: MarkdownNode, emphasized = false): void {
  if (node.tagName && literalElements.has(node.tagName)) return
  if (!node.children) return
  const insideEmphasis = emphasized || node.tagName === "em"
  if (insideEmphasis) {
    node.children = node.children.flatMap((child) => {
      if (child.type === "text") return emphasizeChineseText(child)
      visitEmphasis(child, true)
      return [child]
    })
  } else {
    for (const child of node.children) visitEmphasis(child)
  }
}

// 只处理本次 Markdown 解析得到的显示节点；保留 em、链接和强强调，不改消息源码。
export function rehypeCjkEmphasis() {
  return (tree: MarkdownNode): void => visitEmphasis(tree)
}
