import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import {
  ChevronDown,
  Copy,
  FileImage,
  MessageCirclePlus,
  Send,
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
import { ExpandableActionBar } from "@renderer/components/motion/expandable-action-bar"
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover"
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
  onClose?: () => void
  onFeedback?: (
    marked: Blob,
    regions: ImageRegion[],
    width: number,
    height: number
  ) => Promise<void>
  onOpenOriginal?: () => Promise<unknown>
}) {
  const [drawing, setDrawing] = useState(false)
  const [commentsOpen, setCommentsOpen] = useState(false)
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
    drawing && Boolean(onFeedback),
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
          (size.height - 160) / annotation.dimensions.height
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
          (box.height - 160) / annotation.dimensions.height
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

  const panelOpen = commentsOpen || Boolean(selected)
  const closeComments = () => {
    annotation.cancelSelection()
    setCommentsOpen(false)
  }
  const submitFeedback = () => {
    if (!onFeedback) return
    void perform(async () => {
      const snapshot = annotation.regions.map((region) => ({ ...region }))
      const marked = await exportImage(true)
      await onFeedback(marked, snapshot, annotation.dimensions.width, annotation.dimensions.height)
    })
  }

  return (
    <section
      className="image-annotation-viewer relative h-full min-h-0 overflow-hidden bg-muted/40 text-foreground select-none"
      aria-label="图片查看与批注"
      onKeyDownCapture={(event) => {
        const editing = (event.target as HTMLElement).closest(
          "textarea,input,[contenteditable=true]"
        )
        const modifier = event.ctrlKey || event.metaKey
        if (editing) {
          if (modifier && event.key === "Enter" && selected && comment.trim()) {
            event.preventDefault()
            event.stopPropagation()
            annotation.saveComment(selected.id, comment)
          } else if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            closeComments()
          }
          return
        }
        if (modifier && ["z", "y"].includes(event.key.toLowerCase())) {
          event.preventDefault()
          event.stopPropagation()
          if (event.shiftKey || event.key.toLowerCase() === "y") annotation.redo()
          else annotation.undo()
        } else if (event.key === "Escape" && (drawing || panelOpen)) {
          event.preventDefault()
          event.stopPropagation()
          closeComments()
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
      <div
        ref={viewport}
        className="absolute inset-0 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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
              <div ref={hostRef} data-image-sheet="" />
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
      </div>

      <header className="pointer-events-none absolute inset-x-4 top-4 z-20 flex items-start justify-between gap-3 select-none [&_svg]:size-4 [&_svg]:stroke-[1.75]">
        <div
          title={name}
          className="flex h-9 max-w-64 min-w-0 items-center gap-2 rounded-full bg-popover px-3 text-[13px] text-popover-foreground shadow-control"
        >
          <FileImage className="shrink-0" />
          <span className="truncate">图片</span>
        </div>
        <div className="pointer-events-auto flex shrink-0 items-center gap-2">
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="control"
                  shape="pill"
                  size="lg"
                  className="h-9 gap-1.5 tabular-nums"
                />
              }
              aria-label="图片缩放"
            >
              {Math.round(scale * 100)}%<ChevronDown />
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={8} className="w-56 rounded-2xl p-3">
              <div className="flex items-center justify-between">
                <IconAction
                  label="缩小（-）"
                  onClick={() => transform.current?.zoomOut(0.25, duration)}
                >
                  <ZoomOut />
                </IconAction>
                <span className="text-sm tabular-nums">{Math.round(scale * 100)}%</span>
                <IconAction
                  label="放大（+）"
                  onClick={() => transform.current?.zoomIn(0.25, duration)}
                >
                  <ZoomIn />
                </IconAction>
              </div>
              <Button variant="ghost" shape="pill" size="sm" onClick={fit}>
                <Maximize />
                适应窗口
              </Button>
              <Button
                variant="ghost"
                shape="pill"
                size="sm"
                onClick={() => transform.current?.centerView(1, duration)}
              >
                原始尺寸 · 100%
              </Button>
            </PopoverContent>
          </Popover>
          {onOpenOriginal && (
            <Button
              variant="control"
              shape="pill"
              size="lg"
              className="h-9"
              onClick={() =>
                void perform(async () => {
                  await onOpenOriginal()
                })
              }
            >
              <ExternalLink />
              打开
            </Button>
          )}
          <ButtonGroup variant="toolbar" aria-label="图片快捷操作">
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
          </ButtonGroup>
          {onClose && (
            <Button
              variant="control"
              shape="circle"
              size="icon"
              className="size-9"
              aria-label="关闭图片查看器"
              title="关闭"
              onClick={onClose}
            >
              <X />
            </Button>
          )}
        </div>
      </header>

      {!annotation.ready && (
        <p
          role="status"
          className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted-foreground"
        >
          {annotation.error ?? "正在加载图片…"}
        </p>
      )}

      {onFeedback && panelOpen && (
        <aside
          aria-label="图片批注"
          className="absolute top-20 right-4 z-20 flex max-h-[calc(100%-11rem)] w-80 max-w-[calc(100%-2rem)] flex-col rounded-2xl bg-popover text-popover-foreground shadow-md"
        >
          <div className="flex shrink-0 items-center justify-between px-4 py-3">
            <h2 className="text-sm font-medium">批注 · {annotation.regions.length}</h2>
            <IconAction label="收起批注" onClick={closeComments}>
              <X />
            </IconAction>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            {!annotation.regions.length ? (
              <div className="flex flex-col gap-3 px-1 py-2">
                <p className="text-[13px] leading-6 text-muted-foreground">
                  框选图片中的区域，写下希望怎么改。
                </p>
                <Button
                  variant="annotation"
                  shape="pill"
                  onClick={() => {
                    setDrawing(true)
                    setCommentsOpen(false)
                  }}
                >
                  <SquareDashedMousePointer />
                  添加第一条批注
                </Button>
              </div>
            ) : (
              <ol className="flex flex-col gap-1">
                {annotation.regions.map((region, index) => (
                  <li
                    key={region.id}
                    className={cn(
                      "rounded-xl p-2.5",
                      annotation.selectedId === region.id && "bg-muted/70"
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        aria-label={"定位批注 " + (index + 1)}
                        className="flex min-w-0 flex-1 items-start gap-2 rounded text-left text-[13px] leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => focusRegion(region)}
                      >
                        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-annotation/10 text-xs font-medium text-annotation">
                          {index + 1}
                        </span>
                        <span className="min-w-0 break-words">
                          {region.comment || "待填写意见"}
                        </span>
                      </button>
                      <IconAction
                        label={"删除批注 " + (index + 1)}
                        disabled={busy}
                        onClick={() => annotation.remove(region.id)}
                      >
                        <Trash2 />
                      </IconAction>
                    </div>
                    {selected?.id === region.id && (
                      <form
                        className="mt-3 flex flex-col gap-2"
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
                          className="min-h-28 resize-y bg-background text-sm select-text"
                          disabled={busy}
                        />
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs text-muted-foreground">Ctrl / ⌘ + Enter</span>
                          <Button
                            type="submit"
                            aria-label="保存批注意见"
                            shape="pill"
                            size="sm"
                            disabled={!comment.trim() || busy}
                          >
                            完成
                          </Button>
                        </div>
                      </form>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
          <p className="shrink-0 px-4 pb-4 text-xs text-muted-foreground">
            草稿自动保存，加入聊天后由你确认发送。
          </p>
        </aside>
      )}

      {drawing && !panelOpen && (
        <p className="pointer-events-none absolute bottom-24 left-1/2 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-full bg-popover px-4 py-2 text-[13px] text-popover-foreground shadow-control">
          拖动框选区域，写下希望怎么改
        </p>
      )}

      <div
        role="toolbar"
        aria-label="图片批注工具"
        className="image-viewer-actions absolute inset-x-4 bottom-6 z-20 flex justify-center"
      >
        <ExpandableActionBar
          expanded
          expandOnHover={false}
          expandOnFocus={false}
          classNames={{
            root: "max-w-full",
            track:
              "rounded-2xl border-0 bg-foreground p-1.5 shadow-control backdrop-blur-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            item: "h-9 min-w-9 rounded-xl px-3 text-background/80 hover:text-background focus-visible:text-background focus-visible:ring-2 focus-visible:ring-background/60 [&>span.absolute]:bg-background/12",
            activeItem: "bg-background/12 text-background",
            icon: "[&_svg]:size-4 [&_svg]:stroke-[1.75]",
            label: "text-[13px]",
            badge: "bg-background/15 text-background",
          }}
          items={[
            {
              id: "view",
              label: "浏览",
              icon: <MousePointer2 />,
              active: !drawing,
              onClick: () => setDrawing(false),
            },
            ...(onFeedback
              ? [
                  {
                    id: "annotate",
                    label: "添加批注",
                    icon: <SquareDashedMousePointer />,
                    active: drawing,
                    disabled: !annotation.ready || busy,
                    onClick: () => setDrawing(!drawing),
                  },
                  {
                    id: "comments",
                    label: "批注",
                    icon: <MessageCirclePlus />,
                    active: panelOpen,
                    badge: annotation.regions.length || undefined,
                    onClick: () => (panelOpen ? closeComments() : setCommentsOpen(true)),
                  },
                ]
              : []),
            {
              id: "undo",
              label: "撤销",
              icon: <Undo2 />,
              disabled: !annotation.history.undo || busy,
              onClick: annotation.undo,
            },
            {
              id: "redo",
              label: "重做",
              icon: <Redo2 />,
              disabled: !annotation.history.redo || busy,
              onClick: annotation.redo,
            },
            ...(onFeedback
              ? [
                  {
                    id: "feedback",
                    label: busy ? "正在处理…" : "加入聊天",
                    icon: <Send />,
                    disabled:
                      busy || !completed.length || completed.length !== annotation.regions.length,
                    onClick: submitFeedback,
                  },
                ]
              : []),
          ]}
        />
      </div>

      {(actionError || annotation.error || status) && (
        <p
          role="status"
          className={cn(
            "absolute bottom-24 left-4 z-30 max-w-[calc(100%-2rem)] rounded-lg bg-popover px-3 py-2 text-[13px] shadow-control",
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
      size="icon"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="size-8 [&_svg]:size-4 [&_svg]:stroke-[1.75]"
    >
      {children}
    </Button>
  )
}
