// @vitest-environment jsdom
import { act, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { ImageViewer } from "../image-viewer"
import type { ImageSource } from "../image-source"
import type { DesktopAttachmentPreview } from "@shared/attachment-types"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { resetDesktopSessionStore } from "@renderer/stores/desktop-session/store-test-fixtures"

// 原生图片编辑器已在 image-viewer.test.tsx 测试。这里只驱动它交给面板的导出回调。
const editor = vi.hoisted(() => ({ props: null as ComponentProps<typeof ImageViewer> | null }))
vi.mock("../image-viewer", () => ({
  ImageViewer: (props: ComponentProps<typeof ImageViewer>) => {
    editor.props = props
    return null
  },
}))
import { ImageViewerPanel } from "../image-viewer-panel"

let root: Root
let host: HTMLDivElement
const readPreview = vi.fn<(input: { assetId: string }) => Promise<DesktopAttachmentPreview>>()
const openOriginal = vi.fn(async () => {})
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  resetDesktopSessionStore()
  useDesktopSessionStore.setState({
    activeSessionId: "one",
    attachmentSupport: {
      daemonSupported: true,
      interactionEnabled: true,
      limits: null,
      uploadModes: ["single"],
    },
  })
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      attachments: { uploadClipboardImage: vi.fn(async () => {}), readPreview, open: openOriginal },
    },
  })
  readPreview.mockReset()
  openOriginal.mockClear()
  host = document.createElement("div")
  root = createRoot(host)
  editor.props = null
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})

async function mount(
  source: ImageSource = {
    kind: "memory",
    id: "capture-1",
    name: "页面截图.png",
    bytes: new Uint8Array([1]).buffer,
    mediaType: "image/png",
  }
) {
  await act(async () => root.render(<ImageViewerPanel scopeId="session:one" source={source} />))
  await act(async () => {
    await vi.waitFor(() => expect(editor.props).not.toBeNull())
  })
}
const marked = { arrayBuffer: async () => new Uint8Array([2]).buffer } as Blob
const regions = [{ id: "r1", x: 20, y: 10, width: 40, height: 30, comment: "增加间距" }]

const attachment: ImageSource = { kind: "attachment", assetId: "image-one", name: "design.png" }
const preview: DesktopAttachmentPreview = {
  bytes: new Uint8Array([1]).buffer,
  mediaType: "image/png",
}

function deferredPreview() {
  let resolve!: (value: DesktopAttachmentPreview) => void
  const promise = new Promise<DesktopAttachmentPreview>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function retryButton(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="重新读取图片"]')
  expect(button).not.toBeNull()
  return button!
}

it("retries an attachment read failure without exposing internal details and keeps its original image action", async () => {
  readPreview
    .mockRejectedValueOnce(new Error("IPC readPreview failed at D:/private/image-one.png"))
    .mockResolvedValueOnce(preview)
  await act(async () => root.render(<ImageViewerPanel scopeId="session:one" source={attachment} />))
  expect(host.textContent).toContain("无法读取图片")
  expect(host.textContent).not.toContain("IPC")
  expect(host.textContent).not.toContain("D:/private")
  await act(async () => retryButton().click())
  expect(readPreview).toHaveBeenCalledTimes(2)
  expect(readPreview).toHaveBeenLastCalledWith({ assetId: "image-one" })
  expect(editor.props?.bytes).toBe(preview.bytes)
  expect(editor.props?.name).toBe("design.png")
  await editor.props!.onOpenOriginal!()
  expect(openOriginal).toHaveBeenCalledExactlyOnceWith({ assetId: "image-one" })
})

it("explains unsupported image formats without offering a read retry", async () => {
  readPreview.mockResolvedValue({ bytes: preview.bytes, mediaType: "image/svg+xml" })
  await act(async () => root.render(<ImageViewerPanel scopeId="session:one" source={attachment} />))
  expect(host.textContent).toContain("暂不支持预览这种图片格式")
  expect(host.querySelector("button")).toBeNull()
  expect(readPreview).toHaveBeenCalledExactlyOnceWith({ assetId: "image-one" })
  expect(editor.props).toBeNull()
})

it.each([
  ["DesktopAttachmentServiceError: 这种文件不能直接预览。", "暂不支持预览这种图片格式"],
  ["Error: 图片太大，无法直接预览。", "图片太大，无法直接预览。"],
])(
  "does not retry a host preview restriction after IPC serializes its error: %s",
  async (reason, message) => {
    readPreview.mockRejectedValue(
      new Error(`Error invoking remote method 'attachment:read-preview': ${reason}`)
    )
    await act(async () =>
      root.render(<ImageViewerPanel scopeId="session:one" source={attachment} />)
    )
    expect(host.textContent).toContain(message)
    expect(host.textContent).not.toContain("Error invoking remote method")
    expect(host.querySelector("button")).toBeNull()
    expect(readPreview).toHaveBeenCalledTimes(1)
  }
)

