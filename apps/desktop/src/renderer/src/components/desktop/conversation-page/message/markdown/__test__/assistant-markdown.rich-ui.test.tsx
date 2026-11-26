// @vitest-environment jsdom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { RichUiContent, RichUiLoadResult } from "@shared/rich-ui-content"
import { AssistantMarkdown } from "../assistant-markdown"

vi.mock("@renderer/components/ui/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

const rootRoute = createRootRoute()
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "settings/$section" })
const router = createRouter({
  routeTree: rootRoute.addChildren([settingsRoute]),
  history: createMemoryHistory(),
})

const image = 'root = Image("测试图片", "http://example.com/photo.webp")'
const youtube = 'root = Video("测试视频", "https://www.youtube.com/watch?v=dQw4w9WgXcQ")'
const video = 'root = Video("测试视频", "https://example.com/player/video")'
const htmlSource = "<button onclick=\"this.textContent='Done'\">Run</button>\n<!-- local -->"
const html = `root = HtmlView("本机示例", ${JSON.stringify(htmlSource)})`
const mountId = "7f832399-0ed2-4a1f-98a3-7e243c347362"
const frame = { kind: "frame", mountId } as const
const frameUrl = `vykor-plugin-app://frame/${mountId}`
const imageSrc = "data:image/webp;base64,AA=="
const settingsLink = 'a[href="/settings/general#general-rich-ui"]'
const load = vi.fn<(content: RichUiContent) => Promise<RichUiLoadResult>>()
const release = vi.fn<(id: string) => Promise<void>>(async () => {})
const openExternal = vi.fn<(url: string) => Promise<void>>(async () => {})
const listeners = new Set<(value: boolean) => void>()
let enabled: boolean
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  enabled = false
  Reflect.set(window, "desktop", {
    settings: {
      getRichUiEnabled: async () => enabled,
      onRichUiEnabledChanged(listener: (value: boolean) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    richUi: { load, release },
    window: { openExternal },
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  load.mockReset()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, "desktop")
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})

async function render(
  code: string,
  { closed = true, streaming = false, beta = true, trailingText = "" } = {}
) {
  const fence = "```"
  await act(async () => {
    root.render(
      <RouterContextProvider router={router}>
        <AssistantMarkdown
          text={`可读摘要。\n\n${fence}vykor-ui-v1\n${code}${closed ? "\n" + fence : ""}${trailingText}`}
          showInteractiveUi={beta}
          streaming={streaming}
          animateInitialText={false}
          onOpenFile={() => {}}
        />
      </RouterContextProvider>
    )
  })
  await act(async () => {
    await import("../../interactive-ui/interactive-ui-block")
  })
}

async function setRichPreference(value: boolean) {
  await act(async () => {
    enabled = value
    for (const listener of listeners) listener(value)
  })
}

async function clickButton(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === label
  )
  expect(button).toBeDefined()
  await act(async () => button!.click())
}

it("links to settings while disabled and loads the image automatically after enabling it", async () => {
  load.mockResolvedValue({ kind: "image", src: imageSrc })
  await render(image)
  expect(container.textContent).toContain("可读摘要。")
  expect(container.textContent).toContain("测试图片")
  expect(container.querySelector(settingsLink)).not.toBeNull()
  expect(container.querySelector("button")).toBeNull()
  expect(container.querySelector("img")).toBeNull()

  await setRichPreference(true)
  expect(container.textContent).toContain("example.com")
  expect(container.querySelector("button")).toBeNull()
  expect(load).toHaveBeenCalledExactlyOnceWith({
    kind: "image",
    title: "测试图片",
    url: "http://example.com/photo.webp",
  })
  expect(container.querySelector("img")?.getAttribute("src")).toBe(imageSrc)
})

it("leaves previews outside the viewport as placeholders until they come into view", async () => {
  enabled = true
  let enter!: () => void
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(report: (entries: { isIntersecting: boolean }[]) => void) {
        enter = () => report([{ isIntersecting: true }])
      }
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  load.mockResolvedValue({ kind: "image", src: imageSrc })
  await render(image)
  expect(load).not.toHaveBeenCalled()
  await act(async () => enter())
  expect(load).toHaveBeenCalledOnce()
  expect(container.querySelector("img")?.getAttribute("src")).toBe(imageSrc)
})

it.each([
  [image, { closed: false, streaming: true }],
  [image, { closed: false }],
  ['root = HtmlView("未完成", "<button', { closed: false }],
  ['root = Video("未完成", "https://example.com/', { closed: false }],
  [image, { beta: false }],
  ['root = Image("图片", "file:///C:/private.png")', {}],
  ['root = YouTube("视频", "dQw4w9WgXcQ")', {}],
  ['root = Video("视频", "file:///C:/private.mp4")', {}],
  ['root = HtmlView("页面", makeHtml())', {}],
  [`${image}\nroot = Image("另一张图片", "https://example.com/second.webp")`, {}],
] as const)(
  "renders the source when the rich fence is incomplete, invalid, or gated",
  async (code, options) => {
    enabled = true
    await render(code, options)
    expect(container.querySelector("pre")?.textContent).toBe(code)
    expect(container.querySelector("button")).toBeNull()
    expect(container.querySelector("iframe")).toBeNull()
    expect(load).not.toHaveBeenCalled()
  }
)

