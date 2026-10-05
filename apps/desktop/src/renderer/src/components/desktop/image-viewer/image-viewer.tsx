import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import {
  Copy,
  Download,
  ExternalLink,
  Maximize,
  MousePointer2,
  Redo2,
  SquareDashedMousePointer,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch"
import { Button } from "@renderer/components/ui/button"
import { ButtonGroup } from "@renderer/components/ui/button-group"
import { Textarea } from "@renderer/components/ui/textarea"
import { useReducedMotion } from "motion/react"
import { cn } from "@renderer/lib/utils"
import { useImageAnnotations } from "./use-image-annotations"
import { renderImageRegions, type ImageRegion } from "./image-annotations"
import "@annotorious/annotorious/annotorious.css"
import "./image-viewer.css"

export function ImageViewer({
  bytes,
  url,
  name,
  mediaType = "image/png",
  onClose,
  onFeedback,
  onOpenOriginal,
}: {
  bytes: ArrayBuffer
  url?: string
  name: string
  mediaType?: string
  onClose: () => void
  onFeedback?: (
    marked: Blob,
    regions: ImageRegion[],
    width: number,
    height: number
  ) => Promise<void>
  onOpenOriginal?: () => Promise<unknown>
}) {
  const [drawing, setDrawing] = useState(false)
  const [scale, setScale] = useState(1)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [status, setStatus] = useState("")
  const viewport = useRef<HTMLDivElement>(null)
  const transform = useRef<ReactZoomPanPinchRef>(null)
  const reduced = useReducedMotion()
  const { hostRef, imageRef, ...annotation } = useImageAnnotations(
    bytes,
    url,
    name,
    drawing,
    mediaType
  )
  const selected = annotation.regions.find((region) => region.id === annotation.selectedId)
  const comment = selected?.comment ?? ""
  const completed = annotation.regions.filter((region) => region.comment.trim())
  const duration = reduced ? 0 : 160
  const focusComment = useCallback((node: HTMLTextAreaElement | null) => {
    node?.focus()
  }, [])

  useEffect(() => {
    const element = viewport.current
    if (!element || !annotation.ready) return
    const fit = () => {
      const size = element.getBoundingClientRect()
      if (!size.width || !size.height) return
      const nextScale = Math.max(
        0.01,
        Math.min(
          1,
          (size.width - 48) / annotation.dimensions.width,
          (size.height - 48) / annotation.dimensions.height
        )
      )
      transform.current?.centerView(nextScale, 0)
    }
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    fit()
    return () => observer.disconnect()
  }, [annotation.ready, annotation.dimensions.width, annotation.dimensions.height])

  const fit = () => {
    const element = viewport.current
    if (!element) return
    const box = element.getBoundingClientRect()
    transform.current?.centerView(
      Math.max(
        0.01,
        Math.min(
          1,
          (box.width - 48) / annotation.dimensions.width,
          (box.height - 48) / annotation.dimensions.height
        )
      ),
      duration
    )
  }

  const perform = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setActionError(null)
    try {
      await action()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "操作失败，请重试")
    } finally {
      setBusy(false)
    }
  }

  const exportImage = async (marked: boolean) => {
    const image = imageRef.current
    if (!image || !annotation.ready) throw new Error("图片尚未加载完成")
    return renderImageRegions(image, marked ? completed : [])
  }

  const download = () =>
    perform(async () => {
      const blob = completed.length
        ? await exportImage(true)
        : new Blob([bytes], { type: mediaType })
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = objectUrl
      link.download = completed.length ? `${name.replace(/\.[^.]+$/, "")}-批注.png` : name
      link.click()
      // 点击后浏览器异步读取 Blob，延后释放；不保存新的项目文件。
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    })

  const focusRegion = (region: ImageRegion) => {
    annotation.select(region.id)
    const box = viewport.current?.getBoundingClientRect()
    if (box)
      transform.current?.setTransform(
        box.width / 2 - (region.x + region.width / 2) * scale,
        box.height / 2 - (region.y + region.height / 2) * scale,
        scale,
        duration
      )
  }

  return (
    <section
      className="image-annotation-viewer flex h-full min-h-0 flex-col bg-background text-foreground"
      aria-label="图片查看与批注"
      onKeyDown={(event) => {
        const editing = (event.target as HTMLElement).closest(
          "textarea,input,[contenteditable=true]"
        )
        const modifier = event.ctrlKey || event.metaKey
        if (editing) {
          // Annotorious 的默认撤销监听在 document，不能同时撤销正在输入的评论。
          if (modifier && ["z", "y"].includes(event.key.toLowerCase())) event.stopPropagation()
          if (modifier && event.key === "Enter" && selected && comment.trim()) {
            event.preventDefault()
            event.stopPropagation()
            annotation.saveComment(selected.id, comment)
          }
          return
        }
        if (modifier && ["z", "y"].includes(event.key.toLowerCase())) {
          event.preventDefault()
          event.stopPropagation()
          if (event.shiftKey || event.key.toLowerCase() === "y") annotation.redo()
          else annotation.undo()
        } else if (event.key === "Escape" && (drawing || selected)) {
          event.preventDefault()
          event.stopPropagation()
          annotation.cancelSelection()
          setDrawing(false)
        } else if (
          !modifier &&
          !event.altKey &&
          ["+", "=", "-", "0", "1", "v", "r"].includes(event.key.toLowerCase())
        ) {
          event.preventDefault()
          event.stopPropagation()
          const key = event.key.toLowerCase()
          if (key === "+" || key === "=") transform.current?.zoomIn(0.25, duration)
          if (key === "-") transform.current?.zoomOut(0.25, duration)
          if (key === "0") fit()
          if (key === "1") transform.current?.centerView(1, duration)
          if (key === "v") setDrawing(false)
          if (key === "r" && onFeedback) setDrawing(true)
        }
      }}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 px-3 [&_svg]:size-4 [&_svg]:stroke-[1.75]">
        <span className="min-w-0 flex-1 truncate text-sm" title={name}>
          {name}
        </span>
        <ButtonGroup variant="toolbar" aria-label="图片缩放">
          <IconAction label="缩小（-）" onClick={() => transform.current?.zoomOut(0.25, duration)}>
            <ZoomOut />
          </IconAction>
          <Button
            variant="ghost"
            shape="pill"
            size="sm"
            className="min-w-16 tabular-nums"
            title="原始尺寸（1）"
            onClick={() => transform.current?.centerView(1, duration)}
          >
            {Math.round(scale * 100)}%
          </Button>
          <IconAction label="放大（+）" onClick={() => transform.current?.zoomIn(0.25, duration)}>
            <ZoomIn />
          </IconAction>
          <IconAction label="适应窗口（0）" onClick={fit}>
            <Maximize />
          </IconAction>
        </ButtonGroup>
        {onOpenOriginal && (
          <IconAction
            label="系统打开原图"
            onClick={() =>
              void perform(async () => {
                await onOpenOriginal()
              })
            }
          >
            <ExternalLink />
          </IconAction>
        )}
        <IconAction
          label="复制原图"
          disabled={busy || !annotation.ready}
          onClick={() =>
            void perform(async () => {
              await navigator.clipboard.write([
                new ClipboardItem({ "image/png": await exportImage(false) }),
              ])
              setStatus("已复制原图")
            })
          }
        >
          <Copy />
        </IconAction>
        <IconAction
          label={completed.length ? "下载批注图" : "下载原图"}
          disabled={busy || !annotation.ready}
          onClick={() => void download()}
        >
          <Download />
        </IconAction>
        <IconAction label="关闭图片查看器" onClick={onClose}>
          <X />
        </IconAction>
      </header>
      <div className="flex min-h-0 flex-1">
        <div
          ref={viewport}
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-muted/25"
          tabIndex={0}
          aria-label="图片画布"
        >
          <TransformWrapper
            ref={transform}
            minScale={0.01}
            maxScale={8}
            limitToBounds={false}
            panning={{ disabled: drawing }}
            doubleClick={{ disabled: true }}
            smooth={!reduced}
            zoomAnimation={{ disabled: Boolean(reduced) }}
            autoAlignment={{ disabled: true }}
            velocityAnimation={{ disabled: true }}
            onTransform={(_ref, state) => setScale(state.scale)}
          >
            <TransformComponent wrapperStyle={{ width: "100%", height: "100%" }}>
              <div className="relative" data-image-mode={drawing ? "annotate" : "view"}>
                <div ref={hostRef} />
                <div className="pointer-events-none absolute inset-0" aria-hidden="true">
                  {annotation.regions.map((region, index) => (
                    <span
                      key={region.id}
                      className="absolute grid place-items-center rounded-full bg-annotation font-semibold text-white"
                      style={{
                        left: Math.max(0, region.x),
                        top: Math.max(0, region.y),
                        width: 24 / scale,
                        height: 24 / scale,
                        fontSize: 12 / scale,
                      }}
                    >
                      {index + 1}
                    </span>
                  ))}
                </div>
              </div>
            </TransformComponent>
          </TransformWrapper>
          {!annotation.ready && (
            <p
              role="status"
              className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted-foreground"
            >
              {annotation.error ?? "正在加载图片…"}
            </p>
          )}
          <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2">
            <ButtonGroup
              variant="toolbar"
              aria-label="图片批注工具"
              className="[&_svg]:size-4 [&_svg]:stroke-[1.75]"
            >
              <Button
                variant="ghost"
                shape="circle"
                size="icon"
                aria-label="查看模式（V）"
                aria-pressed={!drawing}
                onClick={() => setDrawing(false)}
              >
                <MousePointer2 />
              </Button>
              {onFeedback && (
                <Button
                  variant="annotation"
                  shape="circle"
                  size="icon"
                  aria-label="框选批注（R）"
                  title="框选批注（R）"
                  aria-pressed={drawing}
                  disabled={!annotation.ready || busy}
                  onClick={() => setDrawing(!drawing)}
                >
                  <SquareDashedMousePointer />
                </Button>
              )}
              <IconAction
                label="撤销"
                disabled={!annotation.history.undo || busy}
                onClick={annotation.undo}
              >
                <Undo2 />
              </IconAction>
              <IconAction
                label="重做"
                disabled={!annotation.history.redo || busy}
                onClick={annotation.redo}
              >
                <Redo2 />
              </IconAction>
            </ButtonGroup>
          </div>
        </div>
        {onFeedback && (
          <aside
            className="flex w-64 shrink-0 flex-col border-l border-border/50 bg-background max-md:w-56"
            aria-label="图片批注"
          >
            <div className="flex items-center justify-between px-4 py-3">
              <h2 className="text-sm font-medium">批注 · {annotation.regions.length}</h2>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3">
              {!annotation.regions.length && (
                <p className="px-1 py-2 text-xs leading-6 text-muted-foreground">
                  点击框选工具，拖出一个区域，然后填写希望如何调整。
                </p>
              )}
              <ol className="flex flex-col gap-1">
                {annotation.regions.map((region, index) => (
                  <li
                    key={region.id}
                    className={cn(
                      "rounded-lg p-2",
                      annotation.selectedId === region.id && "bg-muted"
                    )}
                  >
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label={`定位批注 ${index + 1}`}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => focusRegion(region)}
                      >
                        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-annotation/10 text-annotation">
                          {index + 1}
                        </span>
                        <span className="truncate">{region.comment || "待填写意见"}</span>
                      </button>
                      <IconAction
                        label={`删除批注 ${index + 1}`}
                        disabled={busy}
                        onClick={() => annotation.remove(region.id)}
                      >
                        <Trash2 />
                      </IconAction>
                    </div>
                    {selected?.id === region.id && (
                      <form
                        className="mt-2 flex flex-col gap-2"
                        onSubmit={(event) => {
                          event.preventDefault()
                          annotation.saveComment(region.id, comment)
                        }}
                      >
                        <Textarea
                          ref={focusComment}
                          aria-label="批注意见"
                          value={comment}
                          maxLength={2000}
                          onChange={(event) =>
                            annotation.updateComment(region.id, event.target.value)
                          }
                          placeholder="描述希望怎么调整…"
                          className="min-h-24 resize-y text-sm"
                          disabled={busy}
                        />
                        <Button
                          type="submit"
                          aria-label="保存批注意见"
                          shape="pill"
                          size="sm"
                          disabled={!comment.trim() || busy}
                        >
                          保存意见
                        </Button>
                      </form>
                    )}
                  </li>
                ))}
              </ol>
            </div>
            <div className="flex flex-col gap-2 p-3">
              <p className="text-xs text-muted-foreground">
                批注自动保存；加入聊天后由你确认发送。
              </p>
              <Button
                shape="pill"
                disabled={
                  busy || !completed.length || completed.length !== annotation.regions.length
                }
                onClick={() =>
                  void perform(async () => {
                    const snapshot = annotation.regions.map((region) => ({ ...region }))
                    const marked = await exportImage(true)
                    await onFeedback(
                      marked,
                      snapshot,
                      annotation.dimensions.width,
                      annotation.dimensions.height
                    )
                  })
                }
              >
                {busy ? "正在处理…" : "加入聊天"}
              </Button>
            </div>
          </aside>
        )}
      </div>
      {(actionError || annotation.error || status) && (
        <p
          role="status"
          className={cn(
            "shrink-0 px-4 py-2 text-xs",
            actionError || annotation.error ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {actionError ?? annotation.error ?? status}
        </p>
      )}
    </section>
  )
}

function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      shape="circle"
      size="icon-sm"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}
