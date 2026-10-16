import {
  Fragment,
  memo,
  startTransition,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react"
import { useWorkerPool } from "@pierre/diffs/react"
import type { ThemedFileResult } from "@pierre/diffs"
import { useAppearance } from "@renderer/components/appearance/appearance-provider"
import {
  createStreamingCodeHighlighter,
  type CodeHighlightSnapshot,
} from "@renderer/lib/streaming-code-highlighter"

type Node = ThemedFileResult["code"][number]
const tokenColorPatterns = {
  light: /--diffs-token-light:([^;]+)/,
  dark: /--diffs-token-dark:([^;]+)/,
}
function token(node: Node, theme: "light" | "dark", key: number): ReactNode {
  if (node.type === "text") return node.value
  if (node.type !== "element") return null
  const style = String(node.properties.style ?? "")
  const color = style.match(tokenColorPatterns[theme])?.[1]
  return (
    <span key={key} style={color ? { color } : undefined}>
      {node.children.map((child, index) => token(child, theme, index))}
    </span>
  )
}
function nodeText(node: Node): string {
  return node.type === "text"
    ? node.value
    : node.type === "element"
      ? node.children.map(nodeText).join("")
      : ""
}
interface HighlightedPrefixProps {
  snapshot: CodeHighlightSnapshot
  theme: "light" | "dark"
}
function HighlightedPrefixContent({ snapshot, theme }: HighlightedPrefixProps) {
  // 使用原始换行符，空行和末尾换行不能被高亮 AST 的占位节点改写。
  const lines = snapshot.file.contents.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []
  return lines.map((line, index) => {
    const body = line.replace(/[\r\n]+$/, "")
    const ending = line.slice(body.length)
    const node = snapshot.result.code[index]
    const content =
      node && nodeText(node) === body && node.type === "element"
        ? node.children.map((child, childIndex) => token(child, theme, childIndex))
        : body
    return (
      <Fragment key={index}>
        {content}
        {ending}
      </Fragment>
    )
  })
}
const HighlightedPrefix = memo(HighlightedPrefixContent)

export function BackgroundCode({
  code,
  language,
  streaming,
  ...props
}: { code: string; language: string; streaming: boolean } & ComponentProps<"pre">) {
  const pool = useWorkerPool()
  const { resolvedTheme } = useAppearance()
  const [snapshot, setSnapshot] = useState<CodeHighlightSnapshot>()
  const session = useRef<ReturnType<typeof createStreamingCodeHighlighter> | undefined>(undefined)
  useEffect(() => {
    if (!pool) return
    const highlighter = createStreamingCodeHighlighter(pool, (next) =>
      startTransition(() => setSnapshot(next))
    )
    session.current = highlighter
    return () => {
      highlighter.dispose()
      session.current = undefined
    }
  }, [pool])
  useEffect(() => {
    session.current?.update(code, language, streaming)
  }, [pool, code, language, streaming])
  const reusable =
    snapshot && snapshot.file.lang === language && code.startsWith(snapshot.file.contents)
  if (snapshot && !reusable) setSnapshot(undefined)
  // 修正或截断立即退回完整源码，异步颜色绝不能覆盖当前文本。
  return (
    <pre {...props}>
      <code>
        {reusable ? (
          <>
            <HighlightedPrefix snapshot={snapshot} theme={resolvedTheme} />
            {code.slice(snapshot.file.contents.length)}
          </>
        ) : (
          code
        )}
      </code>
    </pre>
  )
}
