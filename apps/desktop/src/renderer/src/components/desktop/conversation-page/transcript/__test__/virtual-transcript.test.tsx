// @vitest-environment jsdom
import { ConversationFind } from "../conversation-find"
import { act, useLayoutEffect, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  ConversationScroller,
  ConversationScrollerProvider,
  ConversationScrollerViewport,
  ConversationScrollerContent,
  ConversationScrollerButton,
} from "../conversation-scroller"
import { useConversationScroller } from "../conversation-scroll-context"
import type { ScrollerAgentStatus } from "../scroller-agent-status"
import { VirtualTranscript, type TranscriptRow } from "../virtual-transcript"
import { ConversationPreviewRail } from "../conversation-preview-rail"
import { MessageBlock } from "../../message/blocks/message-block"
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  getNearestEditorFromDOMNode,
} from "lexical"
import { ConversationTranscript } from "../transcript"
import type { DesktopSessionMessage, DesktopSessionPart } from "@shared/session-types"

// Keep real row grouping, scroll controls and editors; replace only rich assistant rendering.
vi.mock("../../message/blocks/assistant-message", async () => {
  const { createElement } = await import("react")
  return {
    AssistantMessage: ({
      parts,
      initialPartIds,
    }: {
      parts: DesktopSessionPart[]
      initialPartIds?: ReadonlySet<string>
    }) =>
      parts.map((part) =>
        createElement(
          "p",
          {
            key: part.id,
            "data-part-id": part.id,
            "data-already-presented": initialPartIds?.has(part.id),
          },
          part.text
        )
      ),
  }
})

let root: Root
let container: HTMLDivElement
let scroller: NonNullable<ReturnType<typeof useConversationScroller>>
const heights = new Map<string, number>()
const observers = new Set<LayoutObserver>()
let measuredRows = 0
let viewportHeight = 480
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo")

class LayoutObserver {
  elements = new Set<Element>()
  constructor(private callback: ResizeObserverCallback) {
    observers.add(this)
  }
  observe(element: Element) {
    this.elements.add(element)
  }
  unobserve(element: Element) {
    this.elements.delete(element)
  }
  disconnect() {
    this.elements.clear()
    observers.delete(this)
  }
  flush() {
    const entries = [...this.elements]
      .filter((element) => element.isConnected)
      .map(
        (target) =>
          ({
            target,
            borderBoxSize: [
              {
                inlineSize: (target as HTMLElement).offsetWidth,
                blockSize: (target as HTMLElement).offsetHeight,
              },
            ],
            contentRect: target.getBoundingClientRect(),
          }) as unknown as ResizeObserverEntry
      )
    if (entries.length) this.callback(entries, this as unknown as ResizeObserver)
  }
}

