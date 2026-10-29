import {
  createContext,
  createElement,
  memo,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type ComponentProps,
} from "react"
import { Block, type BlockProps, type ExtraProps } from "streamdown"
import { TextAnimationBlock, type TextAnimationPool } from "./streaming-text-animation"

const AnimationContext = createContext<{
  pool: TextAnimationPool
  enabled: boolean
  corrected: boolean
} | null>(null)
const BlockContext = createContext<TextAnimationBlock | null>(null)

export function StreamingMarkdownAnimation({
  children,
  pool,
  enabled,
  corrected,
}: {
  children: ReactNode
  pool: TextAnimationPool
  enabled: boolean
  corrected: boolean
}) {
  const context = useMemo(() => ({ pool, enabled, corrected }), [pool, enabled, corrected])
  return <AnimationContext value={context}>{children}</AnimationContext>
}

function TextLeaf({ text, offset }: { text: string; offset: number }) {
  const block = useContext(BlockContext)!
  const enabled = useContext(AnimationContext)!.enabled
  useSyncExternalStore(block.subscribe, block.getSnapshot, block.getSnapshot)
  if (!enabled || !block.characters.length) return <>{text}</>
  const parts: ReactNode[] = []
  let cursor = 0
  for (const character of block.characters) {
    if (
      character.end <= offset ||
      character.start >= offset + text.length ||
      !block.pool.has(character.id)
    )
      continue
    const start = Math.max(0, character.start - offset)
    const end = Math.min(text.length, character.end - offset)
    if (start > cursor) parts.push(text.slice(cursor, start))
    parts.push(
      <span
        key={character.id}
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
  const isTail = props.index === context.pool.lastBlockIndex
  const [wasTail, setWasTail] = useState(isTail)
  if (isTail && !wasTail) setWasTail(true)
  // 打开长历史时，已稳定的块直接使用原组件，不创建动画状态或独立解析插件。
  if (!wasTail && !isTail) return <Block {...props} />
  return <AnimatedBlock {...props} />
})

function AnimatedBlock(props: BlockProps) {
  const context = useContext(AnimationContext)!
  const [model] = useState(() => new TextAnimationBlock(context.pool))
  model.configure(
    context.enabled,
    props.index >= (context.pool.initialBlocks ?? 0) &&
      props.index === context.pool.lastBlockIndex &&
      !context.corrected
  )
  const plugins = useMemo(
    () => [...(props.rehypePlugins ?? []), model.plugin],
    [props.rehypePlugins, model]
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
    model.commit()
  })
  useLayoutEffect(() => () => model.dispose(), [model])
  return (
    <BlockContext value={model}>
      <Block {...props} animatePlugin={null} components={components} rehypePlugins={plugins} />
    </BlockContext>
  )
}
