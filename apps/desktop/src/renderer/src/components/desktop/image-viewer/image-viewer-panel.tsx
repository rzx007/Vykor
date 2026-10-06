import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import {
  NEW_CONVERSATION_SCOPE,
  sessionComposerScope,
} from "@renderer/stores/desktop-session/composer-draft-state"
import { readImageSource, type ImageSource } from "./image-source"
import { imageFeedbackText } from "./image-annotations"
import type { DesktopAttachmentPreview } from "@shared/attachment-types"
import { toast } from "@renderer/lib/toast"

const ImageViewer = lazy(() =>
  import("./image-viewer").then((module) => ({ default: module.ImageViewer }))
)

/** 当前图片标签的加载和草稿衔接。面板继续管理标签、关闭及会话隔离。 */
export function ImageViewerPanel({ source, scopeId }: { source: ImageSource; scopeId: string }) {
  const [loaded, setLoaded] = useState<{
    source: ImageSource
    request: number
    preview?: DesktopAttachmentPreview
    error?: string
  } | null>(null)
  const version = useRef(0)
  const support = useDesktopSessionStore(
    (state) => state.attachmentSupport?.interactionEnabled ?? false
  )
  useEffect(() => {
    const request = ++version.current
    void readImageSource(source)
      .then((preview) => {
        if (request === version.current) setLoaded({ source, request, preview })
      })
      .catch((error) => {
        if (request === version.current)
          setLoaded({
            source,
            request,
            error: error instanceof Error ? error.message : "无法读取图片",
          })
      })
    return () => {
      version.current += 1
    }
  }, [source])
  if (loaded?.source !== source || !loaded.preview) {
    return (
      <div
        role="status"
        className="grid h-full place-items-center px-4 text-sm text-muted-foreground"
      >
        {loaded?.source === source && loaded.error ? loaded.error : "正在读取图片…"}
      </div>
    )
  }
  const preview = loaded.preview
  return (
    <Suspense
      fallback={
        <div role="status" className="grid h-full place-items-center text-sm text-muted-foreground">
          正在加载查看器…
        </div>
      }
    >
      <ImageViewer
        bytes={preview.bytes}
        mediaType={preview.mediaType}
        name={source.name}
        onOpenOriginal={
          source.kind === "attachment"
            ? () => window.desktop.attachments.open({ assetId: source.assetId })
            : undefined
        }
        onFeedback={
          !source.readOnly && support
            ? async (marked, regions, width, height) => {
                const request = loaded.request
                if (request !== version.current) return
                const state = useDesktopSessionStore.getState()
                const sessionId = state.activeSessionId
                const ownsSession = sessionId
                  ? scopeId === sessionComposerScope(sessionId)
                  : scopeId.startsWith("draft:")
                if (!ownsSession) throw new Error("当前聊天已变化，请重新打开图片后加入批注")
                // 图片来源与聊天草稿分开：只有从待发送附件打开时，才跟随那份草稿。
                const scope =
                  (source.draftId &&
                    Object.keys(state.composerDraftsByScope).find((key) =>
                      state.composerDraftsByScope[key]?.attachments.some(
                        (a) => a.draftId === source.draftId
                      )
                    )) ||
                  (sessionId ? sessionComposerScope(sessionId) : NEW_CONVERSATION_SCOPE)
                const bytes = await marked.arrayBuffer()
                if (request !== version.current) return
                const current = useDesktopSessionStore.getState()
                if (current.activeSessionId !== sessionId)
                  throw new Error("当前聊天已变化，请重新打开图片后加入批注")
                await current.addImageFeedback(scope, {
                  original: {
                    bytes: preview.bytes,
                    mediaType: preview.mediaType,
                    displayName: source.name,
                  },
                  marked: {
                    bytes,
                    mediaType: "image/png",
                    displayName: `${source.name.replace(/\.[^.]+$/, "")}-批注.png`,
                  },
                  originalAssetId: source.kind === "attachment" ? source.assetId : undefined,
                  text: imageFeedbackText(
                    source.kind === "file" ? source.path : source.name,
                    regions,
                    width,
                    height
                  ),
                })
                // 保留右侧预览，用户可以在左侧编辑草稿、继续对照图片。
                toast.success("图片和批注已加入聊天草稿")
              }
            : undefined
        }
      />
    </Suspense>
  )
}
