// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { toast } from "@renderer/lib/toast"
import { AssistantMessageActions, CopyActionButton } from "../message-actions"
import type { DesktopSessionMessage } from "@shared/session-types"

let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  host = document.body.appendChild(document.createElement("div"))
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it("blocks same-frame repeated copies and reports pending, success and failure", async () => {
  vi.useFakeTimers()
  const success = vi.spyOn(toast, "success"),
    error = vi.spyOn(toast, "error")
  let finish!: () => void
  const onCopy = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  await act(async () =>
    root.render(<CopyActionButton label="复制回复" copiedLabel="已复制" onCopy={onCopy} />)
  )
  const button = host.querySelector("button")!
  await act(async () => {
    button.click()
    button.click()
  })
  expect(onCopy).toHaveBeenCalledTimes(1)
  expect(button.disabled).toBe(true)
  expect(button.getAttribute("aria-busy")).toBe("true")
  expect(success).not.toHaveBeenCalled()
  await act(async () => finish())
  expect(success).toHaveBeenCalledExactlyOnceWith("已复制")
  expect(button.getAttribute("aria-label")).toBe("已复制")
  await act(async () => vi.advanceTimersByTime(1400))
  expect(button.getAttribute("aria-label")).toBe("复制回复")
  onCopy.mockRejectedValueOnce(new Error("internal clipboard details"))
  await act(async () => button.click())
  expect(error).toHaveBeenCalledWith("复制失败", "请重试。")
  expect(button.disabled).toBe(false)
  expect(button.getAttribute("aria-label")).toBe("复制回复")
})

it("keeps a late copy result from marking a different message as copied", async () => {
  let finish!: () => void
  const copy = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const message: DesktopSessionMessage = {
    id: "old",
    sessionId: "chat",
    role: "assistant",
    seq: 1,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
  await act(async () =>
    root.render(
      <AssistantMessageActions
        message={message}
        content="old text"
        disabled={false}
        onCopy={copy}
      />
    )
  )
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="复制回复"]')!.click())
  await act(async () =>
    root.render(
      <AssistantMessageActions
        message={{ ...message, id: "new" }}
        content="new text"
        disabled={false}
        onCopy={copy}
      />
    )
  )
  await act(async () => finish())
  expect(host.querySelector('[aria-label="已复制"]')).toBeNull()
  expect(host.querySelector<HTMLButtonElement>('[aria-label="复制回复"]')!.disabled).toBe(false)
})
