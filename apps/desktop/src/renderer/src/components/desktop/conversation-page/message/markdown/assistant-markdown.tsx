import {
  memo,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { MotionConfigContext, useReducedMotion } from "motion/react"
import { Streamdown } from "streamdown"
import { StreamingResponse } from "@renderer/components/agents/streaming-response"
import { useStreamingResponseText } from "@renderer/components/agents/use-streaming-response-text"
import { createStreamdownComponents } from "./streamdown-components"
import { streamdownPlugins, streamdownRehypePlugins } from "./streamdown-plugins"
import { createIncrementalMarkdownParser } from "./incremental-markdown"
import { longMarkdownCharacters, useStreamingMarkdown } from "./use-streaming-markdown"
import { CodeFenceActivityContext, createCodeFenceActivity } from "../activity/code-fence-activity"

// 行首（最多缩进三个空格）的三反引号或三波浪号表示代码围栏。
const codeFence = /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})/

export const AssistantMarkdown = memo(function AssistantMarkdown({
  text,
  phase,
  streaming,
  animateInitialText,
  onOpenFile,
  fileLinkMode = "open",
}: {
  text: string
  phase?: "commentary" | "final_answer"
  streaming: boolean
  animateInitialText: boolean
  onOpenFile: (path: string, line?: number) => void
  fileLinkMode?: "open" | "text"
}): React.JSX.Element {
  const systemReducedMotion = useReducedMotion()
  const { reducedMotion } = useContext(MotionConfigContext)
  const reduce =
    reducedMotion === "always" || (reducedMotion === "user" && Boolean(systemReducedMotion))
  const openFileRef = useRef(onOpenFile)
  useLayoutEffect(() => {
    openFileRef.current = onOpenFile
  }, [onOpenFile])
  // Streamdown 会据此创建代码渲染组件。回调更新不能重建组件、丢掉颜色并重排后台任务。
  const components = useMemo(
    () =>
      createStreamdownComponents({
        onOpenFile: (path, line) => openFileRef.current(path, line),
        codeBlockVariant: "conversation",
        fileLinkMode,
      }),
    [fileLinkMode]
  )
  const [codeActivity] = useState(createCodeFenceActivity)
  const liveCode = useSyncExternalStore(
    codeActivity.subscribe,
    codeActivity.getSnapshot,
    codeActivity.getSnapshot
  )
  const [hasStreamed, setHasStreamed] = useState(streaming)
  if (streaming && !hasStreamed) setHasStreamed(true)
  const revealed = useStreamingResponseText(text, {
    enabled:
      (streaming || hasStreamed) &&
      !reduce &&
      !liveCode &&
      text.length <= longMarkdownCharacters &&
      !codeFence.test(text),
    animateInitialText,
  })
  const rendering = streaming || revealed.pending
  const rendered = useStreamingMarkdown(revealed.text, rendering, liveCode)
  const [parseBlocks] = useState(createIncrementalMarkdownParser)
  // 让 Streamdown 记住已有文字，重新打开进行中的回复时不重播历史。
  const [initialText] = useState(() => (animateInitialText ? "" : text))
  // streaming/static 是两棵不同的组件树。完成或恢复时保留已经显示的块和后台颜色。
  // 可能含引用定义/脚注时保守沿用全文路径，避免自行识别嵌套、跨行等 Markdown 语法。
  // 只在完成时检查，流式 token 不重复扫描全文。
  const fullDocument = !rendering && hasStreamed && rendered.text.includes("]:")
  // streaming/static 是两棵不同的组件树。完成后只有正文含代码块时才沿用 streaming 树，
  // 这样既保留已高亮的代码块身份（避免重新高亮），又让纯文本回复切回 static 树
  // ——否则相同文字的收尾渲染不会提交，字符动画的 <span> 包裹会残留在正式回复里。
  const keepStreamingTree =
    hasStreamed && !fullDocument && (rendering || codeFence.test(rendered.text))

  return (
    <div
      className="assistant-markdown min-w-0"
      data-phase={phase}
      data-stream-initial={streaming && rendered.text === initialText ? "true" : undefined}
    >
      <StreamingResponse
        status={rendering ? "streaming" : "complete"}
        announce={false}
        showActions={false}
        unstyled
      >
        <CodeFenceActivityContext value={codeActivity}>
          <Streamdown
            key={rendered.revision}
            className="desktop-streamdown space-y-0"
            animated={false}
            isAnimating={rendering}
            mode={keepStreamingTree ? "streaming" : "static"}
            controls
            lineNumbers={false}
            parseIncompleteMarkdown={rendering}
            parseMarkdownIntoBlocksFn={parseBlocks}
            plugins={streamdownPlugins}
            rehypePlugins={streamdownRehypePlugins}
            components={components}
          >
            {rendered.text}
          </Streamdown>
        </CodeFenceActivityContext>
      </StreamingResponse>
    </div>
  )
})
