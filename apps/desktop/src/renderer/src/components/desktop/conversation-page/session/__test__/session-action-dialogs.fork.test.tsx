// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { toast } from "@renderer/lib/toast"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import {
  emptySessionView,
  resetDesktopSessionStore,
} from "@renderer/stores/desktop-session/store-test-fixtures"
import { useSessionActionDialogs } from "../session-action-dialogs"

const router = vi.hoisted(() => ({ navigate: vi.fn(async () => {}) }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => router.navigate }))
const source = emptySessionView("source").session
const forked = emptySessionView("branch").session
let root: Root, host: HTMLDivElement
function Harness() {
  const actions = useSessionActionDialogs()
  return (
    <>
      <button onClick={() => actions.beginFork?.(source, "reply")}>消息分叉入口</button>
      <button onClick={() => actions.beginFork?.(source)}>整段分叉入口</button>
      {actions.dialogs}
    </>
  )
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  resetDesktopSessionStore()
  router.navigate.mockReset().mockResolvedValue(undefined)
  host = document.body.appendChild(document.createElement("div"))
  root = createRoot(host)
  useDesktopSessionStore.setState({
    activeSessionId: source.id,
    sessionView: emptySessionView(source.id),
    sessions: [source],
    refreshContextUsage: vi.fn(async () => {}),
    refreshGoal: vi.fn(async () => {}),
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  resetDesktopSessionStore()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === label
  )!
}

it("requires confirmation, keeps failures retryable and blocks repeated confirmation while pending", async () => {
  const success = vi.spyOn(toast, "success")
  let finish!: (value: typeof forked) => void
  const fork = vi.fn(
    () =>
      new Promise<typeof forked>((resolve) => {
        finish = resolve
      })
  )
  vi.stubGlobal("desktop", {
    sessions: { fork, open: vi.fn(async (id: string) => emptySessionView(id)) },
  })
  await act(async () => root.render(<Harness />))
  await act(async () => button("消息分叉入口").click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(fork).not.toHaveBeenCalled()
  await act(async () => button("取消").click())
  expect(fork).not.toHaveBeenCalled()
  await act(async () => button("消息分叉入口").click())
  const confirm = button("创建分支")
  await act(async () => {
    confirm.click()
    confirm.click()
  })
  expect(fork).toHaveBeenCalledExactlyOnceWith({ sessionId: source.id, afterMessageId: "reply" })
  expect(confirm.disabled).toBe(true)
  expect(button("取消").disabled).toBe(true)
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  })
  expect(document.querySelector('[role="dialog"][data-open]')).not.toBeNull()
  expect(fork).toHaveBeenCalledTimes(1)
  await act(async () => finish(forked))
  expect(success).toHaveBeenCalledWith("已创建会话分支")
  expect(router.navigate).toHaveBeenCalledWith({
    to: "/conversation/$sessionId",
    params: { sessionId: forked.id },
  })

  fork.mockRejectedValueOnce(new Error("internal server details"))
  await act(async () => button("整段分叉入口").click())
  await act(async () => button("创建分支").click())
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("创建分支失败，请重试。")
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(
    "internal server details"
  )
  fork.mockResolvedValueOnce(forked)
  await act(async () => button("创建分支").click())
  expect(fork).toHaveBeenCalledTimes(3)
})

it("does not navigate back to a late branch after the user opens another chat", async () => {
  let finish!: (value: typeof forked) => void
  const fork = vi.fn(
    () =>
      new Promise<typeof forked>((resolve) => {
        finish = resolve
      })
  )
  vi.stubGlobal("desktop", {
    sessions: { fork, open: vi.fn(async (id: string) => emptySessionView(id)) },
  })
  await act(async () => root.render(<Harness />))
  await act(async () => button("消息分叉入口").click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () => button("创建分支").click())
  await act(async () => {
    await useDesktopSessionStore.getState().openSession("other")
  })
  await act(async () => finish(forked))
  expect(useDesktopSessionStore.getState().activeSessionId).toBe("other")
  expect(router.navigate).not.toHaveBeenCalled()
  expect(fork).toHaveBeenCalledTimes(1)
})

it("reports an open failure after creation without offering to create the branch again", async () => {
  const error = vi.spyOn(toast, "error")
  router.navigate.mockRejectedValueOnce(new Error("route unavailable"))
  const fork = vi.fn(async () => forked)
  vi.stubGlobal("desktop", {
    sessions: { fork, open: vi.fn(async (id: string) => emptySessionView(id)) },
  })
  await act(async () => root.render(<Harness />))
  await act(async () => button("消息分叉入口").click())
  await act(async () => button("创建分支").click())
  expect(fork).toHaveBeenCalledTimes(1)
  expect(error).toHaveBeenCalledWith("分支已创建，打开失败", "请从侧栏打开新分支。")
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
