/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, type ReactNode } from "react"
import type { ImageSource } from "./image-source"

const ImageViewerContext = createContext<{ openImage: (source: ImageSource) => void } | null>(null)
export const useImageViewer = () => useContext(ImageViewerContext)

/** 只转发打开请求；图片标签和会话归属统一由右侧 panel 管理。 */
export function ImageViewerProvider({
  children,
  onOpenImage,
}: {
  children: ReactNode
  onOpenImage: (source: ImageSource) => void
}) {
  return (
    <ImageViewerContext.Provider value={{ openImage: onOpenImage }}>
      {children}
    </ImageViewerContext.Provider>
  )
}
