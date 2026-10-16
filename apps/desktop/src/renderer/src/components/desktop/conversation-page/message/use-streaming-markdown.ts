import { startTransition, useEffect, useRef, useState } from "react"

export const longMarkdownCharacters = 4096
const updateIntervalMs = 64

export function useStreamingMarkdown(text: string, streaming: boolean, liveCode = false) {
  const [value, setValue] = useState({
    source: text,
    visible: text,
    revision: 0,
    markerChanged: false,
  })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const corrected = text !== value.source && !text.startsWith(value.source)
  // 代码源码和复制必须跟随本次增量；仅颜色在后台限频，不能被正文的 64ms 合并延迟。
  const added = text.slice(Math.max(0, value.source.length - 2))
  const markerChanged =
    value.source === text ? value.markerChanged : added.includes("```") || added.includes("~~~")
  const immediate =
    !streaming || text.length <= longMarkdownCharacters || corrected || liveCode || markerChanged
  // 修正、截断和完成在本次提交中显示；revision 同时清除上游按位置缓存的旧节点。
  if (value.source !== text || (immediate && value.visible !== text)) {
    setValue({
      source: text,
      visible: immediate ? text : value.visible,
      revision: value.revision + (corrected ? 1 : 0),
      markerChanged,
    })
  }

  useEffect(() => {
    if (immediate || value.visible === text) {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
      return
    }
    // 已排定的时刻不随每个 token 重置，连续输出时也能持续刷新。
    if (timer.current === null) {
      timer.current = setTimeout(() => {
        timer.current = null
        startTransition(() =>
          setValue((current) =>
            current.visible === current.source ? current : { ...current, visible: current.source }
          )
        )
      }, updateIntervalMs)
    }
  }, [immediate, text, value.visible])

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    []
  )

  return { text: immediate ? text : value.visible, revision: value.revision }
}
