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
import { SessionMoreMenu } from "../session-more-menu"

let root: Root, host: HTMLDivElement
const source = emptySessionView("source").session
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  resetDesktopSessionStore()
  host = document.body.appendChild(document.createElement("div"))
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  resetDesktopSessionStore()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function item(label: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (node) => node.textContent === label && !node.closest("[data-closed]")
  )!
}
async function open() {
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!.click())
}
async function render(onFork = vi.fn()) {
  await act(async () =>
    root.render(
      <SessionMoreMenu
        session={source}
        onFork={onFork}
        onRename={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
      />
    )
  )
}

it("routes menu forks to confirmation instead of creating a session immediately", async () => {
  const fork = vi.fn(async () => source),
    onFork = vi.fn()
  useDesktopSessionStore.setState({ forkSession: fork })
  await render(onFork)
  await open()
  await act(async () => item("创建会话分支").click())
  expect(onFork).toHaveBeenCalledOnce()
  expect(fork).not.toHaveBeenCalled()
})

it("reports copy success and failure and disables repeated copying while pending", async () => {
  const success = vi.spyOn(toast, "success"),
    error = vi.spyOn(toast, "error")
  let finish!: () => void
  const writeText = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  vi.stubGlobal("desktop", { clipboard: { writeText } })
  await render()
  await open()
  await act(async () => item("复制").click())
  await act(async () => item("复制标题").click())
  expect(writeText).toHaveBeenCalledExactlyOnceWith(source.title)
  await open()
  expect(item("复制").getAttribute("aria-disabled")).toBe("true")
  await act(async () => finish())
  expect(success).toHaveBeenCalledWith("已复制")
  writeText.mockRejectedValueOnce(new Error("private clipboard error"))
  await act(async () => item("复制").click())
  await act(async () => item("复制工作目录").click())
  expect(error).toHaveBeenCalledWith("复制失败", "请重试。")
  expect(writeText).toHaveBeenCalledTimes(2)
})
