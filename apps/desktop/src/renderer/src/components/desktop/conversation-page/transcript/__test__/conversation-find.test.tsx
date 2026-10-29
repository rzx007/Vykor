// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { ConversationFind } from "../conversation-find"
import {
  ConversationScrollerProvider,
  ConversationScrollerViewport,
} from "../conversation-scroller"
import { useConversationScroller } from "../conversation-scroll-context"
import type { DesktopSessionMessage, DesktopSessionPart } from "@shared/session-types"

const messages = ["one", "two"].map((id, seq) => ({
  id,
  seq,
  role: "user",
  sessionId: "chat",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
})) as DesktopSessionMessage[]
const parts = messages.map((m) => ({
  id: `p-${m.id}`,
  messageId: m.id,
  sessionId: "chat",
  seq: m.seq,
  type: "text",
  text: "hello 世界",
  status: "completed",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
})) as DesktopSessionPart[]
let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.unstubAllGlobals()
})

it("opens with Ctrl+F, navigates matching messages and clears the reveal on Escape", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  dispose = () => {
    act(() => root.unmount())
    container.remove()
  }
  let scroller: NonNullable<ReturnType<typeof useConversationScroller>>
  const navigated: string[] = []
  function Probe() {
    scroller = useConversationScroller()!
    scroller.registerNavigation({
      hasMessage: () => true,
      scrollToMessage: (id) => navigated.push(id),
      scrollToEnd: () => {},
    })
    return null
  }
  act(() =>
    root.render(
      <section>
        <ConversationScrollerProvider>
          <Probe />
          <ConversationFind messages={messages} parts={parts} />
          <ConversationScrollerViewport />
        </ConversationScrollerProvider>
      </section>
    )
  )
  const viewport = container.querySelector('[data-slot="message-scroller-viewport"]')!
  act(() =>
    viewport.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true })
    )
  )
  const input = container.querySelector("input")!
  expect(input).not.toBeNull()
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "世界")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  expect(navigated.at(-1)).toBe("one")
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="下一个搜索结果"]')!.click())
  expect(navigated.at(-1)).toBe("two")
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="下一个搜索结果"]')!.click())
  expect(navigated.at(-1)).toBe("one")
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
  expect(scroller!.getSnapshot().searchMatch).toBeNull()
  expect(container.querySelector("input")).toBeNull()
})

it("does not intercept find shortcuts outside the chat or while composing", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  dispose = () => {
    act(() => root.unmount())
    container.remove()
  }
  act(() =>
    root.render(
      <ConversationScrollerProvider>
        <ConversationFind messages={messages} parts={parts} />
        <ConversationScrollerViewport />
      </ConversationScrollerProvider>
    )
  )
  const outside = document.createElement("input")
  document.body.append(outside)
  const event = new KeyboardEvent("keydown", {
    key: "f",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  })
  act(() => outside.dispatchEvent(event))
  expect(event.defaultPrevented).toBe(false)
  expect(container.querySelector("input")).toBeNull()
  outside.remove()
  const viewport = container.querySelector('[data-slot="message-scroller-viewport"]')!
  act(() =>
    viewport.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: true,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      })
    )
  )
  expect(container.querySelector("input")).toBeNull()
})

it("repositions when the same global result is explicitly chosen again", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  dispose = () => {
    act(() => root.unmount())
    container.remove()
  }
  const navigated: string[] = []
  function Probe() {
    useConversationScroller()!.registerNavigation({
      hasMessage: () => true,
      scrollToMessage: (id) => navigated.push(id),
      scrollToEnd: () => {},
    })
    return null
  }
  function show() {
    act(() =>
      root.render(
        <ConversationScrollerProvider>
          <Probe />
          <ConversationFind
            messages={messages}
            parts={parts}
            target={{ sessionId: "chat", messageId: "two", query: "hello" }}
          />
          <ConversationScrollerViewport />
        </ConversationScrollerProvider>
      )
    )
  }
  show()
  const first = navigated.length
  expect(navigated.at(-1)).toBe("two")
  show()
  expect(navigated.length).toBeGreaterThan(first)
})
