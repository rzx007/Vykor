// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { FileImagePreview } from "./file-image-preview"

describe("FileImagePreview", () => {
  let container: HTMLDivElement
  let root: Root
  let createObjectURL: ReturnType<typeof vi.fn>
  let revokeObjectURL: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    createObjectURL = vi.fn((blob: Blob) => `blob:${blob.type}:${blob.size}`)
    revokeObjectURL = vi.fn()
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    })
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  it("renders exact bytes as a contained blob image", async () => {
    await render(new Uint8Array([1, 2, 3]).buffer, "preview.png")

    const image = container.querySelector("img")
    expect(image?.getAttribute("src")).toBe("blob:image/png:3")
    expect(image?.getAttribute("alt")).toBe("preview.png")
    expect(image?.className).toContain("object-contain")
    expect(image?.className).toContain("max-h-full")
    expect(image?.className).toContain("max-w-full")
    expect(createObjectURL).toHaveBeenCalledOnce()
  })

  it("revokes the old URL when the image changes", async () => {
    const firstBytes = new Uint8Array([1]).buffer
    await render(firstBytes, "first.png")
    await render(new Uint8Array([1, 2]).buffer, "second.png")

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:image/png:1")
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:image/png:2")
  })

  it("revokes the current URL when unmounted", async () => {
    await render(new Uint8Array([1, 2, 3]).buffer, "preview.png")

    act(() => root.unmount())

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:image/png:3")
    root = createRoot(container)
  })

  it("falls back after an image decode error", async () => {
    await render(new Uint8Array([1, 2, 3]).buffer, "broken.png")
    const image = container.querySelector("img")

    await act(async () => image?.dispatchEvent(new Event("error")))

    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toContain("broken.png")
    expect(container.textContent).toContain("无法显示这张图片。")
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:image/png:3")
  })

  it("does not carry a decode failure into changed image metadata", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer
    await render(bytes, "broken.png")
    await act(async () => container.querySelector("img")?.dispatchEvent(new Event("error")))

    await act(async () => {
      root.render(<FileImagePreview bytes={bytes} mediaType="image/webp" name="fixed.webp" />)
    })

    expect(container.querySelector('img[alt="fixed.webp"]')).not.toBeNull()
  })

  async function render(bytes: ArrayBuffer, name: string): Promise<void> {
    await act(async () => {
      root.render(<FileImagePreview bytes={bytes} mediaType="image/png" name={name} />)
    })
  }
})
