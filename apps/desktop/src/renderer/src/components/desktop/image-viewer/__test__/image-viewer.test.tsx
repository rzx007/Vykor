// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ImageViewer } from "../image-viewer"
import { imageAnnotationKey } from "../image-annotations"

const annotatorNotifications = vi.hoisted(() => ({ deferred: false }))
vi.mock("@annotorious/annotorious", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@annotorious/annotorious")>()
  return {
    ...actual,
    createImageAnnotator: (...args: Parameters<typeof actual.createImageAnnotator>) => {
      const annotator = actual.createImageAnnotator(...args)
      // 数据仍交给真实 annotator，只模拟给 React 的变更通知还没有送达。
      if (annotatorNotifications.deferred) annotator.state.store.observe = () => {}
      return annotator
    },
  }
})

const bytes = new Uint8Array([1, 2, 3]).buffer
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const resizeCallbacks = new Map<Element, ResizeObserverCallback>()
const navigationGuard = { current: null as ((keyboard?: boolean) => boolean) | null }

beforeEach(() => {
  // 只控制异步事件；库用 performance.now() 合并撤销记录，不伪造其初始时间。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  resizeCallbacks.clear()
  annotatorNotifications.deferred = false
  navigationGuard.current = null
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe = (element: Element) => resizeCallbacks.set(element, this.callback)
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
  vi.restoreAllMocks()
})

async function showImage(
  imageBytes = bytes,
  onFeedback = vi.fn(async () => {}),
  name = "screen.png"
) {
  await act(async () =>
    root.render(
      <ImageViewer
        key={name}
        bytes={imageBytes}
        url="blob:test"
        name={name}
        onClose={() => {}}
        onFeedback={onFeedback}
        navigationGuardRef={navigationGuard}
      />
    )
  )
  const image = host.querySelector("img")!
  Object.defineProperties(image, { naturalWidth: { value: 200 }, naturalHeight: { value: 100 } })
  await act(async () => image.dispatchEvent(new Event("load")))
  await act(async () => vi.advanceTimersByTimeAsync(100))
}

async function mount(onFeedback = vi.fn(async () => {}), openComments = true) {
  const key = await imageAnnotationKey(bytes)
  localStorage.setItem(
    key,
    JSON.stringify([{ id: "one", x: 20, y: 10, width: 40, height: 30, comment: "增加间距" }])
  )
  await showImage(bytes, onFeedback)
  if (openComments)
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="批注"]')!.click())
  return key
}

function imageTransform() {
  const style = host.querySelector<HTMLElement>(".react-transform-component")!.style.transform
  const [, x, y, scale] = style.match(
    /translate\(([-\d.e+]+)px, ([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/
  )!
  return { x: Number(x), y: Number(y), scale: Number(scale) }
}

function wheelImage(options: WheelEventInit) {
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    clientX: 140,
    clientY: 70,
    ...options,
  })
  host.querySelector(".react-transform-wrapper")!.dispatchEvent(event)
  return event
}

it.each([
  { deltaY: 100 },
  { deltaY: 10000 },
  { deltaY: 3, deltaMode: 1 },
  { deltaY: 1, deltaMode: 2 },
  { deltaY: 2, ctrlKey: true },
])("keeps an already fitted image visible after one wheel event %j", async (options) => {
  await showImage()
  const viewport = host.querySelector<HTMLElement>('[aria-label="图片画布"]')!
  viewport.getBoundingClientRect = () => ({ left: 40, top: 20, width: 68, height: 170 }) as DOMRect
  await act(async () => resizeCallbacks.get(viewport)!([], {} as ResizeObserver))
  expect(imageTransform().scale).toBeCloseTo(0.1)
  await act(async () => {
    wheelImage(options)
  })
  expect(imageTransform().scale).toBeGreaterThan(0.088)
  expect(imageTransform().scale).toBeLessThan(0.1)
})

it("uses the live zoom for rapid wheel events and keeps the point under the cursor fixed", async () => {
  await showImage()
  const viewport = host.querySelector<HTMLElement>('[aria-label="图片画布"]')!
  viewport.getBoundingClientRect = () => ({ left: 40, top: 20, width: 800, height: 600 }) as DOMRect
  await act(async () => {
    wheelImage({ deltaY: 100 })
    wheelImage({ deltaY: 100 })
  })
  const state = imageTransform()
  expect(state.scale).toBeGreaterThan(0.8)
  expect(state.scale).toBeLessThan(0.85)
  expect((100 - state.x) / state.scale).toBeCloseTo(100)
  expect((50 - state.y) / state.scale).toBeCloseTo(50)
  await act(async () => {
    wheelImage({ deltaY: -100 })
    wheelImage({ deltaY: -100 })
  })
  expect(imageTransform().scale).toBeCloseTo(1)
})

it("keeps tiny trackpad deltas gentle and ignores horizontal scrolling", async () => {
  await showImage()
  await act(async () => {
    for (let index = 0; index < 10; index++) wheelImage({ deltaY: 1 })
  })
  expect(imageTransform().scale).toBeGreaterThan(0.97)
  expect(imageTransform().scale).toBeLessThan(1)
  const before = imageTransform()
  await act(async () => {
    wheelImage({ deltaY: 0, deltaX: 100 })
  })
  expect(imageTransform()).toEqual(before)
})

it("keeps repeated wheel zoom within the viewer's scale limits", async () => {
  await showImage()
  await act(async () => {
    for (let index = 0; index < 100; index++) wheelImage({ deltaY: 100 })
  })
  expect(imageTransform().scale).toBe(0.01)
  await act(async () => {
    for (let index = 0; index < 100; index++) wheelImage({ deltaY: -100 })
  })
  expect(imageTransform().scale).toBe(8)
})

function canNavigate(keyboard = false): boolean {
  expect(navigationGuard.current).toBeTypeOf("function")
  let allowed = false
  act(() => {
    allowed = navigationGuard.current!(keyboard)
  })
  return allowed
}

function inputComment(value: string): void {
  const textarea = host.querySelector("textarea")!
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
    textarea,
    value
  )
  textarea.dispatchEvent(new Event("input", { bubbles: true }))
}

