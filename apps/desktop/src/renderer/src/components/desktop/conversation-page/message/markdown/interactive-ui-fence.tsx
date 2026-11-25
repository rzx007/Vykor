import { lazy, Suspense, type ReactNode } from "react"
import { INTERACTIVE_UI_REPLY_FORMAT } from "@vykor/protocol"

type MarkdownNode = {
  tagName?: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: MarkdownNode[]
}

export const closedInteractiveUiFences = new WeakSet<MarkdownNode>()
const fenceStart = "```" + INTERACTIVE_UI_REPLY_FORMAT

export function markClosedInteractiveUiFences() {
  return (tree: MarkdownNode, file: { value: string | Uint8Array }) => {
    const source = String(file.value)
    function visit(node: MarkdownNode) {
      if (node.tagName === "pre" && node.children?.[0]?.tagName === "code") {
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        const block = start === undefined || end === undefined ? "" : source.slice(start, end)
        const newline = block.indexOf("\n")
        if (newline >= 0 && block.slice(0, newline).trimEnd() === fenceStart && /\r?\n[ \t]*`{3,}[ \t]*$/.test(block)) {
          closedInteractiveUiFences.add(node.children[0])
        }
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}

const InteractiveUiBlock = lazy(() => import("../interactive-ui/interactive-ui-block").catch(() => ({
  default: ({ fallback }: { fallback: ReactNode }) => fallback,
})))

export function InteractiveUiFence({ code, fallback }: { code: string; fallback: ReactNode }) {
  return <Suspense fallback={fallback}><InteractiveUiBlock code={code} fallback={fallback} /></Suspense>
}
