import { memo, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { Streamdown } from "streamdown"
import { useStreamingTextAnimation } from "@renderer/components/appearance/appearance-provider"
import { createStreamdownComponents } from "./streamdown-components"
import { streamdownPlugins, streamdownRehypePlugins } from "./streamdown-plugins"
import { createIncrementalMarkdownParser } from "./incremental-markdown"
import { useStreamingMarkdown } from "./use-streaming-markdown"
import {
  StreamingMarkdownAnimation,
  StreamingMarkdownBlock,
  type StreamingAnimationState,
} from "./streaming-markdown-block"
import { CodeFenceActivityContext, createCodeFenceActivity } from "../activity/code-fence-activity"

// 行首（最多缩进三个空格）的三反引号或三波浪号表示代码围栏。
const codeFence = /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})/

export const AssistantMarkdown = memo(function AssistantMarkdown({
  text,
  searchMessageId,
  searchPartIdsJson,
  phase,
  streaming,
  animateInitialText,
  onOpenFile,
  fileLinkMode = "open",
  messageLinks = false,
}: {
  text: string
  searchMessageId?: string
  searchPartIdsJson?: string
  phase?: "commentary" | "final_answer"
  streaming: boolean
  animateInitialText: boolean
  onOpenFile: (path: string, line?: number) => void
  fileLinkMode?: "open" | "text"
  messageLinks?: boolean
}): React.JSX.Element {
  const textAnimationEnabled = useStreamingTextAnimation()
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
  const rendered = useStreamingMarkdown(text, streaming, liveCode)
  const [animationBlocks] = useState<StreamingAnimationState>(() => ({
    lastBlockIndex: -1,
    initialBlocks: null,
  }))
  const [parseBlocks] = useState(() => {
    const parse = createIncrementalMarkdownParser()
    return (source: string) => {
      const blocks = parse(source)
      animationBlocks.lastBlockIndex = blocks.length - 1
      animationBlocks.initialBlocks ??= animateInitialText ? 0 : blocks.length
      return blocks
    }
  })
  // 让 Streamdown 记住已有文字，重新打开进行中的回复时不重播历史。
  const [initialText] = useState(() => (animateInitialText ? "" : text))
  // streaming/static 是两棵不同的组件树。完成或恢复时保留已经显示的块和后台颜色。
  const [hasStreamed, setHasStreamed] = useState(streaming)
  if (streaming && !hasStreamed) setHasStreamed(true)
  // 可能含引用定义/脚注时保守沿用全文路径，避免自行识别嵌套、跨行等 Markdown 语法。
  // 只在完成时检查，流式 token 不重复扫描全文。
  const fullDocument = !streaming && hasStreamed && rendered.text.includes("]:")
  // streaming/static 是两棵不同的组件树。完成后只有正文含代码块时才沿用 streaming 树，
  // 这样既保留已高亮的代码块身份（避免重新高亮），又让纯文本回复切回 static 树
  // ——否则相同文字的收尾渲染不会提交，字符动画的 <span> 包裹会残留在正式回复里。
  const keepStreamingTree =
    hasStreamed && !fullDocument && (streaming || codeFence.test(rendered.text))

  return (
    <div
      data-chat-search-text
      data-chat-search-message={searchMessageId}
      data-chat-search-parts={searchPartIdsJson}
      className="assistant-markdown min-w-0"
      data-message-web-links={messageLinks ? "true" : undefined}
      data-phase={phase}
      data-stream-initial={streaming && rendered.text === initialText ? "true" : undefined}
    >
      <StreamingMarkdownAnimation
        blocks={animationBlocks}
        corrected={rendered.revision > 0}
        enabled={streaming && textAnimationEnabled}
      >
        <CodeFenceActivityContext value={codeActivity}>
          <Streamdown
            key={rendered.revision}
            className="desktop-streamdown space-y-0"
            animated={false}
            BlockComponent={StreamingMarkdownBlock}
            isAnimating={streaming}
            mode={keepStreamingTree ? "streaming" : "static"}
            controls
            lineNumbers={false}
            parseIncompleteMarkdown={streaming}
            parseMarkdownIntoBlocksFn={parseBlocks}
            plugins={streamdownPlugins}
            rehypePlugins={streamdownRehypePlugins}
            components={components}
          >
            {rendered.text}
          </Streamdown>
        </CodeFenceActivityContext>
      </StreamingMarkdownAnimation>
    </div>
  )
})
