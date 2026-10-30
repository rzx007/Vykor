// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { DesktopSessionMessage } from "@shared/session-types"
import { AssistantMessageActions } from "../message-actions"

let root: Root, host: HTMLDivElement
const message = { id: "m1", sessionId: "s", updatedAt: 1 } as DesktopSessionMessage
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  host = document.body.appendChild(document.createElement("div"))
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const getButton = (label: string) =>
  host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
async function render(
  onCopy: () => Promise<void>,
  onFork?: () => Promise<void>,
  current = message
) {
  await act(async () =>
    root.render(
      <AssistantMessageActions
        message={current}
        content="原始正文"
        disabled={false}
        onCopy={onCopy}
        onFork={onFork}
      />
    )
  )
}
it("waits for a copy result, blocks same-frame repeats and allows retry after failure", async () => {
  let reject!: (error: Error) => void
  const copy = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail
      })
  )
  await render(copy)
  const button = getButton("复制回复")
  await act(async () => {
    button.click()
    button.click()
  })
  expect(copy).toHaveBeenCalledTimes(1)
  expect(getButton("正在复制回复").disabled).toBe(true)
  await act(async () => reject(new Error("private filesystem details")))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("复制失败，请重试")
  expect(host.textContent).not.toContain("private filesystem")
  copy.mockImplementation(async () => {})
  await act(async () => getButton("重试复制回复").click())
  expect(copy).toHaveBeenCalledTimes(2)
  expect(getButton("已复制")).not.toBeNull()
  await act(async () => vi.advanceTimersByTimeAsync(1400))
  expect(getButton("复制回复")).not.toBeNull()
})
it("awaits forks, blocks duplicate clicks and reports failure beside the action", async () => {
  let reject!: (error: Error) => void
  const fork = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail
      })
  )
  await render(async () => {}, fork)
  const button = getButton("从这条回复分叉")
  await act(async () => {
    button.click()
    button.click()
  })
  expect(fork).toHaveBeenCalledTimes(1)
  expect(getButton("正在创建分叉").disabled).toBe(true)
  await act(async () => reject(new Error("network")))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("创建分叉失败，请重试")
  fork.mockImplementation(async () => {})
  await act(async () => getButton("重试从这条回复分叉").click())
  expect(getButton("已创建分叉")).not.toBeNull()
})
it("does not show an old copy result on a different message", async () => {
  let finish!: () => void
  const copy = () =>
    new Promise<void>((resolve) => {
      finish = resolve
    })
  await render(copy)
  await act(async () => getButton("复制回复").click())
  await render(async () => {}, undefined, { ...message, id: "m2" })
  expect(getButton("复制回复").disabled).toBe(false)
  await act(async () => finish())
  expect(getButton("已复制")).toBeNull()
})
