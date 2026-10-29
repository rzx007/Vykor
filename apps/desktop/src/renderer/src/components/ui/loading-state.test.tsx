// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { LoadingState } from "./loading-state"

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete document.documentElement.dataset.reducedMotion
  vi.unstubAllGlobals()
})

// canvas 在 jsdom 里拿不到 2d 上下文，库会自己跳过绘制；这里只断言它收到的属性。
function orb(): HTMLCanvasElement | null {
  return container.querySelector("canvas")
}

it("draws the orb state it was given next to the label instead of a second text", () => {
  act(() =>
    root.render(<LoadingState label="正在准备工具" state="solving" size={64} showElapsed={false} />)
  )
  expect(container.querySelector('[role="status"]')).not.toBeNull()
  expect(container.textContent).toBe("正在准备工具")
  expect(orb()?.dataset.orbState).toBe("solving")
  expect(orb()?.style.width).toBe("64px")
  // 文字在标签上，动画本身不该再被读一遍。
  expect(orb()?.getAttribute("aria-hidden")).toBe("true")
})

it("pauses the canvas when the app turns reduced motion on, and resumes when it goes off", async () => {
  act(() =>
    root.render(<LoadingState label="进行中" state="working" showElapsed={false} paused={false} />)
  )
  expect(orb()?.dataset.orbPaused).toBe("false")

  // 画布不吃 main.css 里 :root[data-reduced-motion="true"] * 的动画降级规则，得自己停。
  await act(async () => {
    document.documentElement.dataset.reducedMotion = "true"
  })
  expect(orb()?.dataset.orbPaused).toBe("true")

  await act(async () => {
    document.documentElement.dataset.reducedMotion = "false"
  })
  expect(orb()?.dataset.orbPaused).toBe("false")
})

it("keeps a caller-supplied pause when the app preference does not ask for one", () => {
  act(() => root.render(<LoadingState label="进行中" state="working" showElapsed={false} paused />))
  expect(orb()?.dataset.orbPaused).toBe("true")
})

it("switches immediately with reduced motion and announces only the current status", () => {
  document.documentElement.dataset.reducedMotion = "true"
  act(() => root.render(<LoadingState label="等待模型响应" state="working" showElapsed={false} />))
  act(() => root.render(<LoadingState label="" state="solving" showElapsed={false} />))
  expect(container.textContent).toBe("")
  expect(container.querySelectorAll("canvas")).toHaveLength(1)
  expect(orb()?.dataset.orbState).toBe("solving")
  expect(orb()?.dataset.orbPaused).toBe("true")
  act(() =>
    root.render(<LoadingState label="等待你的确认" state="breathing" showElapsed={false} />)
  )
  expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(
    "等待你的确认"
  )
  expect(container.textContent).toBe("等待你的确认")
})

it("can settle as inline text without an orb, shimmer or elapsed timer", () => {
  document.documentElement.dataset.reducedMotion = "true"
  act(() =>
    root.render(
      <LoadingState
        label="编辑了文件，运行了命令"
        showElapsed={false}
        showIndicator={false}
        paused
      />
    )
  )
  expect(container.querySelector('[role="status"]')?.tagName).toBe("SPAN")
  expect(container.textContent).toBe("编辑了文件，运行了命令")
  expect(container.querySelector("canvas, .shimmer")).toBeNull()
})

it("keeps the accessible label current while visual states crossfade", () => {
  act(() => root.render(<LoadingState label="正在读取文件" state="working" showElapsed={false} />))
  const status = container.querySelector('[role="status"]')
  act(() => root.render(<LoadingState label="正在编辑文件" state="solving" showElapsed={false} />))
  expect(container.querySelector('[role="status"]')).toBe(status)
  expect(status?.getAttribute("aria-label")).toBe("正在编辑文件")
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
})