it("starts only one request for repeated retry clicks and clears the previous error while reading", async () => {
  const pending = deferredPreview()
  readPreview.mockRejectedValueOnce(new Error("offline")).mockReturnValueOnce(pending.promise)
  await act(async () => root.render(<ImageViewerPanel scopeId="session:one" source={attachment} />))
  const retry = retryButton()
  await act(async () => {
    retry.click()
    retry.click()
  })
  expect(readPreview).toHaveBeenCalledTimes(2)
  expect(host.textContent).toContain("正在读取图片")
  expect(host.textContent).not.toContain("无法读取图片")
  expect(host.querySelector("button")).toBeNull()
  await act(async () => pending.resolve(preview))
  expect(editor.props?.bytes).toBe(preview.bytes)
})

it("ignores a late retry response after another image source is opened", async () => {
  const pending = deferredPreview()
  const nextPreview = { bytes: new Uint8Array([2]).buffer, mediaType: "image/png" }
  readPreview
    .mockRejectedValueOnce(new Error("offline"))
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(nextPreview)
  await act(async () => root.render(<ImageViewerPanel scopeId="session:one" source={attachment} />))
  await act(async () => retryButton().click())
  const next: ImageSource = { kind: "attachment", assetId: "image-two", name: "next.png" }
  await act(async () => root.render(<ImageViewerPanel scopeId="session:one" source={next} />))
  expect(editor.props?.bytes).toBe(nextPreview.bytes)
  await act(async () => pending.resolve(preview))
  expect(editor.props?.bytes).toBe(nextPreview.bytes)
  expect(editor.props?.name).toBe("next.png")
  expect(host.querySelector('[role="status"]')).toBeNull()
  await editor.props!.onOpenOriginal!()
  expect(openOriginal).toHaveBeenCalledExactlyOnceWith({ assetId: "image-two" })
  expect(useDesktopSessionStore.getState().composerDraftsByScope).toEqual({})
})

it("invalidates a pending retry when the same source moves to another chat scope", async () => {
  const pending = deferredPreview()
  const currentPreview = { bytes: new Uint8Array([3]).buffer, mediaType: "image/png" }
  readPreview
    .mockRejectedValueOnce(new Error("offline"))
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(currentPreview)
  await act(async () => root.render(<ImageViewerPanel scopeId="session:one" source={attachment} />))
  await act(async () => retryButton().click())
  await act(async () => {
    useDesktopSessionStore.setState({ activeSessionId: "two" })
    root.render(<ImageViewerPanel scopeId="session:two" source={attachment} />)
  })
  expect(readPreview).toHaveBeenCalledTimes(3)
  expect(editor.props?.bytes).toBe(currentPreview.bytes)
  await act(async () => pending.resolve(preview))
  expect(editor.props?.bytes).toBe(currentPreview.bytes)
  expect(host.querySelector('[role="status"]')).toBeNull()
  expect(useDesktopSessionStore.getState().composerDraftsByScope).toEqual({})
})

it("ignores a pending retry after its image tab closes", async () => {
  const pending = deferredPreview()
  readPreview.mockRejectedValueOnce(new Error("offline")).mockReturnValueOnce(pending.promise)
  await act(async () => root.render(<ImageViewerPanel scopeId="session:one" source={attachment} />))
  await act(async () => retryButton().click())
  await act(async () => root.render(null))
  await act(async () => pending.resolve(preview))
  expect(editor.props).toBeNull()
  expect(useDesktopSessionStore.getState().composerDraftsByScope).toEqual({})
})

it("keeps the project file path in feedback and adds it to the current chat draft", async () => {
  await mount({
    kind: "file",
    path: "D:/project/design.png",
    name: "design.png",
    bytes: new Uint8Array([1]).buffer,
    mediaType: "image/png",
  })
  await act(async () => editor.props!.onFeedback!(marked, regions, 200, 100))
  const draft = useDesktopSessionStore.getState().composerDraftsByScope["session:one"]!
  expect(draft.attachments.map((a) => a.displayName)).toEqual(["design.png", "design-批注.png"])
  expect(draft.document.items).toEqual([
    { type: "text", text: expect.stringContaining("D:/project/design.png") },
  ])
})

it("puts exported screenshot feedback into the left composer and keeps the image open", async () => {
  await mount()
  await act(async () => editor.props!.onFeedback!(marked, regions, 200, 100))
  const draft = useDesktopSessionStore.getState().composerDraftsByScope["session:one"]!
  expect(draft.attachments.map((a) => a.displayName)).toEqual(["页面截图.png", "页面截图-批注.png"])
  expect(draft.document.items).toEqual([
    { type: "text", text: expect.stringContaining("增加间距") },
  ])
  expect(editor.props!.onClose).toBeUndefined()
})

it("never routes a still-open image export into another conversation", async () => {
  await mount()
  useDesktopSessionStore.setState({ activeSessionId: "two" })
  await expect(editor.props!.onFeedback!(marked, regions, 200, 100)).rejects.toThrow(
    "当前聊天已变化"
  )
  expect(useDesktopSessionStore.getState().composerDraftsByScope).toEqual({})
})

it("ignores an export that finishes after its image tab was closed", async () => {
  await mount()
  const finishExport = editor.props!.onFeedback!
  await act(async () => root.render(null))
  await finishExport(marked, regions, 200, 100)
  expect(useDesktopSessionStore.getState().composerDraftsByScope).toEqual({})
})
