// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { DesktopComputerActivity, DesktopComputerActivityUpdate } from "@shared/computer-types"
import { ComputerActivityPanel } from "../computer-activity-panel"

const preview = { dataUrl: "data:image/png;base64,YQ==", width: 1, height: 1 }
const activity: DesktopComputerActivity = { sessionId: "original", runId: "run", phase: "foreground", app: "记事本", preview }
let root: Root
let container: HTMLDivElement
let listener: (update: DesktopComputerActivityUpdate) => void
const control = vi.fn(async () => true)
const detach = vi.fn()

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("desktop", { computer: {
    getActivity: async (sessionId: string) => sessionId === "original" ? activity : null,
    onActivity: (receive: typeof listener) => { listener = receive; return detach },
    control,
  } })
  control.mockClear()
  detach.mockClear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function button(label: string): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find(item => item.textContent === label)!
}

it("expands the current window preview and removes it when the chat or capture state changes", async () => {
  await act(async () => root.render(<ComputerActivityPanel sessionId="original" />))
  expect(container.querySelector("img")).toBeNull()
  await act(async () => button("窗口预览").click())
  expect(container.querySelector("img")?.getAttribute("src")).toBe(preview.dataUrl)
  await act(async () => listener({ sessionId: "other", activity: { ...activity, sessionId: "other", app: "其他窗口" } }))
  expect(container.textContent).not.toContain("其他窗口")
  await act(async () => listener({ sessionId: "original", activity: { ...activity, captureEnabled: false } }))
  expect(container.querySelector("img")).toBeNull()
  await act(async () => root.render(<ComputerActivityPanel sessionId="other" />))
  expect(container.querySelector("img")).toBeNull()
  expect(container.textContent).not.toContain("记事本")
  expect(detach).toHaveBeenCalledOnce()
  expect(control).toHaveBeenCalledExactlyOnceWith({ sessionId: "original", runId: "run", action: "pause" })
})

it("uses the exact visible run for pause, continue, and local stop", async () => {
  await act(async () => root.render(<ComputerActivityPanel sessionId="original" />))
  await act(async () => button("暂停并接管").click())
  await act(async () => listener({ sessionId: "original", activity: { ...activity, phase: "paused", preview: undefined } }))
  await act(async () => button("继续").click())
  await act(async () => button("停止电脑操作").click())
  expect(control.mock.calls).toEqual(["pause", "resume", "stop"].map(action => [{ sessionId: "original", runId: "run", action }]))
})

it("waits for cleanup confirmation before saying the user can take over", async () => {
  await act(async () => root.render(<ComputerActivityPanel sessionId="original" />))
  await act(async () => listener({ sessionId: "original", activity: {
    ...activity, phase: "paused", inputRelease: "pending", captureRevocation: "pending", preview: undefined,
  } }))
  expect(container.textContent).toContain("正在释放键鼠")
  expect(container.textContent).toContain("正在撤回后台待发送的截图")
  expect(container.textContent).not.toContain("你可以操作窗口")
  expect(button("继续").disabled).toBe(true)
  await act(async () => listener({ sessionId: "original", activity: { ...activity, phase: "paused", preview: undefined } }))
  expect(container.textContent).toContain("你可以操作窗口")
  expect(button("继续").disabled).toBe(false)
})

it("hides routine observation and successful completion while keeping cleanup problems visible", async () => {
  await act(async () => root.render(<ComputerActivityPanel sessionId="original" />))
  await act(async () => listener({ sessionId: "original", activity: { ...activity, phase: "observing", preview: undefined } }))
  expect(container.querySelector("section")).toBeNull()
  await act(async () => listener({ sessionId: "original", activity: {
    ...activity, phase: "stopped", preview: undefined, inputRelease: "pending",
  } }))
  expect(container.textContent).toContain("正在释放键鼠")
  expect(container.querySelector("button")).toBeNull()
  await act(async () => listener({ sessionId: "original", activity: {
    ...activity, phase: "stopped", preview: undefined, inputRelease: "failed",
  } }))
  expect(container.textContent).toContain("无法确认键鼠已释放")
  await act(async () => button("关闭提示").click())
  expect(container.querySelector("section")).toBeNull()
  await act(async () => listener({ sessionId: "original", activity: {
    ...activity, phase: "stopped", preview: undefined, evidence: "输入已释放",
  } }))
  expect(container.querySelector("section")).toBeNull()
})
