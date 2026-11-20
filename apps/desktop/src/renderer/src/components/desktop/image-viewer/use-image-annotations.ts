import { recoveryRecord, registerBusinessDataFlusher } from "@renderer/lib/business-data"
import { useEffect, useRef, useState } from "react"
import {
  createImageAnnotator,
  ShapeType,
  UserSelectAction,
  type ImageAnnotation,
  type ImageAnnotator,
  type Rectangle,
} from "@annotorious/annotorious"
import { imageAnnotationKey, parseImageRegions, type ImageRegion } from "./image-annotations"
import { isSafeImagePreviewLayout } from "@shared/safe-image-preview"

const DRAFT_SAVE_ERROR = "批注草稿未能保存，关闭窗口前请先加入聊天"

function toAnnotation(region: ImageRegion): ImageAnnotation {
  const geometry: Rectangle["geometry"] = {
    bounds: {
      minX: region.x,
      minY: region.y,
      maxX: region.x + region.width,
      maxY: region.y + region.height,
    },
    x: region.x,
    y: region.y,
    w: region.width,
    h: region.height,
    rot: 0,
  }
  return {
    id: region.id,
    bodies: [
      {
        id: `${region.id}:comment`,
        annotation: region.id,
        purpose: "commenting",
        value: region.comment,
      },
    ],
    target: {
      annotation: region.id,
      selector: {
        type: ShapeType.RECTANGLE,
        geometry,
      },
    },
  }
}

