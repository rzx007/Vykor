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
  act(() => root.render(<ComposerSendButton sending running interrupting disabled={false} />))
  expect(container.querySelector('button[aria-label="正在停止"][aria-busy="true"]')).not.toBeNull()
})

it("lets an empty composer stop a running task and restores send after it settles", () => {
  let interrupts = 0
  act(() =>
    root.render(
      <ComposerSendButton
        sending={false}
        running
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

  act(() => root.render(<ComposerSendButton sending={false} running={false} disabled={false} />))
  const send = container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!
  expect(send.disabled).toBe(false)
  expect(send.getAttribute("aria-busy")).toBeNull()
})