it("loads the player automatically, preserves it when turned off, and releases it on replacement", async () => {
  enabled = true
  const result = Promise.withResolvers<RichUiLoadResult>()
  load.mockReturnValue(result.promise)
  await render(video, { streaming: true })
  expect(container.querySelector("iframe")).toBeNull()
  expect(container.textContent).toContain("正在加载视频…")
  expect(container.textContent).toContain("example.com")
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "在浏览器打开",
  ])
  await clickButton("在浏览器打开")
  expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/player/video")
  expect(load).toHaveBeenCalledExactlyOnceWith({
    kind: "video",
    title: "测试视频",
    url: "https://example.com/player/video",
  })
  await act(async () => result.resolve(frame))
  const player = container.querySelector("iframe")
  expect(player?.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-presentation")
  expect(player?.getAttribute("src")).toBe(frameUrl)
  expect(player?.getAttribute("allow")).toContain("autoplay 'none'")
  expect(player?.hasAttribute("credentialless")).toBe(true)
  await setRichPreference(false)
  expect(container.querySelector("iframe")).toBe(player)
  expect(release).not.toHaveBeenCalled()
  await render(image)
  expect(container.querySelector("iframe")).toBeNull()
  expect(release).toHaveBeenCalledExactlyOnceWith(mountId)
})

it("mounts HTML automatically in the offline sandbox", async () => {
  enabled = true
  load.mockResolvedValue(frame)
  await render(html)
  expect(container.textContent).toContain("此页面仅在本机隔离运行，不能联网。")
  expect(container.querySelector("button")).toBeNull()
  expect(load).toHaveBeenCalledExactlyOnceWith({
    kind: "html",
    title: "本机示例",
    html: htmlSource,
  })
  expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts")
  expect(container.querySelector("iframe")?.getAttribute("src")).toBe(frameUrl)
})

it.each([
  [
    "HtmlView",
    'root = HtmlView("本机示例", "<button',
    html,
    "正在生成 HTML 预览…",
    "正在加载 HTML 预览…",
    "h-[min(24rem,55dvh)]",
  ],
  [
    "Video",
    'root = Video("测试视频", "https://example.com/',
    video,
    "正在生成视频预览…",
    "正在加载视频…",
    "aspect-video",
  ],
])(
  "keeps the %s preview area sized from generation through loading",
  async (component, partial, complete, generatingLabel, loadingLabel, sizeClass) => {
    enabled = true
    const result = Promise.withResolvers<RichUiLoadResult>()
    load.mockReturnValue(result.promise)
    await render(`root = ${component}(`, { closed: false, streaming: true })
    const placeholder = container.querySelector('[role="status"]')
    expect(placeholder?.textContent).toBe(generatingLabel)
    expect(placeholder?.classList.contains(sizeClass)).toBe(true)
    expect(container.querySelector("pre")).toBeNull()
    expect(load).not.toHaveBeenCalled()

    await render(partial, { closed: false, streaming: true })
    expect(container.textContent).toContain(generatingLabel)
    expect(container.querySelector("iframe")).toBeNull()
    expect(load).not.toHaveBeenCalled()

    await render(complete, { streaming: true, trailingText: "\n\n后续说明仍在生成。" })
    const loading = container.querySelector('[role="status"]')
    expect(loading?.textContent).toBe(loadingLabel)
    expect(loading?.className).toBe(placeholder?.className)
    expect(container.querySelector("iframe")).toBeNull()
    expect(container.textContent).toContain("后续说明仍在生成。")
    expect(load).toHaveBeenCalledOnce()

    await act(async () => result.resolve(frame))
    const iframe = container.querySelector("iframe")
    expect(iframe?.getAttribute("src")).toBe(frameUrl)
    expect(iframe?.parentElement?.classList.contains(sizeClass)).toBe(true)
  }
)

it("releases a frame when its request finishes after the original card is replaced", async () => {
  enabled = true
  const result = Promise.withResolvers<RichUiLoadResult>()
  load.mockReturnValueOnce(result.promise).mockResolvedValue({ kind: "image", src: imageSrc })
  await render(html)
  expect(load).toHaveBeenCalledOnce()
  await render(image)
  await act(async () => result.resolve(frame))
  expect(container.querySelector("iframe")).toBeNull()
  expect(release).toHaveBeenCalledExactlyOnceWith(mountId)
})

it("retains the settings hint when the desktop rejects a request made with a stale preference", async () => {
  enabled = true
  load.mockResolvedValue({ kind: "disabled" })
  await render(youtube)
  expect(load).toHaveBeenCalledExactlyOnceWith({
    kind: "video",
    title: "测试视频",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  })
  expect(container.querySelector("iframe")).toBeNull()
  expect(container.querySelector(settingsLink)).not.toBeNull()

  await setRichPreference(false)
  load.mockResolvedValue(frame)
  await setRichPreference(true)
  expect(load).toHaveBeenCalledTimes(2)
  expect(container.querySelector("iframe")?.getAttribute("src")).toBe(frameUrl)
})

it("shows a placeholder when the automatic request fails", async () => {
  enabled = true
  load.mockRejectedValue(new Error("preview failed"))
  await render(html)
  expect(container.querySelector("iframe")).toBeNull()
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  expect(container.querySelector("button")).toBeNull()
  await render(html)
  expect(load).toHaveBeenCalledOnce()
})