it("flushes the final typed character before switching images and restores it when returning", async () => {
  annotatorNotifications.deferred = true
  const key = await mount()
  await selectRegion()
  let allowed = false
  await act(async () => {
    inputComment("最后一个字")
    expect(JSON.parse(localStorage.getItem(key)!)[0].comment).toBe("增加间距")
    allowed = navigationGuard.current?.() ?? false
  })
  expect(allowed).toBe(true)
  expect(JSON.parse(localStorage.getItem(key)!)[0].comment).toBe("最后一个字")
  await showImage(new Uint8Array([4, 5, 6]).buffer, undefined, "next.png")
  expect(host.querySelector("rect.a9s-inner")).toBeNull()
  expect(canNavigate()).toBe(true)
  await showImage(bytes)
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="批注"]')!.click())
  expect(host.textContent).toContain("最后一个字")
})

it("blocks leaving changed annotations after a save failure and unlocks once a flush succeeds", async () => {
  const key = await mount()
  await selectRegion()
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota")
  })
  await act(async () => inputComment("保留未保存的意见"))
  expect(canNavigate()).toBe(false)
  expect(host.textContent).toContain("批注草稿未能保存")
  expect(host.querySelector("textarea")?.value).toBe("保留未保存的意见")
  write.mockRestore()
  expect(canNavigate()).toBe(true)
  expect(JSON.parse(localStorage.getItem(key)!)[0].comment).toBe("保留未保存的意见")
  expect(host.textContent).not.toContain("批注草稿未能保存")
})

it("does not trap unchanged images or write empty drafts when storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("unavailable")
  })
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("unavailable")
  })
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("unavailable")
  })
  await showImage()
  expect(canNavigate()).toBe(true)
  expect(canNavigate()).toBe(true)
  expect(write).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
})

it("allows leaving after failed edits return to the last saved data", async () => {
  await mount()
  await selectRegion()
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota")
  })
  await act(async () => inputComment("尚未保存"))
  expect(canNavigate()).toBe(false)
  await act(async () => inputComment("增加间距"))
  expect(canNavigate()).toBe(true)
  expect(host.textContent).not.toContain("批注草稿未能保存")
})

it("rejects immediate navigation and repeated actions while feedback is being exported", async () => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const feedback = vi.fn(() => pending)
  await mount(feedback)
  const context = { drawImage: vi.fn(), strokeRect: vi.fn(), fillRect: vi.fn(), fillText: vi.fn() }
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D
  )
  const encode = vi
    .spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementation((callback) => callback(new Blob(["png"])))
  const send = host.querySelector<HTMLButtonElement>('[aria-label="加入聊天"]')!
  await act(async () => {
    send.click()
    send.click()
    expect(navigationGuard.current?.()).toBe(false)
  })
  expect(encode).toHaveBeenCalledTimes(1)
  expect(feedback).toHaveBeenCalledTimes(1)
  expect(host.textContent).toContain("正在处理图片")
  await act(async () => finish())
  expect(canNavigate()).toBe(true)
  expect(host.textContent).not.toContain("正在处理图片")
})

it("leaves editing and drawing arrow keys alone while button navigation can finish the draft", async () => {
  await mount(undefined, false)
  expect(canNavigate(true)).toBe(true)
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="添加批注"]')!.click())
  expect(canNavigate(true)).toBe(false)
  expect(canNavigate()).toBe(true)
  expect(host.querySelector('[data-image-mode="view"]')).not.toBeNull()
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="批注"]')!.click())
  await selectRegion()
  const event = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })
  await act(async () => host.querySelector("textarea")!.dispatchEvent(event))
  expect(event.defaultPrevented).toBe(false)
  expect(canNavigate(true)).toBe(false)
  host.querySelector<HTMLElement>('[aria-label="图片画布"]')!.focus()
  expect(canNavigate(true)).toBe(false)
  expect(canNavigate()).toBe(true)
  const input = document.createElement("input")
  host.append(input)
  input.focus()
  expect(canNavigate(true)).toBe(false)
  input.remove()
})

