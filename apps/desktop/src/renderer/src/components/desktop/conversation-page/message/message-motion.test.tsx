// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import type { DesktopSessionPart } from "@shared/session-types"
import { AssistantMessage } from "./assistant-message"
import { ContentEntrance } from "./content-entrance"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
  vi.useRealTimers()
})

it("does not animate a historical item when its eligibility later changes", () => {
  act(() => root.render(<ContentEntrance animate={false}>历史消息</ContentEntrance>))
  act(() => root.render(<ContentEntrance animate>历史消息</ContentEntrance>))
  expect(container.firstElementChild?.hasAttribute("data-content-enter")).toBe(false)
})

it("keeps one entrance across optimistic handoff and never restarts it", () => {
  vi.useFakeTimers()
  act(() => root.render(<ContentEntrance animate>本地消息</ContentEntrance>))
  const entrance = container.firstElementChild!
  expect(entrance.hasAttribute("data-content-enter")).toBe(true)

  act(() => root.render(<ContentEntrance animate={false}>正式消息</ContentEntrance>))
  expect(container.firstElementChild).toBe(entrance)
  expect(entrance.hasAttribute("data-content-enter")).toBe(true)
  act(() => vi.advanceTimersByTime(250))
  expect(entrance.hasAttribute("data-content-enter")).toBe(false)
  vi.useRealTimers()

  act(() => root.render(<ContentEntrance animate>正式消息更新</ContentEntrance>))
  expect(entrance.hasAttribute("data-content-enter")).toBe(false)
})

const callbacks = {
  onOpenFile: () => undefined,
  canOpenReview: false,
  onOpenReview: () => undefined,
  onOpenTerminal: () => undefined,
}

function part(text: string): DesktopSessionPart {
  return {
    id: "text-1",
    sessionId: "chat",
    messageId: "assistant",
    seq: 1,
    type: "text",
    status: "running",
    text,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

async function renderReply(text: string, streaming: boolean, initialPartIds = new Set<string>()) {
  await act(async () =>
    root.render(
      <AssistantMessage
        {...callbacks}
        parts={[part(text)]}
        streaming={streaming}
        initialPartIds={initialPartIds}
      />
    )
  )
}

it("reveals Chinese characters without queued delays and removes wrappers on completion", async () => {
  await renderReply("你好世界", true)
  const spans = [...container.querySelectorAll<HTMLElement>("[data-sd-animate]")]
  expect(spans.map((span) => span.textContent)).toEqual(["你", "好", "世", "界"])
  expect(spans.every((span) => !parseFloat(span.style.getPropertyValue("--sd-delay")))).toBe(true)
  expect(container.querySelector('[data-stream-initial="true"]')).toBeNull()

  await renderReply("你好世界", false)
  expect(container.textContent).toContain("你好世界")
  expect(container.querySelector("[data-sd-animate]")).toBeNull()
})

it("keeps a restored streaming prefix settled while revealing only appended text", async () => {
  const initialPartIds = new Set(["text-1"])
  await renderReply("已经显示", true, initialPartIds)
  expect(container.querySelector('[data-stream-initial="true"]')).not.toBeNull()

  await renderReply("已经显示新增", true, initialPartIds)
  expect(container.querySelector('[data-stream-initial="true"]')).toBeNull()
  const spans = [...container.querySelectorAll<HTMLElement>("[data-sd-animate]")]
  expect(
    spans.slice(0, 4).every((span) => span.style.getPropertyValue("--sd-duration") === "0ms")
  ).toBe(true)
  expect(spans.slice(4).map((span) => span.textContent)).toEqual(["新", "增"])
  expect(
    spans.slice(4).every((span) => parseFloat(span.style.getPropertyValue("--sd-duration")) > 0)
  ).toBe(true)
})

it("does not animate completed history", async () => {
  await renderReply("历史正文", false)
  expect(container.querySelector("[data-sd-animate]")).toBeNull()
  expect(container.textContent).toContain("历史正文")
})

it("enters a new standalone tool once and leaves restored tools settled", async () => {
  const tool: DesktopSessionPart = {
    ...part(""),
    id: "tool-1",
    type: "tool",
    toolName: "read_file",
  }
  await act(async () =>
    root.render(
      <AssistantMessage
        {...callbacks}
        parts={[tool]}
        streaming
        initialPartIds={new Set(["tool-1"])}
      />
    )
  )
  expect(container.querySelector("[data-content-enter]")).toBeNull()
  act(() => root.unmount())
  root = createRoot(container)
  await act(async () =>
    root.render(
      <AssistantMessage {...callbacks} parts={[tool]} streaming initialPartIds={new Set()} />
    )
  )
  expect(container.querySelector("[data-content-enter]")).not.toBeNull()
  await act(async () =>
    root.render(
      <AssistantMessage
        {...callbacks}
        parts={[{ ...tool, status: "completed" }]}
        streaming={false}
        initialPartIds={new Set()}
      />
    )
  )
  expect(container.textContent).toContain("读取文件")
  expect(container.textContent).not.toContain("工具查看 1 次")
})
