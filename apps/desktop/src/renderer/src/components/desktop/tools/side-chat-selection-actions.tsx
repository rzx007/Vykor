import { useEffect, useRef, useState, type RefObject } from "react"
import { Copy, StickyNote } from "lucide-react"
import { toast } from "@renderer/lib/toast"
import { Button } from "@renderer/components/ui/button"
import { Popover, PopoverContent } from "@renderer/components/ui/popover"
import { useMainLayout } from "../layout/main-layout/main-layout-context"
import {
  copyConversationText,
  readConversationSelection,
} from "../conversation-page/conversation-text-actions"

export function SideChatSelectionActions({
  sourceId,
  viewportRef,
}: {
  sourceId: string | null
  viewportRef: RefObject<HTMLDivElement | null>
}): React.JSX.Element | null {
  const { openSideChat } = useMainLayout()
  const [savingNote, setSavingNote] = useState(false)
  const noteSavePending = useRef(false)
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
      const viewport = viewportRef.current
      const selected = viewport ? readConversationSelection(viewport) : null
      if (!sourceId || !viewport || !selected || !selected.text.trim()) {
        setSelection(null)
        return
      }
      setSelection({
        sourceId,
        text: selected.text,
        rect: selected.range.getBoundingClientRect(),
      })
    }
    const down = (event: MouseEvent): void => {
      gesture.current.releaseClick = false
      gesture.current.dragging =
        event.button === 0 && !!viewportRef.current?.contains(event.target as Node)
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
    const contextMenu = (): void => {
      setSelection(null)
    }
    document.addEventListener("mousedown", down, true)
    document.addEventListener("mouseup", up)
    document.addEventListener("selectionchange", read)
    document.addEventListener("keydown", key)
    document.addEventListener("contextmenu", contextMenu, true)
    return () => {
      document.removeEventListener("mousedown", down, true)
      document.removeEventListener("mouseup", up)
      document.removeEventListener("selectionchange", read)
      document.removeEventListener("keydown", key)
      document.removeEventListener("contextmenu", contextMenu, true)
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
        className="w-auto flex-row items-center gap-0.5 p-1"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="复制选中内容"
          title="复制选中内容"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            void copyConversationText(selection.text).then((copied) => {
              if (copied) setSelection((current) => (current === selection ? null : current))
            })
          }}
        >
          <Copy />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={savingNote}
          aria-busy={savingNote}
          onMouseDown={(event) => event.preventDefault()}
          onClick={async () => {
            if (noteSavePending.current) return
            noteSavePending.current = true
            setSavingNote(true)
            try {
              await window.desktop.notes.create({ content: selection.text })
              toast.success("已添加到便签")
              setSelection((current) => (current === selection ? null : current))
            } catch {
              toast.error("添加到便签失败，请重试")
            } finally {
              noteSavePending.current = false
              setSavingNote(false)
            }
          }}
        >
          <StickyNote />
          添加到便签
        </Button>
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
