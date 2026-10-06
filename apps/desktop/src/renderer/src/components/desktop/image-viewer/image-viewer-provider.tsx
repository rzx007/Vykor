/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import { Button } from "@renderer/components/ui/button"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import {
  NEW_CONVERSATION_SCOPE,
  sessionComposerScope,
} from "@renderer/stores/desktop-session/composer-draft-state"
import { isSafeImagePreviewLayout } from "@shared/safe-image-preview"
import { imageFeedbackText } from "./image-annotations"
import { toast } from "@renderer/lib/toast"

const ImageViewer = lazy(() =>
  import("./image-viewer").then((module) => ({ default: module.ImageViewer }))
)
type ImageSource = { name: string; readOnly?: boolean; draftId?: string } & (
  | { assetId: string; bytes?: never; mediaType?: never; path?: never }
  | { bytes: ArrayBuffer; mediaType: string; path?: string; assetId?: never }
)
type OpenImage = {
  request: number
  name: string
  bytes: ArrayBuffer
  mediaType: string
  scope: string
  sessionId: string | null
  assetId?: string
  readOnly?: boolean
  path?: string
}
const ImageViewerContext = createContext<{ openImage: (source: ImageSource) => void } | null>(null)
export const useImageViewer = () => useContext(ImageViewerContext)

export function ImageViewerProvider({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState<OpenImage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)
  const support = useDesktopSessionStore(
    (state) => state.attachmentSupport?.interactionEnabled ?? false
  )
  const close = useCallback(() => {
    requestId.current += 1
    setOpened(null)
    setLoading(false)
    setError(null)
  }, [])
  const openImage = useCallback((source: ImageSource) => {
    const request = ++requestId.current
    const state = useDesktopSessionStore.getState()
    const scope =
      (source.draftId &&
        Object.keys(state.composerDraftsByScope).find((key) =>
          state.composerDraftsByScope[key]?.attachments.some((a) => a.draftId === source.draftId)
        )) ||
      (state.activeSessionId ? sessionComposerScope(state.activeSessionId) : NEW_CONVERSATION_SCOPE)
    setOpened(null)
    setError(null)
    setLoading(true)
    void (async () => {
      const preview = source.assetId
        ? await window.desktop.attachments.readPreview({ assetId: source.assetId })
        : { bytes: source.bytes!, mediaType: source.mediaType! }
      if (request !== requestId.current) return
      if (
        !["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/avif"].includes(
          preview.mediaType
        )
      )
        throw new Error("暂不支持预览这种图片格式")
      setOpened({
        ...preview,
        request,
        name: source.name,
        scope,
        sessionId: state.activeSessionId,
        assetId: source.assetId,
        readOnly: source.readOnly,
        path: source.path,
      })
      setLoading(false)
    })().catch((loadError) => {
      if (request === requestId.current) {
        setError(loadError instanceof Error ? loadError.message : "无法读取图片")
        setLoading(false)
      }
    })
  }, [])
  return (
    <ImageViewerContext.Provider value={{ openImage }}>
      {children}
      <Dialog
        open={Boolean(opened || loading || error)}
        onOpenChange={(open) => {
          if (!open) close()
        }}
      >
        <DialogContent
          className="flex h-[min(90dvh,1040px)] w-[min(94vw,1600px)] max-w-none! flex-col gap-0 overflow-hidden rounded-2xl bg-transparent p-0 shadow-none ring-0"
          overlayClassName="bg-background/40 supports-backdrop-filter:backdrop-blur-none"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">{opened?.name ?? "图片查看器"}</DialogTitle>
          <DialogDescription className="sr-only">
            缩放图片，框选区域填写意见，然后加入聊天草稿。
          </DialogDescription>
          {opened ? (
            <Suspense
              fallback={
                <p role="status" className="m-auto text-sm text-muted-foreground">
                  正在加载查看器…
                </p>
              }
            >
              <ImageViewer
                key={opened.request}
                bytes={opened.bytes}
                mediaType={opened.mediaType}
                name={opened.name}
                onClose={close}
                onOpenOriginal={
                  opened.assetId
                    ? () => window.desktop.attachments.open({ assetId: opened.assetId! })
                    : undefined
                }
                onFeedback={
                  !opened.readOnly && support
                    ? async (marked, regions, width, height) => {
                        if (!isSafeImagePreviewLayout({ width, height, frames: 1 }))
                          throw new Error("图片太大，无法生成批注附件")
                        const bytes = await marked.arrayBuffer()
                        if (opened.request !== requestId.current) return
                        const state = useDesktopSessionStore.getState()
                        if (state.activeSessionId !== opened.sessionId)
                          throw new Error("当前聊天已变化，请重新打开图片后加入批注")
                        await state.addImageFeedback(opened.scope, {
                          original: {
                            bytes: opened.bytes,
                            mediaType: opened.mediaType,
                            displayName: opened.name,
                          },
                          marked: {
                            bytes,
                            mediaType: "image/png",
                            displayName: `${opened.name.replace(/\.[^.]+$/, "")}-批注.png`,
                          },
                          originalAssetId: opened.assetId,
                          text: imageFeedbackText(
                            opened.path ?? opened.name,
                            regions,
                            width,
                            height
                          ),
                        })
                        close()
                        toast.success("图片和批注已加入聊天草稿")
                      }
                    : undefined
                }
              />
            </Suspense>
          ) : (
            <div className="m-auto flex flex-col items-center gap-3">
              <p role="status" className={error ? "text-destructive" : "text-muted-foreground"}>
                {error ?? "正在读取图片…"}
              </p>
              <Button variant="ghost" shape="pill" onClick={close}>
                关闭
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </ImageViewerContext.Provider>
  )
}
