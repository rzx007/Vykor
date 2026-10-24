import { useEffect, useLayoutEffect, useRef, useState } from "react"

// beUI streaming-response.preview.tsx：按经过时间推进 cursor，保持原示例的 110 字符/秒。
const charactersPerSecond = 110
const maxQueuedCharacters = charactersPerSecond * 2

export function useStreamingResponseText(
  text: string,
  { enabled, animateInitialText }: { enabled: boolean; animateInitialText: boolean }
) {
  const [source, setSource] = useState(text)
  const [cursor, setCursor] = useState(() => (enabled && animateInitialText ? 0 : text.length))
  const target = useRef(text)
  const frame = useRef<number | null>(null)

  if (source !== text || (!enabled && cursor !== text.length)) {
    const corrected = source !== text && !text.startsWith(source)
    setSource(text)
    if (!enabled || corrected) setCursor(text.length)
  }

  useLayoutEffect(() => {
    target.current = text
  }, [text])

  useEffect(() => {
    if (!enabled || cursor >= text.length) {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      return
    }
    // 到达的新 token 只更新目标，不重建正在运行的时钟；同一回复最多有一条 RAF 链。
    if (frame.current !== null) return
    let startedAt = performance.now()
    let startCursor = cursor
    const stream = (now: number) => {
      const current = target.current
      let next = Math.min(
        current.length,
        startCursor + Math.floor(((now - startedAt) / 1000) * charactersPerSecond)
      )
      // 真实服务可能比演示快很多，限制积压，避免后台结束后仍播放很久。
      if (current.length - next > maxQueuedCharacters) {
        next = current.length - maxQueuedCharacters
        startCursor = next
        startedAt = now
      }
      // 示例直接 slice 字符串；这里避免切断 UTF-16 代理对（如单个 emoji）。
      if (
        next > 0 &&
        /[\uD800-\uDBFF]/.test(current[next - 1]!) &&
        /[\uDC00-\uDFFF]/.test(current[next] ?? "")
      )
        next--
      setCursor(next)
      if (next < current.length) frame.current = requestAnimationFrame(stream)
      else frame.current = null
    }
    frame.current = requestAnimationFrame(stream)
  }, [cursor, enabled, text.length])

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    },
    []
  )

  return { text: enabled ? text.slice(0, cursor) : text, pending: enabled && cursor < text.length }
}
