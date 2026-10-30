/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react"
import { imageSourceKey, type ImageGallery, type ImageSource } from "./image-source"

type ImageViewerContextValue = { openImage: (source: ImageSource, gallery?: ImageGallery) => void }
const ImageViewerContext = createContext<ImageViewerContextValue | null>(null)
export const useImageViewer = () => useContext(ImageViewerContext)

/** 只转发打开请求；图片标签和会话归属统一由右侧 panel 管理。 */
export function ImageViewerProvider({
  children,
  onOpenImage,
  scopeId,
}: {
  children: ReactNode
  onOpenImage: (source: ImageSource, gallery?: ImageGallery, expectedPanelScopeId?: string) => void
  scopeId?: string
}) {
  const callback = useRef(onOpenImage)
  useLayoutEffect(() => {
    callback.current = onOpenImage
  }, [onOpenImage])
  const openImage = useCallback(
    (source: ImageSource, gallery?: ImageGallery) => {
      if (scopeId !== undefined) callback.current(source, gallery, scopeId)
      else if (gallery) callback.current(source, gallery)
      else callback.current(source)
    },
    [scopeId]
  )
  const value = useMemo(() => ({ openImage }), [openImage])
  return <ImageViewerContext.Provider value={value}>{children}</ImageViewerContext.Provider>
}

/** Keeps a stable opener while collecting the caller's latest data only when clicked. */
export function ImageGalleryProvider({
  children,
  getGallery,
  readOnly = false,
}: {
  children: ReactNode
  getGallery: () => ImageGallery | undefined
  readOnly?: boolean
}) {
  const parent = useImageViewer()
  const collector = useRef(getGallery)
  useLayoutEffect(() => {
    collector.current = getGallery
  }, [getGallery])
  const openImage = useCallback(
    (source: ImageSource, supplied?: ImageGallery) => {
      if (!parent) return
      const gallery = source.kind === "attachment" ? (supplied ?? collector.current()) : undefined
      const selected = gallery?.sources.find(
        (item) => imageSourceKey(item) === imageSourceKey(source)
      )
      const opened =
        readOnly || selected?.readOnly || (source.kind === "attachment" && !selected)
          ? { ...source, readOnly: true }
          : source
      if (!gallery || !selected) {
        parent.openImage(opened)
        return
      }
      const snapshot =
        readOnly || opened.readOnly || source.draftId !== selected.draftId
          ? {
              ...gallery,
              sources: gallery.sources.map((item) =>
                item === selected ? opened : readOnly ? { ...item, readOnly: true } : item
              ),
            }
          : gallery
      parent.openImage(opened, snapshot)
    },
    [parent, readOnly]
  )
  const value = useMemo(() => (parent ? { openImage } : null), [parent, openImage])
  return <ImageViewerContext.Provider value={value}>{children}</ImageViewerContext.Provider>
}