it("keeps navigation blocked until native pointer gestures end outside the viewer", async () => {
  await mount(undefined, false)
  const canvas = host.querySelector<HTMLElement>('[aria-label="图片画布"]')!
  const pointer = (target: EventTarget, type: string, pointerId: number) => {
    const event = new MouseEvent(type, { bubbles: true })
    Object.defineProperty(event, "pointerId", { value: pointerId })
    act(() => {
      target.dispatchEvent(event)
    })
  }
  pointer(canvas, "pointerdown", 1)
  expect(canNavigate()).toBe(false)
  expect(canNavigate(true)).toBe(false)
  pointer(window, "pointerup", 2)
  expect(canNavigate()).toBe(false)
  canvas.addEventListener("pointerup", (event) => event.stopPropagation(), { once: true })
  pointer(canvas, "pointerup", 1)
  expect(canNavigate()).toBe(true)
  pointer(canvas, "pointerdown", 3)
  pointer(window, "pointercancel", 3)
  expect(canNavigate()).toBe(true)
})

it("cleans up only its own navigation guard", async () => {
  await mount()
  const replacement = () => true
  navigationGuard.current = replacement
  await act(async () => root.render(null))
  expect(navigationGuard.current).toBe(replacement)
})

it("collapses action labels in a narrow image panel and restores them when widened", async () => {
  await mount(undefined, false)
  const viewport = host.querySelector<HTMLElement>('[aria-label="图片画布"]')!
  let width = 800
  viewport.getBoundingClientRect = () => ({ width, height: 600 }) as DOMRect
  const resize = async () =>
    act(async () => {
      resizeCallbacks.get(viewport)!([], {} as ResizeObserver)
      await vi.advanceTimersByTimeAsync(500)
    })
  const toolbar = host.querySelector('[aria-label="图片批注工具"]')!
  const commentsButton = toolbar.querySelector<HTMLButtonElement>('[aria-label="批注"]')!
  await resize()
  expect(commentsButton.querySelector('span[aria-hidden="false"]')?.textContent).toBe("批注")
  width = 280
  await resize()
  expect(commentsButton.querySelector('span[aria-hidden="true"]')?.textContent).toBe("批注")
  expect(
    [...toolbar.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))
  ).toEqual(["浏览", "添加批注", "批注", "撤销", "重做", "加入聊天"])
  expect(commentsButton.title).toBe("批注")
  await act(async () => {
    commentsButton.focus()
    commentsButton.click()
  })
  expect(document.activeElement).toBe(commentsButton)
  expect(host.querySelector('[aria-label="图片批注"]')).not.toBeNull()
  width = 800
  await resize()
  expect(commentsButton.querySelector('span[aria-hidden="false"]')?.textContent).toBe("批注")
})

it("keeps comments out of the canvas until explicitly opened, and closes them without losing drafts", async () => {
  const key = await mount(undefined, false)
  expect(host.querySelector('[aria-label="图片批注"]')).toBeNull()
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="批注"]')!.click())
  expect(host.querySelector('[aria-label="图片批注"]')).not.toBeNull()
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="收起批注"]')!.click())
  expect(host.querySelector('[aria-label="图片批注"]')).toBeNull()
  expect(JSON.parse(localStorage.getItem(key)!)).toHaveLength(1)
})

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
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="添加批注"]')!.click())
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

it("does not undo image annotations when Ctrl+Z is pressed in the chat outside the viewer", async () => {
  const key = await mount()
  await selectRegion()
  await act(async () => {
    const textarea = host.querySelector("textarea")!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "保留这条批注"
    )
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
  })
  const chat = document.createElement("textarea")
  document.body.append(chat)
  await act(async () => {
    chat.focus()
    chat.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }))
  })
  expect(JSON.parse(localStorage.getItem(key)!)[0].comment).toBe("保留这条批注")
  chat.remove()
})

it("undoes exactly one image action when focus is inside the image container", async () => {
  const key = await mount()
  await selectRegion()
  let time = performance.now() + 1000
  vi.spyOn(performance, "now").mockImplementation(() => time)
  const typeComment = async (value: string) =>
    act(async () => {
      const textarea = host.querySelector("textarea")!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        value
      )
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
  await typeComment("第一步")
  time += 300 // 超过库的 250ms 历史合并窗口，形成第二个独立操作。
  await typeComment("第二步")
  await act(async () =>
    host
      .querySelector("svg.a9s-annotationlayer")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }))
  )
  expect(JSON.parse(localStorage.getItem(key)!)[0].comment).toBe("第一步")
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
