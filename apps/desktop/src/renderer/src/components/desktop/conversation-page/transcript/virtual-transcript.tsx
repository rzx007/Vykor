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
import { useConversationScroller } from "./conversation-scroll-context"
import {
  conversationEndThresholdPx,
  type ConversationScrollState,
} from "./conversation-scroll-state"
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

function prefersReducedMotion() {
  const preference = document.documentElement.dataset.reducedMotion
  return preference === undefined
    ? window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    : preference === "true"
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
  const cancelFollow = useCallback(() => {
    if (followFrame.current !== null) window.cancelAnimationFrame(followFrame.current)
    followFrame.current = null
  }, [])
  const scheduleFollow = useCallback(
    (instance: Virtualizer<HTMLDivElement, HTMLDivElement>) => {
      const viewport = state.viewportRef.current
      if (!viewport || !viewport.clientHeight || !state.getSnapshot().following) return
      if (followFrame.current !== null) return
      const end = Math.max(0, instance.getTotalSize() - viewport.clientHeight)
      if (prefersReducedMotion()) {
        cancelFollow()
        if (Math.abs(end - viewport.scrollTop) > 1) {
          elementScroll(end, { behavior: "auto" }, instance)
          state.recordScrollAdjustment()
        }
        return
      }
      if (Math.abs(end - viewport.scrollTop) <= 1) return
      let previousTime: number | undefined
      const tick = (time: number) => {
        if (!state.getSnapshot().following || !viewport.isConnected || !viewport.clientHeight) {
          cancelFollow()
          return
        }
        // 每帧读取最新测高，不为每个输出片段重新启动动画，也不在输出结束时补跳。
        const target = Math.max(0, instance.getTotalSize() - viewport.clientHeight)
        const distance = target - viewport.scrollTop
        const elapsed = previousTime === undefined ? 16 : Math.min(time - previousTime, 32)
        previousTime = time
        const finished = Math.abs(distance) <= 1 || prefersReducedMotion()
        const next = finished
          ? target
          : viewport.scrollTop + distance * (1 - Math.exp(-elapsed / 28))
        if (finished) cancelFollow()
        else followFrame.current = window.requestAnimationFrame(tick)
        elementScroll(next, { behavior: "auto" }, instance)
        state.recordScrollAdjustment()
      }
      followFrame.current = window.requestAnimationFrame(tick)
    },
    [cancelFollow, state]
  )
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
      // 历史定位与阅读点补偿仍直接定位，记录后不会被当作用户上翻。
      elementScroll(offset, options, instance)
      state.recordScrollAdjustment()
    },
    [state]
  )
  const onChange = useCallback(
    (instance: Virtualizer<HTMLDivElement, HTMLDivElement>, sync = false) => {
      const first = instance.range?.startIndex
      const viewport = state.viewportRef.current
      const end = Math.max(0, instance.getTotalSize() - (viewport?.clientHeight ?? 0))
      if (viewport && state.getSnapshot().following) {
        // 容器缩短时浏览器会限位；这是布局修正，不能误判为用户上翻。
        if (viewport.scrollTop > end) {
          elementScroll(end, { behavior: "auto" }, instance)
          state.recordScrollAdjustment()
        } else if (!sync && Math.abs(viewport.scrollTop - end) <= 1) {
          state.recordScrollAdjustment()
        }
        if (initialized.current) scheduleFollow(instance)
      }
      state.setPosition(
        viewport ? end - viewport.scrollTop <= conversationEndThresholdPx : true,
        first === undefined
          ? null
          : (rows[first]?.navigationId ?? rows[first]?.messageIds[0] ?? null)
      )
    },
    [state, rows, scheduleFollow]
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
    anchorTo: "start",
    followOnAppend: false,
    scrollEndThreshold: conversationEndThresholdPx,
    directDomUpdates: true,
    useFlushSync: false,
    onChange,
  })

  // 数据提交可能只改变容器高度而不触发测量回调，也要刷新返回底部按钮。
  useLayoutEffect(() => onChange(virtualizer), [onChange, virtualizer, snapshot.viewportVersion])

  useLayoutEffect(() => {
    // 只补偿阅读点上方的整行；上滚时不反向修正，避免测高与用户的滚动相互抵消。
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
      !state.getSnapshot().following &&
      instance.scrollDirection !== "backward" &&
      item.end <= (instance.scrollOffset ?? 0)
  }, [state, virtualizer])

  useLayoutEffect(() => {
    const unsubscribe = state.subscribe(() => {
      if (!state.getSnapshot().following) cancelFollow()
    })
    return () => {
      unsubscribe()
      cancelFollow()
    }
  }, [cancelFollow, state])

  useLayoutEffect(
    () =>
      state.registerNavigation({
        hasMessage: (id) => indexByMessageId.has(id),
        scrollToMessage: (id) =>
          virtualizer.scrollToIndex(indexByMessageId.get(id)!, {
            align: "start",
            behavior: "auto",
          }),
        scrollToEnd: () => {
          const viewport = state.viewportRef.current
          if (!viewport) return
          // 清掉尚未结束的搜索定位目标，避免它在上翻后继续把视口拉回去。
          virtualizer.scrollToOffset(viewport.scrollTop, { behavior: "auto" })
          scheduleFollow(virtualizer)
        },
      }),
    [state, indexByMessageId, virtualizer, scheduleFollow]
  )

  useLayoutEffect(() => {
    if (initialized.current || !rows.length || !state.viewportRef.current) return
    initialized.current = true
    virtualizer.scrollToOffset(
      Math.max(0, virtualizer.getTotalSize() - state.viewportRef.current.clientHeight),
      { behavior: "auto" }
    )
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
