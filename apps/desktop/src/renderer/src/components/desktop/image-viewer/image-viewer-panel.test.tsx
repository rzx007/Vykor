// @vitest-environment jsdom
import { act, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { ImageViewer } from "./image-viewer"
import type { ImageSource } from "./image-source"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { resetDesktopSessionStore } from "@renderer/stores/desktop-session/store-test-fixtures"

// 原生图片编辑器已在 image-viewer.test.tsx 测试。这里只驱动它交给面板的导出回调。
const editor = vi.hoisted(() => ({ props: null as ComponentProps<typeof ImageViewer> | null }))
vi.mock("./image-viewer", () => ({
  ImageViewer: (props: ComponentProps<typeof ImageViewer>) => {
    editor.props = props
    return null
  },
}))
import { ImageViewerPanel } from "./image-viewer-panel"

let root: Root
let host: HTMLDivElement
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
    value: { attachments: { uploadClipboardImage: vi.fn(async () => {}) } },
  })
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
