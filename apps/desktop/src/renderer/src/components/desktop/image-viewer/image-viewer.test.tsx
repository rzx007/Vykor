// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ImageViewer } from "./image-viewer"
import { imageAnnotationKey } from "./image-annotations"

const bytes = new Uint8Array([1, 2, 3]).buffer
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  // 只控制异步事件；库用 performance.now() 合并撤销记录，不伪造其初始时间。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  localStorage.clear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function mount(onFeedback = vi.fn(async () => {})) {
  const key = await imageAnnotationKey(bytes)
  localStorage.setItem(
    key,
    JSON.stringify([{ id: "one", x: 20, y: 10, width: 40, height: 30, comment: "增加间距" }])
  )
  await act(async () =>
    root.render(
      <ImageViewer
        bytes={bytes}
        url="blob:test"
        name="screen.png"
        onClose={() => {}}
        onFeedback={onFeedback}
      />
    )
  )
  const image = host.querySelector("img")!
  Object.defineProperties(image, { naturalWidth: { value: 200 }, naturalHeight: { value: 100 } })
  await act(async () => image.dispatchEvent(new Event("load")))
  await act(async () => vi.advanceTimersByTimeAsync(100))
  expect(host.textContent).toContain("增加间距")
  return key
}

async function selectRegion() {
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[aria-label="定位批注 1"]')!.click()
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(host.querySelector("textarea")).not.toBeNull()
}

it("restores a region and edits its comment without modifying the original image", async () => {
  const key = await mount()
  const rectangle = host.querySelector("rect.a9s-inner")!
  expect(rectangle.getAttribute("width")).toBe("40")
  expect(rectangle.getAttribute("height")).toBe("30")
  await selectRegion()
  const textarea = host.querySelector("textarea")!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "缩小搜索框"
    )
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="保存批注意见"]')!.click()
  )
  expect(host.textContent).toContain("缩小搜索框")
  expect(JSON.parse(localStorage.getItem(key)!)[0]).toMatchObject({
    comment: "缩小搜索框",
    x: 20,
    width: 40,
  })
  expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:test")
})

it("keeps a reverse-drag rectangle in original pixels inside a CSS-scaled image", async () => {
  const key = await mount()
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="框选批注（R）"]')!.click()
  )
  const svg = host.querySelector<SVGSVGElement>("svg.a9s-annotationlayer")!
  Object.defineProperties(svg, {
    viewBox: { configurable: true, value: { baseVal: { width: 200, height: 100 } } },
    clientWidth: { configurable: true, value: 200 },
    clientHeight: { configurable: true, value: 100 },
  })
  svg.getBoundingClientRect = () => ({
    x: 100,
    y: 50,
    left: 100,
    top: 50,
    right: 200,
    bottom: 100,
    width: 100,
    height: 50,
    toJSON: () => ({}),
  })
  const pointer = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: 100 + x / 2, clientY: 50 + y / 2 })
    Object.defineProperties(event, {
      offsetX: { value: x },
      offsetY: { value: y },
      pointerId: { value: 1 },
    })
    svg.dispatchEvent(event)
  }
  await act(async () => pointer("pointerdown", 140, 90))
  await act(async () => pointer("pointermove", 60, 30))
  await act(async () => {
    pointer("pointerup", 60, 30)
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(JSON.parse(localStorage.getItem(key)!)[1]).toMatchObject({
    x: 60,
    y: 30,
    width: 80,
    height: 60,
  })
})

it("deletes a saved region and can undo that operation", async () => {
  await mount()
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="删除批注 1"]')!.click())
  expect(host.textContent).not.toContain("增加间距")
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="撤销"]')!.click())
  expect(host.textContent).toContain("增加间距")
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="重做"]')!.click())
  expect(host.textContent).not.toContain("增加间距")
})

it("does not apply annotation undo when typing in the comment editor", async () => {
  const key = await mount()
  await selectRegion()
  await act(async () =>
    host
      .querySelector("textarea")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }))
  )
  expect(JSON.parse(localStorage.getItem(key)!)).toHaveLength(1)
})

it("keeps typed feedback on close even before leaving the comment editor", async () => {
  const key = await mount()
  await selectRegion()
  await act(async () => {
    const textarea = host.querySelector("textarea")!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "调整字体"
    )
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => root.render(null))
  expect(JSON.parse(localStorage.getItem(key)!)[0].comment).toBe("调整字体")
})

it("passes an immutable numbered-image snapshot and original pixel regions to the composer action", async () => {
  const feedback = vi.fn(async () => {})
  await mount(feedback)
  const png = new Blob(["png"], { type: "image/png" })
  const context = { drawImage: vi.fn(), strokeRect: vi.fn(), fillRect: vi.fn(), fillText: vi.fn() }
  const canvasContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(context as unknown as CanvasRenderingContext2D)
  const canvasBlob = vi
    .spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementation((callback) => callback(png))
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "加入聊天")!
      .click()
  )
  expect(feedback).toHaveBeenCalledWith(
    png,
    [{ id: "one", x: 20, y: 10, width: 40, height: 30, comment: "增加间距" }],
    200,
    100
  )
  expect(context.strokeRect).toHaveBeenCalledWith(20, 10, 40, 30)
  expect(context.fillText).toHaveBeenCalledWith("1", expect.any(Number), expect.any(Number))
  canvasContext.mockRestore()
  canvasBlob.mockRestore()
})
