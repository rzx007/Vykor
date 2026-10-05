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
  const [regions, setRegions] = useState<ImageRegion[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [history, setHistory] = useState({ undo: false, redo: false })
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let annotator: ImageAnnotator | null = null
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
      .then(([, key]) => {
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
        let saved: ImageRegion[] = []
        try {
          saved = parseImageRegions(localStorage.getItem(key), width, height)
        } catch {
          setError("无法读取批注草稿，本次批注仍可继续")
        }
        annotator.setAnnotations(saved.map(toAnnotation))
        const sync = () => {
          if (disposed || !annotator) return
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
          try {
            if (next.length) localStorage.setItem(key, JSON.stringify(next))
            else localStorage.removeItem(key)
          } catch {
            setError("批注草稿未能保存，关闭窗口前请先加入聊天")
          }
        }
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
      disposed = true
      image.onload = image.onerror = null
      annotator?.destroy()
      annotatorRef.current = null
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
