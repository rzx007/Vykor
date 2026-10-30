// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import {
  ImageViewerProvider,
  useImageViewer,
} from "@renderer/components/desktop/image-viewer/image-viewer-provider"
import { ConversationTranscript } from "../transcript"
import type { DesktopAttachmentSessionPart, DesktopSessionMessage } from "@shared/session-types"

// The virtual viewport mounts one image; the transcript still owns all loaded records.
vi.mock("../virtual-transcript", () => ({ VirtualTranscript: () => <ImageProbe /> }))
function ImageProbe() {
  const viewer = useImageViewer()
  return (
    <button
      type="button"
      onClick={() =>
        viewer?.openImage({ kind: "attachment", assetId: "visible", name: "visible.png" })
      }
    >
      visible image
    </button>
  )
}
const message = (id: string, seq: number): DesktopSessionMessage => ({
  id,
  seq,
  sessionId: "actual-side",
  role: "user",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
})
const part = (assetId: string, messageId: string): DesktopAttachmentSessionPart => ({
  id: assetId,
  assetId,
  messageId,
  sessionId: "actual-side",
  seq: 1,
  type: "attachment",
  status: "completed",
  intent: "vision",
  displayName: `${assetId}.png`,
  mediaType: "image/png",
  sizeBytes: 1,
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
})
afterEach(() => vi.unstubAllGlobals())

it.each([undefined, "session:actual-side"])(
  "uses the transcript's real session and loaded offscreen images with composer scope %s",
  async (imageComposerScope) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    const container = document.createElement("div"),
      root = createRoot(container),
      onOpenImage = vi.fn()
    document.body.append(container)
    try {
      await act(async () =>
        root.render(
          <ImageViewerProvider scopeId="panel:main" onOpenImage={onOpenImage}>
            <ConversationTranscript
              messages={[message("visible-message", 2), message("offscreen-message", 1)]}
              parts={[part("visible", "visible-message"), part("offscreen", "offscreen-message")]}
              imageComposerScope={imageComposerScope}
              runs={[]}
              running={false}
              canEditLastUserMessage={false}
              onEditLastUserMessage={vi.fn()}
              onCopyAssistantMessage={vi.fn()}
              onOpenFile={vi.fn()}
              canOpenReview={false}
              onOpenReview={vi.fn()}
              onOpenTerminal={vi.fn()}
            />
          </ImageViewerProvider>
        )
      )
      expect(onOpenImage).not.toHaveBeenCalled()
      expect(container.querySelectorAll("button")).toHaveLength(1)
      await act(async () => container.querySelector("button")!.click())
      const [source, gallery, panelScope] = onOpenImage.mock.calls[0]!
      expect(gallery?.id).toBe("conversation:actual-side")
      expect(gallery?.composerScope).toBe(imageComposerScope)
      expect(gallery?.sources.map((source: { assetId: string }) => source.assetId)).toEqual([
        "offscreen",
        "visible",
      ])
      expect(source.assetId).toBe("visible")
      if (!imageComposerScope) expect(source.readOnly).toBe(true)
      expect(panelScope).toBe("panel:main")
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  }
)