function Probe() {
  const value = useConversationScroller()!
  useLayoutEffect(() => {
    scroller = value
  }, [value])
  return null
}
function rows(count: number): TranscriptRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `turn-${index}`,
    messageIds: [`prompt-${index}`],
    estimateSize: 120,
  }))
}
function render(
  items: TranscriptRow[],
  key = "chat",
  withRail = false,
  renderRow?: (index: number) => ReactNode,
  status?: ScrollerAgentStatus
) {
  root.render(
    <ConversationScrollerProvider key={key}>
      <Probe />
      <ConversationScrollerViewport>
        <ConversationScrollerContent>
          <VirtualTranscript
            rows={items}
            renderRow={renderRow ?? ((index) => <p>{items[index]!.id}</p>)}
          />
        </ConversationScrollerContent>
      </ConversationScrollerViewport>
      <ConversationScrollerButton status={status} />
      {withRail ? (
        <ConversationPreviewRail
          messages={items.map((item, index) => ({
            id: item.id,
            sessionId: "chat",
            inputId: item.messageIds[0],
            seq: index,
            role: "user",
            metadata: {},
            createdAt: index,
            updatedAt: index,
          }))}
          parts={[]}
          runs={[]}
          showReasoning={false}
        />
      ) : null}
    </ConversationScrollerProvider>
  )
}
async function settle() {
  await act(async () => {
    for (const observer of [...observers]) observer.flush()
    await vi.advanceTimersByTimeAsync(1000)
  })
}
function viewport() {
  return container.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')!
}
function row(index: number) {
  return container.querySelector<HTMLElement>(`[data-transcript-row="turn-${index}"]`)
}
function scroll(top: number) {
  const element = viewport()
  element.scrollTop = top
  element.dispatchEvent(new Event("scroll"))
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  vi.stubGlobal("ResizeObserver", LayoutObserver)
  heights.clear()
  measuredRows = 0
  viewportHeight = 480
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    const id = this.dataset.transcriptRow
    if (id) {
      measuredRows += 1
      return heights.get(id) ?? 120
    }
    return this.dataset.slot === "message-scroller-viewport" ? viewportHeight : 0
  })
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.slot === "message-scroller-viewport" ? viewportHeight : this.offsetHeight
  })
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    const content = this.querySelector<HTMLElement>("[data-virtual-transcript]")
    return Math.max(viewportHeight, Number.parseFloat(content?.style.height ?? "0") || 0)
  })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement
  ) {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1000,
      bottom: this.offsetHeight,
      width: 1000,
      height: this.offsetHeight,
      toJSON() {
        return {}
      },
    }
  })
  HTMLElement.prototype.scrollTo = function (options) {
    if (typeof options !== "object") return
    this.scrollTop = Math.max(0, Math.min(options.top ?? 0, this.scrollHeight - this.clientHeight))
    queueMicrotask(() => {
      if (this.isConnected) this.dispatchEvent(new Event("scroll"))
    })
  }
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  observers.clear()
  vi.restoreAllMocks()
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo)
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo")
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
})

it("mounts only the visible neighborhood of 1000 turns and starts at the latest turn", async () => {
  act(() => render(rows(1000)))
  await settle()
  expect(row(999)).not.toBeNull()
  expect(row(0)).toBeNull()
  expect(container.querySelectorAll("[data-transcript-row]").length).toBeLessThan(25)
  measuredRows = 0
  act(() => scroll(viewport().scrollTop - 20))
  await settle()
  expect(measuredRows).toBeLessThan(100)
})

it("keeps the reader's place while new turns arrive and a run finishes", async () => {
  act(() => render(rows(1000)))
  await settle()
  act(() => {
    expect(scroller.scrollToMessage("prompt-400")).toBe(true)
  })
  await settle()
  const before = viewport().scrollTop
  expect(row(400)).not.toBeNull()
  act(() => render(rows(1001)))
  await settle()
  expect(viewport().scrollTop).toBe(before)
  act(() => render(rows(1000)))
  await settle()
  expect(viewport().scrollTop).toBe(before)
  expect(row(400)).not.toBeNull()
})

it("follows appended turns and streaming height changes only while at the end", async () => {
  act(() => render(rows(1000)))
  await settle()
  act(() => render(rows(1001)))
  await settle()
  expect(row(1000)).not.toBeNull()
  const before = viewport().scrollTop
  heights.set("turn-1000", 420)
  await settle()
  expect(viewport().scrollTop).toBe(before + 300)
  expect(scroller.getSnapshot().atEnd).toBe(true)
})

it("aligns streaming growth in the measurement delivery without waiting another frame", async () => {
  act(() => render(rows(1000)))
  await settle()
  const before = viewport().scrollTop
  heights.set("turn-999", 420)
  await act(async () => {
    for (const observer of [...observers]) observer.flush()
  })
  expect(viewport().scrollTop).toBe(before + 300)
  expect(scroller.getSnapshot().atEnd).toBe(true)
})