export function useImageAnnotations(
  bytes: ArrayBuffer,
  url: string | undefined,
  name: string,
  drawing: boolean,
  mediaType: string
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const annotatorRef = useRef<ImageAnnotator | null>(null)
  const flushDraftRef = useRef<(() => Promise<boolean>) | null>(null)
  const [regions, setRegions] = useState<ImageRegion[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [history, setHistory] = useState({ undo: false, redo: false })
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    setReady(false)
    let disposed = false
    let annotator: ImageAnnotator | null = null
    let unregisterFlush: (() => void) | undefined
    const image = document.createElement("img")
    const objectUrl = url ?? URL.createObjectURL(new Blob([bytes], { type: mediaType }))
    image.alt = name
    image.draggable = false
    imageRef.current = image
    host.append(image)
    const load = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error("无法显示这张图片"))
      image.src = objectUrl
    })
    void Promise.all([load, imageAnnotationKey(bytes)])
      .then(async ([, key]) => {
        if (disposed) return
        const width = image.naturalWidth,
          height = image.naturalHeight
        if (!isSafeImagePreviewLayout({ width, height, frames: 1 }))
          throw new Error("图片太大，无法直接批注")
        image.style.width = `${width}px`
        image.style.height = `${height}px`
        setDimensions({ width, height })
        annotator = createImageAnnotator(image, { autoSave: true, drawingEnabled: false })
        annotator.setDrawingTool("rectangle")
        annotatorRef.current = annotator
        const storage = recoveryRecord({
          kind: "image-annotations",
          imageKey: key.slice("vykor-image-annotations-v1:".length),
        })
        let raw: string | null = null
        try {
          raw = localStorage.getItem(key)
        } catch {
          setError("无法读取旧批注草稿，本次批注仍可继续")
        }
        if (raw) {
          let value: unknown
          try {
            value = JSON.parse(raw)
          } catch {
            throw new Error("无法读取批注草稿")
          }
          await storage.importLegacy(raw, value)
        }
        const saved = parseImageRegions(
          JSON.stringify((await storage.read())?.value ?? []),
          width,
          height
        )
        if (disposed) return
        annotator.setAnnotations(saved.map(toAnnotation))
        let lastSaved = JSON.stringify(saved)
        let lastQueued = lastSaved
        let failedSave = false
        const sync = (): boolean => {
          if (disposed || !annotator) return false
          const next = annotator
            .getAnnotations()
            .map((annotation) => {
              const bounds = annotation.target.selector.geometry.bounds
              const x = Math.max(0, Math.min(width, bounds.minX)),
                y = Math.max(0, Math.min(height, bounds.minY))
              return {
                id: annotation.id,
                x,
                y,
                width: Math.max(0, Math.min(width, bounds.maxX) - x),
                height: Math.max(0, Math.min(height, bounds.maxY) - y),
                comment:
                  annotation.bodies.find((body) => body.purpose === "commenting")?.value ?? "",
              }
            })
            .filter((region) => region.width > 0 && region.height > 0)
          setRegions(next)
          setHistory({ undo: annotator.canUndo(), redo: annotator.canRedo() })
          const serialized = JSON.stringify(next)
          if (serialized === lastQueued && !failedSave) {
            setError((current) => (current === DRAFT_SAVE_ERROR ? null : current))
            return serialized === lastSaved
          }
          lastQueued = serialized
          void storage
            .write(next)
            .then(() => {
              lastSaved = serialized
              failedSave = false
              if (!disposed) setError((current) => (current === DRAFT_SAVE_ERROR ? null : current))
            })
            .catch(() => {
              failedSave = true
              if (!disposed) setError(DRAFT_SAVE_ERROR)
            })
          return false
        }
        const flush = async () => {
          // A completed earlier write must not acknowledge a newer edit, including undo to A.
          do {
            sync()
            await storage.flush()
            if (disposed) throw new Error("图片编辑器已关闭")
          } while (!sync())
        }
        flushDraftRef.current = async () => {
          try {
            await flush()
            return true
          } catch {
            return false
          }
        }
        unregisterFlush = registerBusinessDataFlusher(flush)
        annotator.state.store.observe(sync)
        annotator.on("selectionChanged", (selection) => {
          if (!disposed) setSelectedId(selection[0]?.id ?? null)
        })
        sync()
        setReady(true)
      })
      .catch((loadError) => {
        if (!disposed) setError(String(loadError.message ?? loadError))
      })
    return () => {
      unregisterFlush?.()
      disposed = true
      image.onload = image.onerror = null
      annotator?.destroy()
      annotatorRef.current = null
      flushDraftRef.current = null
      imageRef.current = null
      host.replaceChildren()
      if (!url) URL.revokeObjectURL(objectUrl)
    }
  }, [bytes, url, name, mediaType])

  useEffect(() => {
    const annotator = annotatorRef.current
    if (!annotator || !ready) return
    annotator.setDrawingEnabled(drawing && regions.length < 100)
    annotator.setUserSelectAction(drawing ? UserSelectAction.EDIT : UserSelectAction.SELECT)
    if (!drawing) annotator.cancelDrawing()
  }, [drawing, ready, regions.length])

  return {
    hostRef,
    imageRef,
    regions,
    dimensions,
    ready,
    error,
    history,
    selectedId,
    async flushDraft() {
      return await (flushDraftRef.current?.() ?? Promise.resolve(true))
    },
    select(id: string) {
      annotatorRef.current?.setSelected(id)
    },
    cancelSelection() {
      annotatorRef.current?.cancelDrawing()
      annotatorRef.current?.cancelSelected()
    },
    updateComment(id: string, comment: string) {
      const annotator = annotatorRef.current
      const annotation = annotator?.getAnnotationById(id)
      if (!annotator || !annotation) return
      annotator.updateAnnotation({
        ...annotation,
        bodies: [
          {
            id: `${id}:comment`,
            annotation: id,
            purpose: "commenting",
            value: comment.slice(0, 2000),
          },
        ],
      })
    },
    saveComment(id: string, comment: string) {
      const annotator = annotatorRef.current
      const annotation = annotator?.getAnnotationById(id)
      if (!annotator || !annotation || !comment.trim()) return
      annotator.updateAnnotation({
        ...annotation,
        bodies: [
          {
            id: `${id}:comment`,
            annotation: id,
            purpose: "commenting",
            value: comment.trim().slice(0, 2000),
          },
        ],
      })
      annotator.cancelSelected()
    },
    remove(id: string) {
      annotatorRef.current?.removeAnnotation(id)
    },
    undo() {
      const annotator = annotatorRef.current
      if (!annotator) return
      annotator.undo()
      // 库在通知数据变化后才移动历史指针，操作结束后再同步按钮状态。
      setHistory({ undo: annotator.canUndo(), redo: annotator.canRedo() })
    },
    redo() {
      const annotator = annotatorRef.current
      if (!annotator) return
      annotator.redo()
      setHistory({ undo: annotator.canUndo(), redo: annotator.canRedo() })
    },
  }
}
