// @vitest-environment jsdom
import { act, memo } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ImageGalleryProvider, ImageViewerProvider, useImageViewer } from "../image-viewer-provider"
import type { ImageGallery, ImageSource } from "../image-source"

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let viewer: NonNullable<ReturnType<typeof useImageViewer>>
let renders: number
const Probe = memo(function Probe() {
  const context = useImageViewer()
  if (context) viewer = context
  renders++
  return (
    <button type="button" onClick={() => context?.openImage(source)}>
      open
    </button>
  )
})
const source: ImageSource = { kind: "attachment", assetId: "selected", name: "selected.png" }
const other: ImageSource = { kind: "attachment", assetId: "outside-dom", name: "other.png" }
const gallery: ImageGallery = {
  id: "conversation:side",
  sources: [source, other],
  composerScope: "session:side",
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  renders = 0
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it("captures the root panel scope in each opener while using the latest host callback", async () => {
  const first = vi.fn(),
    latest = vi.fn()
  await act(async () =>
    root.render(
      <ImageViewerProvider scopeId="root:A" onOpenImage={first}>
        <Probe />
      </ImageViewerProvider>
    )
  )
  const oldOpen = viewer.openImage
  await act(async () =>
    root.render(
      <ImageViewerProvider scopeId="root:B" onOpenImage={latest}>
        <Probe />
      </ImageViewerProvider>
    )
  )
  oldOpen(source, gallery)
  expect(latest).toHaveBeenCalledWith(source, gallery, "root:A")
  viewer.openImage(source)
  expect(latest).toHaveBeenLastCalledWith(source, undefined, "root:B")
  expect(first).not.toHaveBeenCalled()
})

it("collects the latest loaded gallery only on click without rerendering context consumers during streaming", async () => {
  expect(ImageGalleryProvider).toBeTypeOf("function")
  const onOpen = vi.fn(),
    getFirst = vi.fn(() => ({ ...gallery, sources: [source] }))
  const getLatest = vi.fn(() => gallery)
  await act(async () =>
    root.render(
      <ImageViewerProvider scopeId="root" onOpenImage={onOpen}>
        <ImageGalleryProvider getGallery={getFirst}>
          <Probe />
        </ImageGalleryProvider>
      </ImageViewerProvider>
    )
  )
  const initialRenders = renders,
    open = viewer.openImage
  await act(async () =>
    root.render(
      <ImageViewerProvider scopeId="root" onOpenImage={onOpen}>
        <ImageGalleryProvider getGallery={getLatest}>
          <Probe />
        </ImageGalleryProvider>
      </ImageViewerProvider>
    )
  )
  expect(renders).toBe(initialRenders)
  expect(viewer.openImage).toBe(open)
  expect(getFirst).not.toHaveBeenCalled()
  expect(getLatest).not.toHaveBeenCalled()
  container.querySelector("button")!.click()
  expect(getLatest).toHaveBeenCalledOnce()
  expect(onOpen).toHaveBeenCalledWith(source, gallery, "root")
  expect(container.textContent).not.toContain("other.png")
})

it("falls back to the clicked single image when it is absent from the snapshot and leaves files single", async () => {
  expect(ImageGalleryProvider).toBeTypeOf("function")
  const onOpen = vi.fn(),
    getGallery = vi.fn(() => ({ ...gallery, sources: [other] }))
  await act(async () =>
    root.render(
      <ImageViewerProvider scopeId="root" onOpenImage={onOpen}>
        <ImageGalleryProvider getGallery={getGallery}>
          <Probe />
        </ImageGalleryProvider>
      </ImageViewerProvider>
    )
  )
  viewer.openImage(source)
  expect(onOpen).toHaveBeenLastCalledWith({ ...source, readOnly: true }, undefined, "root")
  const file: ImageSource = {
    kind: "file",
    path: "a.png",
    name: "a.png",
    bytes: new ArrayBuffer(1),
    mediaType: "image/png",
  }
  viewer.openImage(file)
  expect(onOpen).toHaveBeenLastCalledWith(file, undefined, "root")
  expect(getGallery).toHaveBeenCalledOnce()
})

it("preserves explicit source read-only access in both the selected source and its gallery entry", async () => {
  expect(ImageGalleryProvider).toBeTypeOf("function")
  const onOpen = vi.fn()
  await act(async () =>
    root.render(
      <ImageViewerProvider scopeId="root" onOpenImage={onOpen}>
        <ImageGalleryProvider getGallery={() => gallery}>
          <Probe />
        </ImageGalleryProvider>
      </ImageViewerProvider>
    )
  )
  viewer.openImage({ ...source, readOnly: true })
  const [opened, snapshot] = onOpen.mock.calls[0]!
  expect(opened.readOnly).toBe(true)
  expect(snapshot.sources[0].readOnly).toBe(true)
})

it("makes missing-scope or read-only regions conservative even on single-image fallback", async () => {
  expect(ImageGalleryProvider).toBeTypeOf("function")
  const onOpen = vi.fn()
  await act(async () =>
    root.render(
      <ImageViewerProvider scopeId="root" onOpenImage={onOpen}>
        <ImageGalleryProvider readOnly getGallery={() => undefined}>
          <Probe />
        </ImageGalleryProvider>
      </ImageViewerProvider>
    )
  )
  viewer.openImage(source)
  expect(onOpen).toHaveBeenCalledWith({ ...source, readOnly: true }, undefined, "root")
})
