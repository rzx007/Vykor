import { useEffect, useId, useRef, useState, type RefObject } from "react"
import { Trash2, X } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@renderer/components/ui/field"
import { Textarea } from "@renderer/components/ui/textarea"
import { cn } from "@renderer/lib/utils"
import type { BrowserAnnotationUi } from "./use-browser-annotations"

export function BrowserAnnotationPanel({ ui, containerRef }: { ui: BrowserAnnotationUi; containerRef: RefObject<HTMLDivElement | null> }) {
  const id = useId(), input = useRef<HTMLTextAreaElement>(null)
  const [size, setSize] = useState({ width: 400, height: 500 })
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const update = () => {
      const box = element.getBoundingClientRect()
      if (box.width && box.height) setSize(previous => previous.width === box.width && previous.height === box.height ? previous : { width: box.width, height: box.height })
    }
    update()
    const observer = new ResizeObserver(update); observer.observe(element)
    return () => observer.disconnect()
  }, [containerRef])
  useEffect(() => { if (ui.editing) input.current?.focus() }, [ui.editing, ui.selection?.selectionId])
  const viewport = ui.snapshot?.viewport, r = ui.selection?.rect
  const inView = r && viewport && r.x + r.width > 0 && r.y + r.height > 0 && r.x < viewport.width && r.y < viewport.height
  const width = Math.max(180, Math.min(340, size.width - 24))
  const scaleX = viewport ? size.width / viewport.width : 1, scaleY = viewport ? size.height / viewport.height : 1
  const left = inView ? Math.max(12, Math.min(r.x * scaleX, size.width - width - 12)) : 12
  const bottomEdge = inView ? (r.y + r.height) * scaleY + 10 : 0
  const top = inView ? (bottomEdge + 220 <= size.height ? bottomEdge : Math.max(12, r.y * scaleY - 220)) : undefined
  const annotations = ui.snapshot?.annotations ?? []
  const panelClass = "pointer-events-auto absolute rounded-xl bg-background p-3 text-foreground shadow-lg"

  return <div className="pointer-events-none absolute inset-0 z-10" aria-label="页面批注">
    {ui.snapshot?.mode === "pick" && !ui.editing && (
      <div className="pointer-events-auto absolute top-3 left-3 flex items-center gap-2 rounded-lg bg-background px-3 py-2 text-xs shadow-sm">
        <span>悬停查看目标，点击添加意见</span>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="结束选择" onClick={() => void ui.showSaved()}><X /></Button>
      </div>
    )}
    {ui.editing && (
      <form className={panelClass} style={{ width, left, top, bottom: top === undefined ? 12 : undefined, maxHeight: size.height - (top ?? 12) - 12, overflowY: "auto" }}
        onSubmit={event => { event.preventDefault(); void ui.save() }}
        onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); ui.cancelEditor() }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (ui.selection && !ui.pending) void ui.save() }
        }}>
        <p className="mb-3 truncate text-xs text-muted-foreground">
          {ui.selection?.target.target ?? "草稿已保留，请重新选择目标"}
          {ui.selection && !inView && " · 目标已滚出视野"}
        </p>
        <FieldGroup><Field data-invalid={Boolean(ui.error)} data-disabled={ui.pending}>
          <FieldLabel htmlFor={id} className="sr-only">批注意见</FieldLabel>
          <Textarea id={id} ref={input} value={ui.draft} maxLength={2000} disabled={ui.pending} aria-invalid={Boolean(ui.error)}
            onChange={event => ui.setDraft(event.target.value)} placeholder="描述希望怎么调整…" className="max-h-40 min-h-24 resize-y" />
          {ui.error && <FieldError>{ui.error}</FieldError>}
        </Field></FieldGroup>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Ctrl / ⌘ + Enter</span>
          <div className="flex gap-1">
            <Button type="button" variant="ghost" size="sm" disabled={ui.pending} onClick={ui.cancelEditor}>取消</Button>
            {!ui.selection && <Button type="button" variant="secondary" size="sm" disabled={ui.pending} onClick={() => void ui.startPicking()}>重新选择</Button>}
            <Button type="submit" size="sm" disabled={ui.pending || !ui.selection || !ui.draft.trim()}>{ui.pending ? "保存中…" : "保存批注"}</Button>
          </div>
        </div>
      </form>
    )}
    {ui.listOpen && !ui.editing && (
      <section className={panelClass} style={{ top: 12, right: 12, width, maxHeight: size.height - 24, overflowY: "auto" }} aria-label="已保存批注">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium">批注 · {annotations.length}</h3>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="隐藏批注" onClick={() => void ui.hide()}><X /></Button>
        </div>
        {!annotations.length && <p className="py-3 text-xs text-muted-foreground">还没有批注，选择页面元素后填写意见。</p>}
        <ol className="flex flex-col gap-1">
          {annotations.map(({ record, status }, index) => <li key={record.id} className={cn("rounded-lg px-2 py-2", ui.viewedAnnotationId === record.id && "bg-muted")}>
            <div className="flex items-start gap-1">
              <Button type="button" variant="ghost" size="sm" className="min-w-0 flex-1 justify-start" aria-label={`定位批注 ${index + 1}`} disabled={ui.pending} onClick={() => void ui.focus(record.id)}>
                <span className="shrink-0">{index + 1}.</span><span className="truncate">{record.target}</span>
              </Button>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={`删除批注 ${index + 1}`} disabled={ui.pending} onClick={() => void ui.remove(record.id)}><Trash2 /></Button>
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{record.comment}</p>
            {status === "missing" && <p className="mt-1 text-xs text-muted-foreground">已保存，目标位置暂不可用</p>}
          </li>)}
        </ol>
        {ui.error && <FieldError className="mt-2">{ui.error}</FieldError>}
        <Button type="button" variant="secondary" size="sm" className="mt-3 w-full" disabled={ui.pending} onClick={() => void ui.startPicking()}>继续添加批注</Button>
      </section>
    )}
    {ui.error && !ui.editing && !ui.listOpen && <p role="status" className="absolute bottom-3 left-3 max-w-[85%] rounded-lg bg-background px-3 py-2 text-xs text-destructive shadow-sm">{ui.error}</p>}
  </div>
}