it("keeps following when a layout shrink clamps its own scroll before the correction frame", async () => {
  act(() => render(rows(1000)))
  await settle()
  const element = viewport()
  const normalScrollTo = HTMLElement.prototype.scrollTo
  let clamped = true
  HTMLElement.prototype.scrollTo = function (options) {
    if (!clamped || this !== element || typeof options !== "object") {
      Reflect.apply(normalScrollTo, this, [options])
      return
    }
    // Chromium 的布局临时限位：位置已上移，但新尺寸尚未允许完全滚到底部。
    this.scrollTop = Math.max(
      0,
      Math.min(options.top ?? 0, this.scrollHeight - this.clientHeight) - 20
    )
    queueMicrotask(() => this.dispatchEvent(new Event("scroll")))
  }
  heights.set("turn-999", 60)
  await act(async () => {
    for (const observer of [...observers]) observer.flush()
  })
  expect(scroller.getSnapshot().following).toBe(true)
  clamped = false
  await settle()
  expect(scroller.getSnapshot().atEnd).toBe(true)
  expect(element.scrollHeight - element.clientHeight - element.scrollTop).toBeLessThanOrEqual(1)
})

it("gives upward intent priority when growth arrives before React commits the scroll mode", async () => {
  act(() => render(rows(1000)))
  await settle()
  const before = viewport().scrollTop
  await act(async () => {
    viewport().dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }))
    heights.set("turn-999", 420)
    for (const observer of [...observers]) observer.flush()
  })
  expect(viewport().scrollTop).toBe(before)
  expect(scroller.getSnapshot().following).toBe(false)
  await settle()
  expect(viewport().scrollTop).toBe(before)
})

it("follows reply growth before a footer and stays at the end when that footer disappears", async () => {
  const items = [
    ...rows(1000),
    { id: "status", messageIds: [], navigationId: "prompt-999", estimateSize: 32 },
  ]
  heights.set("status", 32)
  act(() => render(items))
  await settle()
  const before = viewport().scrollTop
  heights.set("turn-999", 420)
  await act(async () => {
    for (const observer of [...observers]) observer.flush()
  })
  expect(viewport().scrollTop).toBe(before + 300)
  expect(scroller.getSnapshot().atEnd).toBe(true)
  act(() => render(items.slice(0, -1)))
  await settle()
  expect(scroller.getSnapshot().atEnd).toBe(true)
  expect(scroller.getSnapshot().following).toBe(true)
  expect(row(999)).not.toBeNull()
})

it("honors upward intent before the native scroll event and resumes through jump to latest", async () => {
  act(() => render(rows(1000)))
  await settle()
  const before = viewport().scrollTop
  act(() => viewport().dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true })))
  act(() => render(rows(1001)))
  await settle()
  expect(viewport().scrollTop).toBe(before)
  expect(scroller.getSnapshot().following).toBe(false)
  act(() => container.querySelector<HTMLButtonElement>("button")!.click())
  await settle()
  expect(row(1000)).not.toBeNull()
  expect(scroller.getSnapshot().following).toBe(true)
})

it("navigates from the actual preview rail to an unmounted historical turn", async () => {
  act(() => render(rows(200), "chat", true))
  await settle()
  expect(row(10)).toBeNull()
  const navigation = container.querySelectorAll<HTMLButtonElement>(
    '[data-slot="preview-rail-item"]'
  )
  expect(navigation).toHaveLength(200)
  act(() => navigation[10]!.click())
  await settle()
  expect(row(10)).not.toBeNull()
  expect(scroller.getSnapshot().activeMessageId).toBe("prompt-10")
  expect(scroller.getSnapshot().following).toBe(false)
})

it("keeps following after clicking message content without scrolling", async () => {
  act(() => render(rows(1000)))
  await settle()
  act(() => row(999)!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })))
  heights.set("turn-999", 420)
  await settle()
  expect(scroller.getSnapshot().following).toBe(true)
  expect(scroller.getSnapshot().atEnd).toBe(true)
})

it("resumes following when the scrollbar is moved back to the end", async () => {
  act(() => render(rows(1000)))
  await settle()
  const bottom = viewport().scrollTop
  act(() => {
    scroll(bottom - 500)
  })
  await settle()
  expect(scroller.getSnapshot().following).toBe(false)
  act(() => scroll(bottom))
  await settle()
  expect(scroller.getSnapshot().following).toBe(true)
  heights.set("turn-999", 420)
  await settle()
  expect(scroller.getSnapshot().atEnd).toBe(true)
})

