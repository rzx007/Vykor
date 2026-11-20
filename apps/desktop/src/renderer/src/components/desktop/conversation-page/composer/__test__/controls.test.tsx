// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ComposerSendButton } from "../controls"

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
  vi.unstubAllGlobals()
})

it("shows stopping feedback and prevents repeated stop clicks", () => {
  let interrupts = 0
  act(() =>
    root.render(
      <ComposerSendButton
        sending={false}
        running
        interrupting
        hasContent
        disabled={false}
        onInterrupt={() => {
          interrupts++
        }}
      />
    )
  )

  const button = container.querySelector<HTMLButtonElement>('button[aria-label="正在停止"]')
  expect(button).not.toBeNull()
  expect(button!.disabled).toBe(true)
  expect(button!.getAttribute("aria-busy")).toBe("true")
  act(() => button!.click())
  expect(interrupts).toBe(0)
})

it("keeps stopping feedback when a send is still settling", () => {
  act(() => root.render(<ComposerSendButton sending running interrupting hasContent disabled={false} />))
  expect(container.querySelector('button[aria-label="正在停止"][aria-busy="true"]')).not.toBeNull()
})

it("uses one button to send a running follow-up, then stop after the draft is cleared", () => {
  const onInterrupt = vi.fn()
  const render = (hasContent: boolean, disabled: boolean) => act(() =>
    root.render(<ComposerSendButton sending={false} running hasContent={hasContent} disabled={disabled} onInterrupt={onInterrupt} />)
  )
  render(true, false)
  expect(container.querySelectorAll("button")).toHaveLength(1)
  const button = container.querySelector("button")!
  expect(button.getAttribute("aria-label")).toBe("发送")
  expect(button.type).toBe("submit")

  render(true, true)
  expect(button.getAttribute("aria-label")).toBe("发送")
  expect(button.disabled).toBe(true)

  render(false, true)
  expect(container.querySelector("button")).toBe(button)
  expect(button.getAttribute("aria-label")).toBe("停止生成")
  act(() => button.click())
  expect(onInterrupt).toHaveBeenCalledOnce()
})

it("lets an empty composer stop a running task and restores send after it settles", () => {
  let interrupts = 0
  act(() =>
    root.render(
      <ComposerSendButton
        sending={false}
        running
        hasContent={false}
        disabled
        onInterrupt={() => {
          interrupts++
        }}
      />
    )
  )
  const stop = container.querySelector<HTMLButtonElement>('button[aria-label="停止生成"]')!
  expect(stop.disabled).toBe(false)
  act(() => stop.click())
  expect(interrupts).toBe(1)

  act(() => root.render(<ComposerSendButton sending={false} running={false} hasContent disabled={false} />))
  const send = container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!
  expect(send.disabled).toBe(false)
  expect(send.getAttribute("aria-busy")).toBeNull()
})
