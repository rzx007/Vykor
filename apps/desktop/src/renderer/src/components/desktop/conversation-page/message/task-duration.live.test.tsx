// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { TaskDuration } from "./task-duration"

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
  vi.setSystemTime(11_000)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it("uses wall time across status changes and remounts, then stops ticking on completion", () => {
  const timing = { status: "running" as const, startedAt: 1_000 }
  act(() => root.render(<TaskDuration timing={timing} label="正在处理" />))
  expect(container.textContent).toContain("10秒")
  act(() => vi.advanceTimersByTime(5_000))
  expect(container.textContent).toContain("15秒")
  act(() => root.render(<TaskDuration timing={timing} label="等待重试" />))
  expect(container.textContent).toContain("15秒")
  act(() => {
    vi.setSystemTime(61_000)
    vi.advanceTimersByTime(1_000)
  })
  expect(container.textContent).toContain("1分1秒")
  act(() => root.unmount())
  root = createRoot(container)
  act(() => root.render(<TaskDuration timing={timing} />))
  expect(container.textContent).toContain("1分1秒")
  act(() =>
    root.render(<TaskDuration timing={{ ...timing, status: "completed", finishedAt: 66_000 }} />)
  )
  expect(container.textContent).toContain("1分5秒")
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(60_000))
  expect(container.textContent).toContain("1分5秒")
})

it("does not invent elapsed time or run a clock for queued work", () => {
  act(() => root.render(<TaskDuration timing={{ status: "pending" }} />))
  expect(container.textContent).toBe("等待执行")
  expect(vi.getTimerCount()).toBe(0)
})