it("preserves an unsent edit while its turn is outside the visible range", async () => {
  const renderRow = (index: number) =>
    index === 999 ? (
      <MessageBlock
        message={{
          id: "user-999",
          inputId: "prompt-999",
          sessionId: "chat",
          role: "user",
          seq: 999,
          metadata: {},
          createdAt: 1,
          updatedAt: 1,
        }}
        parts={[
          {
            id: "text-999",
            messageId: "user-999",
            sessionId: "chat",
            seq: 999,
            type: "text",
            text: "original",
            status: "completed",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ]}
        inputItems={[{ type: "text", text: "original" }]}
        streaming={false}
        userActions={{ canEdit: true, onEdit: () => {} }}
        onOpenFile={() => {}}
        canOpenReview={false}
        onOpenReview={() => {}}
        onOpenTerminal={() => {}}
      />
    ) : (
      <p>turn-{index}</p>
    )
  act(() => render(rows(1000), "chat", false, renderRow))
  await settle()
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="重新编辑"]')!.click()
  )
  const textbox = container.querySelector<HTMLElement>('[role="textbox"]')!
  act(() => textbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })))
  expect(scroller.getSnapshot().following).toBe(true)
  const editor = getNearestEditorFromDOMNode(textbox)!
  await act(async () =>
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode("unsent draft")))
      },
      { discrete: true }
    )
  )
  act(() => scroller.scrollToMessage("prompt-10"))
  await settle()
  expect(container.querySelector('[role="textbox"]')).toBe(textbox)
  expect(textbox.textContent).toBe("unsent draft")
  act(() => textbox.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })))
  expect(scroller.getSnapshot().following).toBe(false)
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="取消编辑"]')!.click())
  await settle()
  expect(row(999)).toBeNull()
})

it("settles navigation with inaccurate estimates and preserves reading across viewport resizing", async () => {
  const items = rows(1000).map((item) => ({ ...item, estimateSize: 300 }))
  act(() => render(items))
  await settle()
  act(() => scroller.scrollToMessage("prompt-400"))
  await settle()
  expect(row(400)).not.toBeNull()
  const offset = Number.parseFloat(
    row(400)!.style.transform.match(/translate3d\(0, ([-\d.]+)px, 0\)/)![1]!
  )
  expect(Math.abs(viewport().scrollTop - offset)).toBeLessThanOrEqual(28)
  const before = viewport().scrollTop
  viewportHeight = 720
  await settle()
  expect(viewport().scrollTop).toBe(before)
  expect(scroller.getSnapshot().following).toBe(false)
  act(() => scroller.scrollToEnd())
  await settle()
  viewportHeight = 600
  await settle()
  expect(scroller.getSnapshot().atEnd).toBe(true)
})

