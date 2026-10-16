import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import {
  defaultRangeExtractor,
  elementScroll,
  useVirtualizer,
  type Range,
  type Virtualizer,
} from "@tanstack/react-virtual"
import { useConversationScroller } from "../conversation-scroll-context"
import {
  conversationEndThresholdPx,
  type ConversationScrollState,
} from "../conversation-scroll-state"
import { TranscriptRowContext } from "./virtual-transcript-row"

export interface TranscriptRow {
  id: string
  messageIds: string[]
  estimateSize: number
  navigationId?: string
}

interface Props {
  rows: TranscriptRow[]
  renderRow(index: number): ReactNode
}

export function VirtualTranscript(props: Props) {
  const state = useConversationScroller()
  // 独立消息预览及静态渲染没有滚动视口，保持原有的完整内容输出。
  if (!state)
    return (
      <div className="flex min-w-0 flex-col gap-6 pt-7 pb-5">
        {props.rows.map((row, index) => (
          <div key={row.id} className="flex min-w-0 flex-col gap-6">
            {props.renderRow(index)}
          </div>
        ))}
      </div>
    )
  return <VirtualTranscriptViewport {...props} state={state} />
}

function VirtualTranscriptViewport({
  rows,
  renderRow,
  state,
}: Props & { state: ConversationScrollState }) {
  "use no memo" // TanStack 的可变实例自行更新 DOM，不能交给 React Compiler 缓存。
  const snapshot = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot)
  const initialized = useRef(false)
  const followFrame = useRef<number | null>(null)
  const getItemKey = useCallback((index: number) => rows[index]!.id, [rows])
  const estimateSize = useCallback((index: number) => rows[index]!.estimateSize, [rows])
  const indexByMessageId = useMemo(() => {
    const index = new Map<string, number>()
    rows.forEach((row, position) => {
      index.set(row.id, position)
      for (const id of row.messageIds) index.set(id, position)
    })
    return index
  }, [rows])
  const retainedIndexes = useMemo(
    () =>
      snapshot.retainedRowIds.flatMap((id) => {
        const index = indexByMessageId.get(id)
        return index === undefined ? [] : [index]
      }),
    [indexByMessageId, snapshot.retainedRowIds]
  )
  const rangeExtractor = useCallback(
    (range: Range) =>
      [...new Set([...defaultRangeExtractor(range), ...retainedIndexes])].sort(
        (left, right) => left - right
      ),
    [retainedIndexes]
  )
  const scrollToFn = useCallback(
    (
      offset: number,
      options: Parameters<typeof elementScroll>[1],
      instance: Virtualizer<HTMLDivElement, HTMLDivElement>
    ) => {
      // 统一记录虚拟库的所有位置写入，包括其内部测高补偿与 RAF 收尾。
      elementScroll(offset, options, instance)
      state.recordScrollAdjustment()
    },
    [state]
  )
  const onChange = useCallback(
    (instance: Virtualizer<HTMLDivElement, HTMLDivElement>) => {
      const first = instance.range?.startIndex
      const viewport = state.viewportRef.current
      const end = Math.max(0, instance.getTotalSize() - (viewport?.clientHeight ?? 0))
      // directDomUpdates 已在 onChange 前写入容器高度。此时对齐可在同次测量中完成，
      // 避免流式增长先露出空隙、再等下一帧补滚动；用户上滚后立即停止。
      if (viewport && state.getSnapshot().following && Math.abs(viewport.scrollTop - end) > 1)
        instance.scrollToEnd({ behavior: "auto" })
      state.setPosition(
        viewport ? end - viewport.scrollTop <= conversationEndThresholdPx : true,
        first === undefined
          ? null
          : (rows[first]?.navigationId ?? rows[first]?.messageIds[0] ?? null)
      )
      // 新挂载节点尚未完成布局时仍可能被浏览器限位，只为这种情况保留一帧补偿。
      if (
        viewport &&
        state.getSnapshot().following &&
        followFrame.current === null &&
        Math.abs(viewport.scrollTop - end) > 1
      ) {
        followFrame.current = window.requestAnimationFrame(() => {
          followFrame.current = null
          if (state.getSnapshot().following) instance.scrollToEnd({ behavior: "auto" })
        })
      }
    },
    [state, rows]
  )
  // 此组件已用 use no memo 退出自动缓存，实例只在此组件及其回调中使用。
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack 的可变实例需要读取当前测量结果。
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => state.viewportRef.current,
    scrollToFn,
    getItemKey,
    estimateSize,
    rangeExtractor,
    overscan: 4,
    paddingStart: 28,
    paddingEnd: 20,
    gap: 24,
    initialRect: { width: 0, height: 600 },
    initialOffset: () =>
      Math.max(0, rows.reduce((sum, row) => sum + row.estimateSize + 24, 24) - 600),
    anchorTo: snapshot.following ? "end" : "start",
    followOnAppend: snapshot.following,
    scrollEndThreshold: conversationEndThresholdPx,
    directDomUpdates: true,
    useFlushSync: false,
    onChange,
  })

  // 数据提交可能只改变容器高度而不触发测量回调，也要刷新返回底部按钮。
  useLayoutEffect(() => onChange(virtualizer), [onChange, virtualizer, snapshot.viewportVersion])

  useLayoutEffect(() => {
    // 只补偿阅读点上方整行的高度变化；正在阅读的长回复向下增长时不移动阅读点。
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
      item.end <= (instance.scrollOffset ?? 0)
  }, [virtualizer])

  useLayoutEffect(
    () => () => {
      if (followFrame.current !== null) window.cancelAnimationFrame(followFrame.current)
    },
    []
  )

  useLayoutEffect(
    () =>
      state.registerNavigation({
        hasMessage: (id) => indexByMessageId.has(id),
        scrollToMessage: (id) =>
          virtualizer.scrollToIndex(indexByMessageId.get(id)!, {
            align: "start",
            behavior: "auto",
          }),
        scrollToEnd: () => virtualizer.scrollToEnd({ behavior: "auto" }),
      }),
    [state, indexByMessageId, virtualizer]
  )

  useLayoutEffect(() => {
    if (initialized.current || !rows.length || !state.viewportRef.current) return
    initialized.current = true
    virtualizer.scrollToEnd({ behavior: "auto" })
  }, [rows.length, snapshot.viewportVersion, state, virtualizer])

  return (
    <div data-virtual-transcript ref={virtualizer.containerRef} className="relative w-full min-w-0">
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={item.key}
          data-index={item.index}
          data-transcript-row={rows[item.index]!.id}
          ref={virtualizer.measureElement}
          className="absolute top-0 left-0 flex w-full min-w-0 flex-col gap-6"
        >
          <TranscriptRowContext value={rows[item.index]!.id}>
            {renderRow(item.index)}
          </TranscriptRowContext>
        </div>
      ))}
    </div>
  )
}
