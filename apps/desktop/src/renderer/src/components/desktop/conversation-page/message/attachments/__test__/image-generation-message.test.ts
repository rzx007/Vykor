// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopAttachmentSessionPart, DesktopSessionPart } from "@shared/session-types"
import { GeneratedImageGallery, ImageGenerationMessage } from "../image-generation-message"

describe("ImageGenerationMessage", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    vi.setSystemTime(0)
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        attachments: {
          readPreview: vi.fn(async ({ assetId }: { assetId: string }) => ({
            bytes: new Uint8Array([1, 2, 3]).buffer,
            mediaType: "image/png",
            assetId,
          })),
          open: vi.fn(async () => undefined),
          saveAs: vi.fn(async () => undefined),
        },
      },
    })
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob) => `blob:${blob.size}`),
    })
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  it("shows a ratio-aware placeholder and honest elapsed-time stages", () => {
    act(() =>
      root.render(
        createElement(ImageGenerationMessage, {
          call: imageCall({ status: "running", ratio: "16:9", createdAt: 0 }),
          hasAttachments: false,
          streaming: true,
        })
      )
    )

    expect(container.textContent).toContain("正在生成图片")
    expect(container.textContent).not.toContain("已等待")
    expect(container.querySelector('[data-image-ratio="16:9"]')).not.toBeNull()
    expect(container.querySelector('[role="progressbar"]')).toBeNull()

    act(() => vi.advanceTimersByTime(20_000))
    expect(container.textContent).toContain("已等待 20 秒")

    act(() => vi.advanceTimersByTime(32_000))
    expect(container.textContent).toContain("已等待 52 秒")
    expect(container.textContent).toContain("生成时间可能较长")
    expect(container.querySelector("[data-image-generation-title]")?.textContent).toBe(
      "正在生成图片"
    )
    expect(container.querySelector("[data-image-generation-announcement]")?.textContent).toBe(
      "图片生成耗时较长"
    )
    expect(
      container.querySelector("[data-image-generation-elapsed]")?.hasAttribute("aria-hidden")
    ).toBe(false)
  })

  it("uses a compact fixed panel and represents ratio with one small canvas", () => {
    act(() =>
      root.render(
        createElement(ImageGenerationMessage, {
          call: imageCall({ status: "running", ratio: "9:16", createdAt: 0 }),
          hasAttachments: false,
          streaming: true,
        })
      )
    )

    const card = container.querySelector('section[aria-label="图片生成状态"]')
    const placeholder = container.querySelector("[data-image-placeholder]")
    const canvas = container.querySelector('[data-placeholder-canvas][data-image-ratio="9:16"]')
    expect(card?.className).toContain("max-w-72")
    expect(card?.className).not.toContain("max-w-xl")
    expect(placeholder?.className).toContain("h-44")
    expect(placeholder?.className).toContain("w-full")
    expect(placeholder?.className).not.toContain("aspect-[9/16]")
    expect(canvas?.className).toContain("aspect-[9/16]")
    expect(canvas?.className).toContain("animate-pulse")
    expect(container.querySelectorAll("[data-placeholder-canvas]")).toHaveLength(1)
  })

  it("renders a calm inline failure with collapsed expandable details", () => {
    act(() =>
      root.render(
        createElement(ImageGenerationMessage, {
          call: imageCall({ status: "failed", output: "provider unavailable" }),
          hasAttachments: false,
          streaming: false,
        })
      )
    )
    expect(container.textContent).toContain("这次没有生成出图片")
    const details = container.querySelector("details")
    expect(details?.textContent).toContain("provider unavailable")
    expect(details?.open).toBe(false)
    const failedState = container.querySelector('section[aria-label="图片生成失败"]')
    const summary = details?.querySelector("summary")
    expect(failedState?.className).not.toContain("border")
    expect(failedState?.className).not.toContain("bg-muted")
    expect(summary?.textContent).toContain("详情")
    expect(summary?.getAttribute("aria-live")).toBe("polite")
    expect(summary?.getAttribute("aria-atomic")).toBe("true")
    expect(summary?.querySelector("svg")?.className.baseVal).toContain("text-amber")
    act(() => summary?.click())
    expect(details?.open).toBe(true)
    expect(details?.querySelector("pre")?.className).toContain("bg-muted")

    act(() =>
      root.render(
        createElement(ImageGenerationMessage, {
          call: imageCall({ status: "interrupted" }),
          hasAttachments: false,
          streaming: false,
        })
      )
    )
    expect(container.textContent).toContain("图片生成已取消")
    expect(container.textContent).not.toContain("provider unavailable")

    act(() =>
      root.render(
        createElement(ImageGenerationMessage, {
          call: {
            ...imageCall({ status: "failed", output: "request aborted" }),
            metadata: { failureKind: "interrupted" },
          },
          hasAttachments: false,
          streaming: false,
        })
      )
    )
    expect(container.textContent).toContain("图片生成已取消")
    expect(container.textContent).not.toContain("图片生成失败")
  })

  it("does not expose an empty details control when failure output is missing", () => {
    act(() =>
      root.render(
        createElement(ImageGenerationMessage, {
          call: imageCall({ status: "failed" }),
          hasAttachments: false,
          streaming: false,
        })
      )
    )

    expect(container.textContent).toContain("这次没有生成出图片")
    expect(container.textContent).not.toContain("详情")
    expect(container.querySelector("details")).toBeNull()
    expect(container.querySelector("summary")).toBeNull()
    expect(
      container.querySelector("[data-image-generation-status-row]")?.getAttribute("aria-live")
    ).toBe("polite")
    expect(
      container.querySelector("[data-image-generation-status-row]")?.getAttribute("aria-atomic")
    ).toBe("true")
  })

  it("uses the same calm inline shell for cancelled, finalizing, and missing-attachment states", () => {
    const expectInlineStatus = (iconTone: string): void => {
      const status = container.querySelector("[data-image-generation-status]")
      expect(status).not.toBeNull()
      expect(status?.className).not.toContain("border")
      expect(status?.className).not.toContain("bg-")
      expect(status?.className).not.toContain("rounded-xl")
      expect(status?.className).toContain("text-xs")
      const row = status?.querySelector("[data-image-generation-status-row]")
      expect(row?.className).toContain("py-1.5")
      expect(row?.className).toContain("gap-2")
      expect(row?.getAttribute("aria-live")).toBe("polite")
      expect(row?.getAttribute("aria-atomic")).toBe("true")
      expect(status?.querySelector("svg")?.className.baseVal).toContain("size-4")
      expect(status?.querySelector("svg")?.className.baseVal).toContain(iconTone)
    }

    act(() =>
      root.render(
        createElement(ImageGenerationMessage, {
          call: imageCall({ status: "interrupted" }),
          hasAttachments: false,
          streaming: false,
        })
      )
    )
    expect(container.textContent).toContain("图片生成已取消")
    expectInlineStatus("text-ui-muted")

    act(() =>
      root.render(
        createElement(ImageGenerationMessage, {
          call: imageCall({ status: "completed" }),
          hasAttachments: false,
          streaming: true,
        })
      )
    )
    expect(container.textContent).toContain("正在整理生成结果")
    expectInlineStatus("text-violet")

    act(() =>
      root.render(
        createElement(ImageGenerationMessage, {
          call: imageCall({ status: "completed" }),
          hasAttachments: false,
          streaming: false,
        })
      )
    )
    expect(container.textContent).toContain("图片已生成，但附件暂未显示")
    expectInlineStatus("text-amber")
  })

  it("disappears for ready attachments and distinguishes transient finalization from missing data", () => {
    const completed = imageCall({ status: "completed" })

    act(() =>
      root.render(
        createElement(ImageGenerationMessage, {
          call: completed,
          hasAttachments: true,
          streaming: true,
        })
      )
    )
    expect(container.innerHTML).toBe("")

    act(() =>
      root.render(
        createElement(ImageGenerationMessage, {
          call: completed,
          hasAttachments: false,
          streaming: true,
        })
      )
    )
    expect(container.textContent).toContain("正在整理生成结果")

    act(() =>
      root.render(
        createElement(ImageGenerationMessage, {
          call: completed,
          hasAttachments: false,
          streaming: false,
        })
      )
    )
    expect(container.textContent).toContain("图片已生成，但附件暂未显示")
  })

  it.each([
    [1, "single"],
    [2, "pair"],
    [3, "triple"],
    [4, "quad"],
  ] as const)("uses the %i-image responsive layout", async (count, layout) => {
    await act(async () =>
      root.render(
        createElement(GeneratedImageGallery, {
          parts: imageAttachments(count),
          ratio: "4:3",
        })
      )
    )

    const gallery = container.querySelector("[data-generated-image-gallery]")
    expect(gallery?.getAttribute("data-image-count")).toBe(String(count))
    expect(gallery?.getAttribute("data-layout")).toBe(layout)
    expect(container.querySelectorAll("[data-generated-image]")).toHaveLength(count)
  })

  it("keeps the final single-image size independent from the compact placeholder", async () => {
    await act(async () =>
      root.render(
        createElement(GeneratedImageGallery, {
          parts: imageAttachments(1),
          ratio: "9:16",
        })
      )
    )

    const gallery = container.querySelector("[data-generated-image-gallery]")
    expect(gallery?.className).toContain("aspect-[9/16]")
    expect(gallery?.className).toContain("max-w-64")
    expect(gallery?.className).not.toContain("max-w-72")
  })

  it("caps the initial gallery at four images and expands and collapses the remainder", async () => {
    await act(async () =>
      root.render(
        createElement(GeneratedImageGallery, {
          parts: imageAttachments(6),
          ratio: "1:1",
        })
      )
    )

    expect(container.querySelectorAll("[data-generated-image]")).toHaveLength(4)
    const expand = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("+2")
    )
    expect(expand?.getAttribute("aria-label")).toContain("展开全部 6 张图片")

    await act(async () => expand?.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(container.querySelectorAll("[data-generated-image]")).toHaveLength(6)
    expect(container.querySelector("[data-generated-image-gallery]")?.className).not.toContain(
      "aspect-square"
    )
    expect(
      [...container.querySelectorAll("[data-generated-image]")].every((item) =>
        item.className.includes("aspect-square")
      )
    ).toBe(true)
    const collapse = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("收起")
    )
    expect(collapse).toBeDefined()

    await act(async () => collapse?.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(container.querySelectorAll("[data-generated-image]")).toHaveLength(4)
  })
})

function imageCall(options: {
  status: DesktopSessionPart["status"]
  ratio?: string
  createdAt?: number
  output?: unknown
}): DesktopSessionPart {
  return {
    id: "image-tool-1",
    sessionId: "session-1",
    messageId: "message-1",
    seq: 1,
    type: "tool",
    status: options.status,
    toolUseId: "image-tool-1",
    toolName: "ImageGeneration",
    input: { prompt: "draw a fox", ratio: options.ratio },
    ...(options.output === undefined ? {} : { output: options.output }),
    metadata: {},
    createdAt: options.createdAt ?? 0,
    updatedAt: options.createdAt ?? 0,
  }
}

function imageAttachments(count: number): DesktopAttachmentSessionPart[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `generated-${index + 1}`,
    sessionId: "session-1",
    messageId: "message-1",
    seq: index + 2,
    type: "attachment",
    status: "completed",
    assetId: `asset-${index + 1}`,
    intent: "tool_resource",
    displayName: `image-${index + 1}.png`,
    mediaType: "image/png",
    sizeBytes: 128,
    metadata: { source: "image_generation", toolUseId: "image-tool-1" },
    createdAt: 1,
    updatedAt: 1,
  }))
}