it("keeps rail selection on the preceding turn for system rows and does not replay a running reply on remount", async () => {
  const messages: DesktopSessionMessage[] = []
  const parts: DesktopSessionPart[] = []
  for (let index = 0; index < 200; index++) {
    messages.push(
      {
        id: `user-${index}`,
        sessionId: "chat",
        seq: index * 3,
        inputId: `prompt-${index}`,
        role: "user",
        metadata: {},
        createdAt: index,
        updatedAt: index,
      },
      {
        id: `assistant-${index}`,
        sessionId: "chat",
        seq: index * 3 + 1,
        inputId: `prompt-${index}`,
        role: "assistant",
        metadata: {},
        createdAt: index,
        updatedAt: index,
      }
    )
    if (index < 199)
      parts.push({
        id: `reply-${index}`,
        sessionId: "chat",
        messageId: `assistant-${index}`,
        seq: index,
        type: "text",
        status: "completed",
        text: `reply ${index}`,
        metadata: {},
        createdAt: index,
        updatedAt: index,
      })
  }
  messages.push({
    id: "system-100",
    sessionId: "chat",
    seq: 302,
    role: "system",
    metadata: {},
    createdAt: 100,
    updatedAt: 100,
  })
  const props = {
    messages,
    parts,
    runs: [],
    running: true,
    canEditLastUserMessage: false,
    onEditLastUserMessage: () => {},
    onCopyAssistantMessage: () => {},
    onOpenFile: () => {},
    canOpenReview: false,
    onOpenReview: () => {},
    onOpenTerminal: () => {},
  }
  const renderTranscript = (nextParts: DesktopSessionPart[]) =>
    root.render(
      <ConversationScrollerProvider>
        <Probe />
        <ConversationScrollerViewport>
          <ConversationScrollerContent>
            <ConversationTranscript {...props} parts={nextParts} />
          </ConversationScrollerContent>
        </ConversationScrollerViewport>
      </ConversationScrollerProvider>
    )
  act(() => renderTranscript(parts))
  await settle()
  const livePart: DesktopSessionPart = {
    ...parts[0]!,
    id: "reply-199",
    messageId: "assistant-199",
    seq: 199,
    status: "running",
    text: "new reply",
  }
  act(() => renderTranscript([...parts, livePart]))
  await settle()
  expect(
    container.querySelector('[data-part-id="reply-199"]')?.getAttribute("data-already-presented")
  ).toBe("false")
  act(() => scroller.scrollToMessage("system-100"))
  await settle()
  expect(scroller.getSnapshot().activeMessageId).toBe("prompt-100")
  expect(container.querySelector('[data-part-id="reply-199"]')).toBeNull()
  act(() =>
    renderTranscript([...parts, { ...livePart, text: "new reply appended", updatedAt: 201 }])
  )
  expect(scroller.getSnapshot().hasNewContent).toBe(true)
  act(() => scroller.scrollToMessage("prompt-199"))
  await settle()
  expect(
    container.querySelector('[data-part-id="reply-199"]')?.getAttribute("data-already-presented")
  ).toBe("true")
  expect(container.textContent).toContain("new reply appended")
})

it("compensates height changes above the reader without shifting for growth below the reading point", async () => {
  act(() => render(rows(1000)))
  await settle()
  act(() => scroller.scrollToMessage("prompt-400"))
  await settle()
  const before = viewport().scrollTop
  heights.set("turn-399", 320)
  await settle()
  expect(viewport().scrollTop).toBe(before + 200)
  act(() => scroll(viewport().scrollTop + 40))
  const within = viewport().scrollTop
  heights.set("turn-400", 520)
  await settle()
  expect(viewport().scrollTop).toBe(within)
})

it("navigates to unmounted turns and resets the scroll state on conversation changes", async () => {
  act(() => render(rows(1000)))
  await settle()
  expect(row(10)).toBeNull()
  act(() => {
    expect(scroller.scrollToMessage("prompt-10")).toBe(true)
  })
  await settle()
  expect(row(10)).not.toBeNull()
  expect(scroller.getSnapshot().activeMessageId).toBe("prompt-10")
  act(() => {
    expect(scroller.scrollToMessage("missing")).toBe(false)
  })
  act(() => render(rows(1000), "another-chat"))
  await settle()
  expect(row(999)).not.toBeNull()
  expect(scroller.getSnapshot().following).toBe(true)
})

it("reuses measured heights after offscreen remounts and rebuilding rows with the same IDs", async () => {
  const items = rows(1000)
  heights.set("turn-400", 620)
  act(() => render(items))
  await settle()
  act(() => scroller.scrollToMessage("prompt-400"))
  await settle()
  const measuredTotal = viewport().scrollHeight
  act(() => scroller.scrollToEnd())
  await settle()
  expect(row(400)).toBeNull()
  expect(viewport().scrollHeight).toBe(measuredTotal)

  act(() => render(items.map((item) => ({ ...item }))))
  // 在新的 ResizeObserver 回调前，已测得的行高就应继续有效。
  expect(viewport().scrollHeight).toBe(measuredTotal)
  act(() => scroller.scrollToMessage("prompt-400"))
  await settle()
  expect(row(400)).not.toBeNull()
  expect(viewport().scrollHeight).toBe(measuredTotal)
  expect(scroller.getSnapshot().activeMessageId).toBe("prompt-400")
})

