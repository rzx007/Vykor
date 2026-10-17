import { memo, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { Streamdown } from "streamdown"
import { createStreamdownComponents } from "./streamdown-components"
import { streamdownPlugins } from "./streamdown-plugins"
import { createIncrementalMarkdownParser } from "./incremental-markdown"
import { longMarkdownCharacters, useStreamingMarkdown } from "./use-streaming-markdown"
import { CodeFenceActivityContext, createCodeFenceActivity } from "./code-fence-activity"

const streamingTextAnimation = {
  animation: "fadeIn",
  duration: 150,
  easing: "ease-out",
  sep: "char",
  stagger: 0,
} as const

export const AssistantMarkdown = memo(function AssistantMarkdown({
  text,
  phase,
  streaming,
  animateInitialText,
  onOpenFile,
}: {
  text: string
  phase?: "commentary" | "final_answer"
  streaming: boolean
  animateInitialText: boolean
  onOpenFile: (path: string, line?: number) => void
}): React.JSX.Element {
  const openFileRef = useRef(onOpenFile)
  useLayoutEffect(() => {
    openFileRef.current = onOpenFile
  }, [onOpenFile])
  // Streamdown 会据此创建代码渲染组件。回调更新不能重建组件、丢掉颜色并重排后台任务。
  const [components] = useState(() =>
    createStreamdownComponents({
      onOpenFile: (path, line) => openFileRef.current(path, line),
      codeBlockVariant: "conversation",
    })
  )
  const [codeActivity] = useState(createCodeFenceActivity)
  const liveCode = useSyncExternalStore(
    codeActivity.subscribe,
    codeActivity.getSnapshot,
    codeActivity.getSnapshot
  )
  const rendered = useStreamingMarkdown(text, streaming, liveCode)
  const [parseBlocks] = useState(createIncrementalMarkdownParser)
  // 让 Streamdown 记住已有文字，重新打开进行中的回复时不重播历史。
  const [initialText] = useState(() => (animateInitialText ? "" : text))
  // streaming/static 是两棵不同的组件树。完成或恢复时保留已经显示的块和后台颜色。
  const [hasStreamed, setHasStreamed] = useState(streaming)
  if (streaming && !hasStreamed) setHasStreamed(true)
  const animated = streaming && rendered.text.length <= longMarkdownCharacters
  // 可能含引用定义/脚注时保守沿用全文路径，避免自行识别嵌套、跨行等 Markdown 语法。
  // 只在完成时检查，流式 token 不重复扫描全文。
  const fullDocument = !streaming && hasStreamed && rendered.text.includes("]:")

  return (
    <div
      className="assistant-markdown min-w-0"
      data-phase={phase}
      data-stream-initial={streaming && rendered.text === initialText ? "true" : undefined}
    >
      <CodeFenceActivityContext value={codeActivity}>
        <Streamdown
          key={rendered.revision}
          className="desktop-streamdown space-y-0"
          animated={animated ? streamingTextAnimation : false}
          isAnimating={streaming}
          mode={hasStreamed && !fullDocument ? "streaming" : "static"}
          controls
          lineNumbers={false}
          parseIncompleteMarkdown={streaming}
          parseMarkdownIntoBlocksFn={parseBlocks}
          plugins={streamdownPlugins}
          components={components}
        >
          {rendered.text}
        </Streamdown>
      </CodeFenceActivityContext>
    </div>
  )
})
