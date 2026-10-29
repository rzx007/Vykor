import {
  createContext,
  createElement,
  memo,
  useContext,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState,
  type CSSProperties,
  type ReactNode,
  type ComponentProps,
} from "react"
import { Block, type BlockProps, type ExtraProps } from "streamdown"
import { TextAnimationBlock } from "./streaming-text-animation"

export type StreamingAnimationState = { lastBlockIndex: number; initialBlocks: number | null }

const AnimationContext = createContext<{
  blocks: StreamingAnimationState
  enabled: boolean
  corrected: boolean
} | null>(null)
const BlockContext = createContext<{ model: TextAnimationBlock; revision: number } | null>(null)

export function StreamingMarkdownAnimation({
  children,
  blocks,
  enabled,
  corrected,
}: {
  children: ReactNode
  blocks: StreamingAnimationState
  enabled: boolean
  corrected: boolean
}) {
  const context = useMemo(() => ({ blocks, enabled, corrected }), [blocks, enabled, corrected])
  return <AnimationContext value={context}>{children}</AnimationContext>
}

function TextLeaf({ text, offset }: { text: string; offset: number }) {
  const { model: block } = useContext(BlockContext)!
  const enabled = useContext(AnimationContext)!.enabled
  if (!enabled || !block.characters.length) return <>{text}</>
  const parts: ReactNode[] = []
  let cursor = 0
  for (const character of block.characters) {
    if (character.end <= offset) continue
    if (character.start >= offset + text.length) break
    const start = Math.max(0, character.start - offset)
    const end = Math.min(text.length, character.end - offset)
    if (start > cursor) parts.push(text.slice(cursor, start))
    parts.push(
      <span
        key={character.start}
        data-sd-animate=""
        style={
          {
            "--sd-animation": "sd-fadeIn",
            "--sd-duration": "150ms",
            "--sd-easing": "ease-out",
          } as CSSProperties
        }
      >
        {text.slice(start, end)}
      </span>
    )
    cursor = end
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

export const StreamingMarkdownBlock = memo(function StreamingMarkdownBlock(props: BlockProps) {
  const context = useContext(AnimationContext)!
  const isTail = props.index === context.blocks.lastBlockIndex
  const [wasTail, setWasTail] = useState(isTail)
  if (isTail && !wasTail) setWasTail(true)
  // 打开长历史时，已稳定的块直接使用原组件，不创建动画状态或独立解析插件。
  if (!wasTail && !isTail) return <Block {...props} />
  return <AnimatedBlock {...props} />
})

function AnimatedBlock(props: BlockProps) {
  const context = useContext(AnimationContext)!
  const [model] = useState(() => new TextAnimationBlock())
  const [revision, refresh] = useReducer((value: number) => value + 1, 0)
  const leafState = useMemo(() => ({ model, revision }), [model, revision])
  model.configure(
    context.enabled,
    props.index >= (context.blocks.initialBlocks ?? 0) &&
      props.index === context.blocks.lastBlockIndex &&
      !context.corrected
  )
  const plugins = useMemo(
    () => (context.enabled ? [...(props.rehypePlugins ?? []), model.plugin] : props.rehypePlugins),
    [props.rehypePlugins, model, context.enabled]
  )
  const components = useMemo(() => {
    const Original = props.components?.span ?? "span"
    function AnimationSpan(
      spanProps: ComponentProps<"span"> & ExtraProps & { "data-streaming-text-offset"?: number }
    ) {
      const offset = spanProps["data-streaming-text-offset"]
      if (offset !== undefined)
        return <TextLeaf text={String(spanProps.children ?? "")} offset={Number(offset)} />
      const nativeProps = { ...spanProps }
      delete nativeProps.node
      return createElement<ComponentProps<"span"> & ExtraProps>(Original, nativeProps)
    }
    return { ...props.components, span: AnimationSpan }
  }, [props.components])
  useLayoutEffect(() => {
    model.commit(refresh)
  })
  useLayoutEffect(() => () => model.dispose(), [model])
  return (
    <BlockContext value={leafState}>
      <Block {...props} animatePlugin={null} components={components} rehypePlugins={plugins} />
    </BlockContext>
  )
}
