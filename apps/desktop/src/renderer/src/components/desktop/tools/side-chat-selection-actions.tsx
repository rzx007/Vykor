import { useEffect, useRef, useState, type RefObject } from "react"
import { Button } from "@renderer/components/ui/button"
import { Popover, PopoverContent } from "@renderer/components/ui/popover"
import { useMainLayout } from "../layout/main-layout/main-layout-context"

function endpointElement(node: Node | null): Element | null {
  return node instanceof Element ? node : (node?.parentElement ?? null)
}
function isInside(node: Node | null, viewport: HTMLElement): boolean {
  let element = endpointElement(node)
  while (element) {
    if (element.closest('textarea,input,[contenteditable]:not([contenteditable="false"])'))
      return false
    if (viewport.contains(element)) return true
    const root = element.getRootNode()
    element = root instanceof ShadowRoot ? root.host : null
  }
  return false
}

export function SideChatSelectionActions({
  sourceId,
  viewportRef,
}: {
  sourceId: string | null
  viewportRef: RefObject<HTMLDivElement | null>
}): React.JSX.Element | null {
  const { openSideChat } = useMainLayout()
  const [selection, setSelection] = useState<{
    sourceId: string
    text: string
    rect: DOMRect
  } | null>(null)
  // Keep the drag through transcript rerenders; the release's click is part of it.
  const gesture = useRef({ dragging: false, releaseClick: false })
  useEffect(() => {
    const read = (): void => {
      if (gesture.current.dragging) return
      const selected = window.getSelection()
      const viewport = viewportRef.current
      if (
        !sourceId ||
        !viewport ||
        !selected ||
        !selected.rangeCount ||
        !selected.toString().trim() ||
        !isInside(selected.anchorNode, viewport) ||
        !isInside(selected.focusNode, viewport)
      ) {
        setSelection(null)
        return
      }
      setSelection({
        sourceId,
        text: selected.toString(),
        rect: selected.getRangeAt(0).getBoundingClientRect(),
      })
    }
    const down = (event: MouseEvent): void => {
      gesture.current.releaseClick = false
      gesture.current.dragging = !!viewportRef.current?.contains(event.target as Node)
    }
    const up = (): void => {
      if (!gesture.current.dragging) return
      gesture.current.dragging = false
      gesture.current.releaseClick = true
      read()
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setSelection(null)
    }
    document.addEventListener("mousedown", down, true)
    document.addEventListener("mouseup", up)
    document.addEventListener("selectionchange", read)
    document.addEventListener("keydown", key)
    return () => {
      document.removeEventListener("mousedown", down, true)
      document.removeEventListener("mouseup", up)
      document.removeEventListener("selectionchange", read)
      document.removeEventListener("keydown", key)
    }
  }, [sourceId, viewportRef])
  if (!sourceId || !selection || selection.sourceId !== sourceId) return null
  return (
    <Popover
      open
      onOpenChange={(open, details) => {
        if (open) return
        if (details.reason === "outside-press" && gesture.current.releaseClick) {
          gesture.current.releaseClick = false
          details.cancel()
          return
        }
        setSelection(null)
      }}
    >
      <PopoverContent
        anchor={{ getBoundingClientRect: () => selection.rect }}
        side="top"
        align="start"
        initialFocus={false}
        finalFocus={false}
        className="w-auto p-1"
      >
        <Button
          variant="ghost"
          size="sm"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            openSideChat(sourceId, selection.text)
            setSelection(null)
          }}
        >
          在侧边聊天中提问
        </Button>
      </PopoverContent>
    </Popover>
  )
}
