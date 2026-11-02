import { useId, useRef, useState } from "react"
import { MessageCircle, Pencil, Trash2, X } from "lucide-react"

import type { BrowserAnnotationRecord } from "@shared/browser-annotation"
import { Badge } from "@renderer/components/ui/badge"
import { Button } from "@renderer/components/ui/button"
import { ButtonGroup } from "@renderer/components/ui/button-group"
import { Field, FieldLabel } from "@renderer/components/ui/field"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@renderer/components/ui/popover"
import { Textarea } from "@renderer/components/ui/textarea"

type ComposerBrowserAnnotationsProps = {
  annotations: readonly BrowserAnnotationRecord[]
  disabled?: boolean
  onUpdateComment: (id: string, comment: string) => void
  onRemove: (id: string) => void
  onClear: () => void
}

export function ComposerBrowserAnnotations({
  annotations,
  disabled = false,
  onUpdateComment,
  onRemove,
  onClear,
}: ComposerBrowserAnnotationsProps) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<{ id: string; comment: string } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const inputId = useId()
  const editingAnnotation = annotations.find((annotation) => annotation.id === editing?.id)
  const comment = editing?.comment.trim() ?? ""
  const canSave = !disabled && Boolean(comment) && comment.length <= 2000

  if (!annotations.length) return null

  const save = () => {
    if (!editing || !canSave) return
    onUpdateComment(editing.id, comment)
    setEditing(null)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        // Restore focus before closing so focusing the chip does not reopen it.
        if (!next && details.reason === "escape-key") trigger.current?.focus()
        setOpen(next)
        if (!next) setEditing(null)
      }}
    >
      <ButtonGroup variant="toolbar" aria-label="待发送批注">
        <PopoverTrigger
          openOnHover
          closeDelay={150}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          render={<Button ref={trigger} type="button" variant="ghost" shape="pill" size="sm" />}
        >
          <MessageCircle data-icon="inline-start" />
          {annotations.length} 条批注
        </PopoverTrigger>
        <Button
          type="button"
          variant="ghost"
          shape="circle"
          size="icon-sm"
          aria-label="移除全部批注"
          title="移除全部批注"
          disabled={disabled}
          onClick={() => {
            setOpen(false)
            setEditing(null)
            onClear()
          }}
        >
          <X />
        </Button>
      </ButtonGroup>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        initialFocus={false}
        finalFocus={false}
        className="max-h-80 w-96 max-w-[calc(100vw-2rem)] gap-0 overflow-y-auto rounded-2xl p-2"
        onKeyDownCapture={(event) => {
          if (event.key === "Escape" && editing) {
            event.preventDefault()
            event.stopPropagation()
            setEditing(null)
            trigger.current?.focus()
          }
        }}
      >
        {editing && editingAnnotation ? (
          <div className="flex min-w-0 flex-col gap-4 p-2">
            <div className="flex min-w-0 flex-col gap-2">
              <PopoverTitle className="text-sm font-semibold">编辑批注</PopoverTitle>
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant="secondary">{editingAnnotation.tagName.toLowerCase()}</Badge>
                <span
                  className="truncate text-xs text-muted-foreground"
                  title={editingAnnotation.target}
                >
                  {editingAnnotation.target}
                </span>
              </div>
            </div>
            <Field data-disabled={disabled} data-invalid={comment.length > 2000}>
              <FieldLabel htmlFor={inputId} className="sr-only">
                批注意见
              </FieldLabel>
              <Textarea
                id={inputId}
                autoFocus
                value={editing.comment}
                rows={3}
                maxLength={2000}
                disabled={disabled}
                aria-describedby={`${inputId}-count`}
                aria-invalid={comment.length > 2000 || undefined}
                placeholder="描述你希望这个元素如何调整…"
                className="field-sizing-fixed max-h-48 min-h-28 resize-y rounded-xl px-3 py-2.5 text-sm leading-relaxed"
                onChange={(event) =>
                  setEditing({ id: editingAnnotation.id, comment: event.target.value })
                }
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.ctrlKey || event.metaKey) &&
                    !event.nativeEvent.isComposing &&
                    event.keyCode !== 229
                  ) {
                    event.preventDefault()
                    event.stopPropagation()
                    save()
                  }
                }}
              />
            </Field>
            <div className="flex items-center justify-between gap-3">
              <span id={`${inputId}-count`} className="text-xs text-muted-foreground">
                {editing.comment.length} / 2000
              </span>
              <div className="flex items-center gap-2">
                <Button type="button" variant="ghost" shape="pill" onClick={() => setEditing(null)}>
                  取消
                </Button>
                <Button
                  type="button"
                  shape="pill"
                  title="保存（Ctrl / ⌘ + Enter）"
                  disabled={!canSave}
                  onClick={save}
                >
                  保存
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <PopoverTitle className="sr-only">待发送批注</PopoverTitle>
            <ul className="flex flex-col divide-y divide-border">
              {annotations.map((annotation, index) => (
                <li key={annotation.id} className="flex gap-2 px-2 py-3">
                  <span className="pt-0.5 text-xs text-muted-foreground">{index + 1}.</span>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge variant="secondary">{annotation.tagName.toLowerCase()}</Badge>
                      <span
                        className="truncate text-xs text-muted-foreground"
                        title={annotation.target}
                      >
                        {annotation.target}
                      </span>
                    </div>
                    <p className="text-sm break-words whitespace-pre-wrap">{annotation.comment}</p>
                  </div>
                  <div className="flex shrink-0 gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      shape="circle"
                      size="icon-sm"
                      aria-label={`编辑批注 ${index + 1}`}
                      title="编辑批注"
                      disabled={disabled}
                      onClick={() => setEditing({ id: annotation.id, comment: annotation.comment })}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      shape="circle"
                      size="icon-sm"
                      aria-label={`删除批注 ${index + 1}`}
                      title="删除批注"
                      disabled={disabled}
                      onClick={() => {
                        if (annotations.length === 1) setOpen(false)
                        onRemove(annotation.id)
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
