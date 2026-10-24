// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useStreamingResponseText } from "../use-streaming-response-text"

let root: Root
let container: HTMLDivElement

function Reply({ text, enabled, initial }: { text: string; enabled: boolean; initial: boolean }) {
  const revealed = useStreamingResponseText(text, { enabled, animateInitialText: initial })
  return <p data-pending={revealed.pending}>{revealed.text}</p>
}

function render(text: string, enabled = true, initial = true) {
  act(() => root.render(<Reply text={text} enabled={enabled} initial={initial} />))
}

function advance(milliseconds: number) {
  act(() => vi.advanceTimersByTime(milliseconds))
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  vi.useFakeTimers()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})

it("uses the upstream demo's elapsed-time cursor at 110 characters per second", () => {
  render("字".repeat(110))
  expect(container.textContent).toBe("")
  advance(512)
  expect(container.textContent!.length).toBeGreaterThanOrEqual(55)
  expect(container.textContent!.length).toBeLessThanOrEqual(57)
  advance(512)
  expect(container.textContent).toBe("字".repeat(110))
  expect(container.firstElementChild?.getAttribute("data-pending")).toBe("false")
  expect(vi.getTimerCount()).toBe(0)
})

it("retains its clock across continuous source updates and stops when caught up", () => {
  render("字".repeat(110))
  for (let index = 1; index <= 10; index++) {
    render("字".repeat(110 + index))
    advance(32)
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1)
  }
  expect(container.textContent!.length).toBeGreaterThan(30)
  expect(container.textContent!.length).toBeLessThan(40)
  advance(2000)
  expect(container.textContent).toBe("字".repeat(120))
  expect(vi.getTimerCount()).toBe(0)
})

it("preserves restored text, types only new text and bounds a fast producer's backlog", () => {
  render("历史正文", true, false)
  expect(container.textContent).toBe("历史正文")
  render(`历史正文${"新".repeat(2000)}`, true, false)
  expect(container.textContent).toBe("历史正文")
  advance(16)
  expect(container.textContent!.length).toBeGreaterThanOrEqual(2004 - 220)
  advance(2100)
  expect(container.textContent!.length).toBe(2004)
  expect(vi.getTimerCount()).toBe(0)
})

it("shows corrections and disabled content immediately and cancels work on unmount", () => {
  render("正在输出".repeat(20))
  advance(32)
  expect(vi.getTimerCount()).toBe(1)
  render("服务端修正后的完整正文")
  expect(container.textContent).toBe("服务端修正后的完整正文")
  expect(vi.getTimerCount()).toBe(0)
  render("服务端修正后的完整正文继续增加")
  render("服务端修正后的完整正文继续增加", false)
  expect(container.textContent).toBe("服务端修正后的完整正文继续增加")
  expect(vi.getTimerCount()).toBe(0)
  render("服务端修正后的完整正文继续增加更多文字")
  act(() => root.unmount())
  expect(vi.getTimerCount()).toBe(0)
  root = createRoot(container)
})