it("shows unread updates without moving the reader and clears them on return to latest", async () => {
  act(() => render(rows(100), "chat", false, undefined, { kind: "processing", title: "正在处理" }))
  await settle()
  act(() => scroller.scrollToMessage("prompt-40"))
  await settle()
  const before = viewport().scrollTop
  act(() => scroller.notifyContentChanged())
  expect(viewport().scrollTop).toBe(before)
  const button = container.querySelector<HTMLButtonElement>("button")!
  expect(button.textContent).toBe("回到最新")
  expect(button.getAttribute("aria-label")).toContain("有新内容")
  expect(button.getAttribute("aria-label")).toContain("正在处理")
  act(() => button.click())
  await settle()
  expect(scroller.getSnapshot().following).toBe(true)
  expect(container.textContent).not.toContain("有新内容")
})

it("does not detach following for a wheel consumed by a nested tool output", async () => {
  act(() =>
    render(rows(100), "chat", false, () => <pre style={{ overflowY: "auto" }}>tool output</pre>)
  )
  await settle()
  const output = row(99)!.querySelector("pre")!
  Object.defineProperties(output, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 500 },
  })
  output.scrollTop = 200
  act(() => output.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true })))
  expect(scroller.getSnapshot().following).toBe(true)
  output.scrollTop = 0
  act(() => output.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true })))
  expect(scroller.getSnapshot().following).toBe(false)
})

it("does not counter a backward gesture when an already measured row above it changes height", async () => {
  act(() => render(rows(1000)))
  await settle()
  act(() => scroller.scrollToMessage("prompt-400"))
  await settle()
  act(() => {
    viewport().dispatchEvent(new WheelEvent("wheel", { deltaY: -30, bubbles: true }))
    scroll(viewport().scrollTop - 30)
  })
  const before = viewport().scrollTop
  expect(row(397)).not.toBeNull()
  heights.set("turn-397", 320)
  await act(async () => {
    for (const observer of [...observers]) observer.flush()
    await vi.advanceTimersByTimeAsync(16)
  })
  expect(scroller.getSnapshot().following).toBe(false)
  expect(viewport().scrollTop).toBe(before)
})

it("opens a global search target outside the virtual window and expands its long user text", async () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({
    id: `user-${index}`, sessionId: "chat", role: "user" as const, seq: index,
    inputId: `input-${index}`, metadata: {}, createdAt: index, updatedAt: index,
  }))
  const parts = messages.map((message, index) => ({
    id: `part-${index}`, sessionId: "chat", messageId: message.id, seq: 1,
    type: "text" as const, status: "completed" as const,
    text: index === 40 ? "长正文".repeat(400) + " needle" : "message " + index,
    metadata: {}, createdAt: index, updatedAt: index,
  }))
  act(() => root.render(
    <ConversationScrollerProvider><Probe /><ConversationScroller>
      <ConversationFind messages={messages} parts={parts} target={{ sessionId: "chat", messageId: "user-40", query: "needle" }} />
      <ConversationScrollerViewport><ConversationScrollerContent>
        <ConversationTranscript messages={messages} parts={parts} runs={[]} running={false}
          canEditLastUserMessage={false} onEditLastUserMessage={() => {}} onCopyAssistantMessage={() => {}}
          onOpenFile={() => {}} canOpenReview={false} onOpenReview={() => {}} onOpenTerminal={() => {}} />
      </ConversationScrollerContent></ConversationScrollerViewport>
    </ConversationScroller></ConversationScrollerProvider>
  ))
  await settle()
  const target = container.querySelector<HTMLElement>('[data-chat-search-message="user-40"]')
  expect(target).not.toBeNull()
  expect(target!.textContent).toContain("needle")
  expect(target!.classList.contains("max-h-72")).toBe(false)
  expect(target!.getAttribute("data-search-active")).toBe("true")
  expect(scroller.getSnapshot().following).toBe(false)
  expect(container.querySelectorAll("[data-transcript-row]").length).toBeLessThan(25)
})
