// @vitest-environment jsdom
import { act, useState, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { ImageViewer } from "../image-viewer"
import type { ImageGallery, ImageSource } from "../image-source"
import { resetDesktopSessionStore } from "@renderer/stores/desktop-session/store-test-fixtures"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"

const editor = vi.hoisted(() => ({
  props: null as ComponentProps<typeof ImageViewer> | null,
  guard: vi.fn(() => true),
}))
vi.mock("../image-viewer", async () => {
  const { useLayoutEffect } = await import("react")
  return {
    ImageViewer: (props: ComponentProps<typeof ImageViewer>) => {
      editor.props = props
      useLayoutEffect(() => {
        const ref = props.navigationGuardRef
        if (ref) ref.current = editor.guard
        return () => {
          if (ref?.current === editor.guard) ref.current = null
        }
      }, [props.navigationGuardRef])
      return <textarea aria-label="批注文字" />
    },
  }
})
import { ImageViewerPanel } from "../image-viewer-panel"

let root: Root, host: HTMLDivElement
const readPreview = vi.fn()
const sources: ImageSource[] = ["one", "two", "three"].map((assetId) => ({
  kind: "attachment",
  assetId,
  name: assetId + ".png",
}))
const gallery: ImageGallery = { id: "conversation:one", composerScope: "session:one", sources }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  resetDesktopSessionStore()
  useDesktopSessionStore.setState({
    activeSessionId: "one",
    attachmentSupport: { interactionEnabled: true } as never,
  })
  readPreview
    .mockReset()
    .mockImplementation(async ({ assetId }) => ({
      bytes: new TextEncoder().encode(assetId).buffer,
      mediaType: "image/png",
    }))
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { attachments: { readPreview, uploadClipboardImage: vi.fn(async () => {}) } },
  })
  editor.guard.mockReset().mockReturnValue(true)
  editor.props = null
  host = document.body.appendChild(document.createElement("div"))
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
async function mount() {
  function Gallery() {
    const [index, setIndex] = useState(0)
    return (
      <ImageViewerPanel
        source={sources[index]!}
        gallery={gallery}
        scopeId="session:one"
        onNavigate={(direction) => setIndex((value) => Math.max(0, Math.min(2, value + direction)))}
      />
    )
  }
  await act(async () => root.render(<Gallery />))
}
function next() {
  return host.querySelector<HTMLButtonElement>('[aria-label="下一张图片"]')!
}
function previous() {
  return host.querySelector<HTMLButtonElement>('[aria-label="上一张图片"]')!
}
it("keeps navigation available during failed reads and skips stale results after rapid switching", async () => {
  let finish!: (value: { bytes: ArrayBuffer; mediaType: string }) => void
  readPreview.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await mount()
  expect(host.textContent).toContain("1 / 3")
  expect(previous().disabled).toBe(true)
  await act(async () => next().click())
  expect(host.textContent).toContain("2 / 3")
  readPreview.mockRejectedValueOnce(new Error("offline"))
  await act(async () => next().click())
  expect(host.textContent).toContain("3 / 3")
  expect(host.textContent).toContain("无法读取图片")
  expect(next().disabled).toBe(true)
  await act(async () => finish({ bytes: new ArrayBuffer(10), mediaType: "image/png" }))
  expect(host.textContent).toContain("无法读取图片")
  await act(async () => previous().click())
  expect(editor.props?.name).toBe("two.png")
  expect(readPreview.mock.calls.map(([arg]) => arg.assetId)).toEqual(["one", "two", "three", "two"])
})
it("guards navigation and ignores editing, composition and modified arrow keys", async () => {
  await mount()
  const surface = host.querySelector<HTMLElement>('[aria-label="图片连续浏览"]')!
  const press = async (target: Element, options: KeyboardEventInit = {}) =>
    act(async () => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
          ...options,
        })
      )
    })
  await press(host.querySelector("textarea")!)
  await press(surface, { isComposing: true })
  await press(surface, { ctrlKey: true })
  expect(editor.props?.name).toBe("one.png")
  editor.guard.mockReturnValue(false)
  await act(async () => next().click())
  expect(editor.props?.name).toBe("one.png")
  editor.guard.mockReturnValue(true)
  await press(surface)
  expect(editor.props?.name).toBe("two.png")
  expect(editor.guard).toHaveBeenCalledWith(true)
})
it("uses the gallery's composer scope and rejects a retired caller before adding feedback", async () => {
  let valid = true
  const scoped = { ...gallery, composerScope: "session:side", canFeedback: () => valid }
  await act(async () =>
    root.render(<ImageViewerPanel source={sources[0]!} gallery={scoped} scopeId="session:one" />)
  )
  const marked = { arrayBuffer: async () => new ArrayBuffer(2) } as Blob
  const regions = [{ id: "r", x: 1, y: 1, width: 2, height: 2, comment: "修正" }]
  await act(async () => editor.props!.onFeedback!(marked, regions, 10, 10))
  expect(
    useDesktopSessionStore.getState().composerDraftsByScope["session:side"]?.attachments
  ).toHaveLength(2)
  expect(useDesktopSessionStore.getState().composerDraftsByScope["session:one"]).toBeUndefined()
  valid = false
  await expect(editor.props!.onFeedback!(marked, regions, 10, 10)).rejects.toThrow("聊天已变化")
  expect(
    useDesktopSessionStore.getState().composerDraftsByScope["session:side"]?.attachments
  ).toHaveLength(2)
  valid = true
  let finish!: (bytes: ArrayBuffer) => void
  const pending = editor.props!.onFeedback!(
    { arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => { finish = resolve }) } as Blob,
    regions, 10, 10
  )
  valid = false
  finish(new ArrayBuffer(2))
  await expect(pending).rejects.toThrow("聊天已变化")
  expect(window.desktop.attachments.uploadClipboardImage).toHaveBeenCalledTimes(2)
})
