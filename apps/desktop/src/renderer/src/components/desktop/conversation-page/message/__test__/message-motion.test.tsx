// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MotionConfig } from "motion/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import type { DesktopSessionPart } from "@shared/session-types"
import { AssistantMessage } from "../assistant-message"
import { ContentEntrance } from "../content-entrance"

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

it("uses StreamingResponse and the demo cursor without additional character animation", async () => {
  vi.useFakeTimers()
  await renderReply("你好世界", true)
  const response = container.querySelector('[data-state="streaming"]')
  expect(response?.getAttribute("aria-busy")).toBe("true")
  expect(container.textContent).toBe("")
  await act(async () => vi.advanceTimersByTimeAsync(64))
  expect(container.textContent).toBe("你好世界")
  expect(container.querySelector("[data-sd-animate]")).toBeNull()
  expect(container.querySelector("button")).toBeNull()

  await renderReply("你好世界", false)
  expect(container.textContent).toContain("你好世界")
  expect(container.querySelector('[data-state="complete"]')).toBe(response)
})

it("keeps a restored streaming prefix settled while revealing only appended text", async () => {
  vi.useFakeTimers()
  const initialPartIds = new Set(["text-1"])
  await renderReply("已经显示", true, initialPartIds)
  const paragraph = container.querySelector("p")
  expect(container.querySelector('[data-stream-initial="true"]')).not.toBeNull()

  await renderReply("已经显示新增", true, initialPartIds)
  expect(container.textContent).toBe("已经显示")
  await act(async () => vi.advanceTimersByTimeAsync(64))
  expect(container.querySelector('[data-stream-initial="true"]')).toBeNull()
  expect(container.textContent).toBe("已经显示新增")
  expect(container.querySelector("p")).toBe(paragraph)
  expect(container.querySelector("[data-sd-animate]")).toBeNull()
})

it("does not animate completed history", async () => {
  await renderReply("历史正文", false)
  expect(container.querySelector("[data-sd-animate]")).toBeNull()
  expect(container.textContent).toContain("历史正文")
})

it("bounds long-reply DOM nodes and preserves appended Markdown", async () => {
  vi.useFakeTimers()
  await renderReply("简短开头", true)
  await act(async () => vi.advanceTimersByTimeAsync(64))

  const longText = "长正文内容。".repeat(400)
  await renderReply(`${longText}\n\n1. 普通列表文字与 \`inlineCode\``, true)
  expect(container.querySelector("[data-sd-animate]")).toBeNull()
  expect(container.textContent).toContain(longText)
  expect(container.querySelector("li")?.textContent).toContain("普通列表文字")
  expect(container.querySelector("code")?.textContent).toBe("inlineCode")

  await renderReply(`${longText}\n\n后续内容`, true)
  expect(container.querySelector("[data-sd-animate]")).toBeNull()
  expect(container.textContent).toContain("后续内容")
  await renderReply(`${longText}\n\n最终内容`, false)
  expect(container.querySelector("[data-sd-animate]")).toBeNull()
  expect(container.textContent).toContain("最终内容")
})

it("finishes displaying received text before the response surface reports completion", async () => {
  vi.useFakeTimers()
  const text = "正文".repeat(55)
  await renderReply(text, true)
  await renderReply(text, false)
  expect(container.querySelector('[data-state="streaming"]')).not.toBeNull()
  await act(async () => vi.advanceTimersByTimeAsync(512))
  expect(container.textContent!.length).toBeGreaterThanOrEqual(55)
  expect(container.textContent!.length).toBeLessThan(110)
  await act(async () => vi.advanceTimersByTimeAsync(512))
  expect(container.textContent).toBe(text)
  expect(container.querySelector('[data-state="complete"]')).not.toBeNull()
})

it("skips the demo cursor when the app requests reduced motion", async () => {
  vi.useFakeTimers()
  await act(async () =>
    root.render(
      <MotionConfig reducedMotion="always">
        <AssistantMessage
          {...callbacks}
          parts={[part("直接显示完整正文")]}
          streaming
          initialPartIds={new Set()}
        />
      </MotionConfig>
    )
  )
  expect(container.textContent).toBe("直接显示完整正文")
  expect(vi.getTimerCount()).toBe(0)
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
