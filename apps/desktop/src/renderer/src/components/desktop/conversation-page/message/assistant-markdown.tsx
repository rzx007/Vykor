import { memo, useMemo, useState } from "react"
import { Streamdown } from "streamdown"
import { createStreamdownComponents } from "./streamdown-components"
import { streamdownPlugins } from "./streamdown-plugins"
import { createIncrementalMarkdownParser } from "./incremental-markdown"
import { longMarkdownCharacters, useStreamingMarkdown } from "./use-streaming-markdown"

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
  const components = useMemo(
    () => createStreamdownComponents({ onOpenFile, codeBlockVariant: "conversation" }),
    [onOpenFile]
  )
  const rendered = useStreamingMarkdown(text, streaming)
  const [parseBlocks] = useState(createIncrementalMarkdownParser)
  // 让 Streamdown 记住已有文字，重新打开进行中的回复时不重播历史。
  const [initialText] = useState(() => (animateInitialText ? "" : text))
  const animated = streaming && rendered.text.length <= longMarkdownCharacters

  return (
    <div
      className="assistant-markdown min-w-0"
      data-phase={phase}
      data-stream-initial={streaming && rendered.text === initialText ? "true" : undefined}
    >
      <Streamdown
        key={rendered.revision}
        className="desktop-streamdown space-y-0"
        animated={animated ? streamingTextAnimation : false}
        isAnimating={streaming}
        mode={streaming ? "streaming" : "static"}
        controls
        lineNumbers={false}
        parseIncompleteMarkdown={streaming}
        parseMarkdownIntoBlocksFn={parseBlocks}
        plugins={streamdownPlugins}
        components={components}
      >
        {rendered.text}
      </Streamdown>
    </div>
  )
})
