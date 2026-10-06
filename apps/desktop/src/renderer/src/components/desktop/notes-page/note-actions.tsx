import { useEffect, useRef, useState } from "react"
import { Check, Copy, Ellipsis, Pin, PinOff, Trash2 } from "lucide-react"

import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@renderer/components/motion/popover-morph"
import { Button } from "@renderer/components/ui/button"
import { Separator } from "@renderer/components/ui/separator"
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group"
import { toast } from "@renderer/lib/toast"
import { NOTE_COLORS, type NoteAppearance } from "./note-appearance"
import type { NoteView } from "./note-model"

export function NoteActions({
  note,
  label = "便签操作",
  onAppearanceChange,
  onDelete,
}: {
  note: NoteView
  label?: string
  onAppearanceChange?: (patch: Partial<NoteAppearance>) => void
  onDelete: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => actionsRef.current?.querySelector("button")?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  return (
    <MorphPopover open={open} onOpenChange={setOpen}>
      <MorphPopoverTrigger>
        <Button ref={triggerRef} variant="ghost" shape="circle" size="icon-sm" aria-label={label}>
          <Ellipsis />
        </Button>
      </MorphPopoverTrigger>
      <MorphPopoverContent align="end">
        <div
          ref={actionsRef}
          className="flex w-72 flex-col gap-1 p-2"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              // Escape dismisses this layer, not the collection folder beneath it.
              event.preventDefault()
              event.stopPropagation()
              close()
            } else if (event.key === "Tab") {
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")
              ).filter((button) => button.tabIndex >= 0)
              const first = buttons[0]
              const last = buttons.at(-1)
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault()
                last?.focus()
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault()
                first?.focus()
              }
              event.stopPropagation()
            }
          }}
        >
          {onAppearanceChange ? (
            <>
              <Button
                variant="ghost"
                shape="pill"
                size="sm"
                className="justify-start"
                onClick={() => {
                  onAppearanceChange({ pinned: !note.pinned })
                  close()
                }}
              >
                {note.pinned ? (
                  <PinOff data-icon="inline-start" />
                ) : (
                  <Pin data-icon="inline-start" />
                )}
                {note.pinned ? "取消置顶" : "置顶"}
              </Button>
              <div className="flex flex-col gap-2 px-2 py-2">
                <span className="text-xs text-muted-foreground">纸片颜色</span>
                <ToggleGroup
                  aria-label="纸片颜色"
                  value={[note.color ?? "default"]}
                  onValueChange={(values) => {
                    const color = NOTE_COLORS.find((item) => item.value === values[0])
                    if (color) onAppearanceChange({ color: color.value })
                  }}
                  size="sm"
                  spacing={1}
                >
                  {NOTE_COLORS.map((color) => (
                    <ToggleGroupItem
                      key={color.value}
                      value={color.value}
                      aria-label={"标记为" + color.label}
                      title={color.label}
                    >
                      <span
                        data-note-color={color.value}
                        className="note-color-swatch flex size-5 items-center justify-center rounded-full border border-foreground/15"
                        aria-hidden="true"
                      >
                        {(note.color ?? "default") === color.value ? (
                          <Check className="size-3" />
                        ) : null}
                      </span>
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <Separator />
            </>
          ) : null}
          <Button
            variant="ghost"
            shape="pill"
            size="sm"
            className="justify-start"
            onClick={() => {
              close()
              void window.desktop.clipboard
                .writeText(note.content)
                .then(() => toast.success("正文已复制"))
                .catch((cause) => toast.error("复制失败", String(cause)))
            }}
          >
            <Copy data-icon="inline-start" />
            复制正文
          </Button>
          <Button
            variant="ghost"
            shape="pill"
            size="sm"
            className="justify-start text-destructive hover:text-destructive"
            onClick={() => {
              close()
              onDelete()
            }}
          >
            <Trash2 data-icon="inline-start" />
            删除便签
          </Button>
        </div>
      </MorphPopoverContent>
    </MorphPopover>
  )
}
