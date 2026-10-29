// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import type { DesktopSessionPart } from "@shared/session-types"
import { AssistantMessage } from "../assistant-message"
import { ContentEntrance } from "../content-entrance"
import {
  AppearanceProvider,
  useAppearance,
} from "@renderer/components/appearance/appearance-provider"
import { APPEARANCE_STORAGE_KEY } from "@renderer/components/appearance/appearance-preferences"

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
  expect(spans.map((span) => span.textContent)).toEqual(["新", "增"])
  expect(spans.every((span) => parseFloat(span.style.getPropertyValue("--sd-duration")) > 0)).toBe(
    true
  )
})

it("does not animate completed history", async () => {
  await renderReply("历史正文", false)
  expect(container.querySelector("[data-sd-animate]")).toBeNull()
  expect(container.textContent).toContain("历史正文")
})

it("applies the saved animation switch immediately and lets reduced motion override it", async () => {
  localStorage.setItem(
    APPEARANCE_STORAGE_KEY,
    JSON.stringify({ version: 1, reducedMotion: "off", streamingTextAnimation: true })
  )
  function Controls() {
    const { setPreference } = useAppearance()
    return (
      <>
        <button onClick={() => setPreference("streamingTextAnimation", false)}>关闭逐字动画</button>
        <button onClick={() => setPreference("streamingTextAnimation", true)}>开启逐字动画</button>
        <button onClick={() => setPreference("reducedMotion", "on")}>减少动态效果</button>
      </>
    )
  }
  const render = async (text: string) =>
    act(async () =>
      root.render(
        <AppearanceProvider>
          <Controls />
          <AssistantMessage
            {...callbacks}
            parts={[part(text)]}
            streaming
            initialPartIds={new Set()}
          />
        </AppearanceProvider>
      )
    )
  try {
    await render("正在输出")
    expect(container.querySelector("[data-sd-animate]")).not.toBeNull()
    await act(async () => (container.querySelector("button") as HTMLButtonElement).click())
    await render("正在输出新的文字")
    expect(container.querySelector("[data-sd-animate]")).toBeNull()
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!).streamingTextAnimation).toBe(
      false
    )
    await act(async () => (container.querySelectorAll("button")[1] as HTMLButtonElement).click())
    await act(async () => (container.querySelectorAll("button")[2] as HTMLButtonElement).click())
    await render("正在输出新的文字，减少动态效果优先")
    expect(container.querySelector("[data-sd-animate]")).toBeNull()
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!).streamingTextAnimation).toBe(
      true
    )
  } finally {
    localStorage.removeItem(APPEARANCE_STORAGE_KEY)
  }
})

it("keeps character animation for long streaming replies and preserves appended Markdown", async () => {
  vi.useFakeTimers()
  await renderReply("简短开头", true)
  expect(container.querySelector("[data-sd-animate]")).not.toBeNull()

  const longText = "简短开头" + "长正文内容。".repeat(400)
  const markdown = `${longText}\n\n1. 普通列表文字与 \`inlineCode\``
  await renderReply(markdown, true)
  expect(container.querySelector("[data-sd-animate]")).not.toBeNull()
  expect(container.textContent).toContain(longText)
  expect(container.querySelector("li")?.textContent).toContain("普通列表文字")
  expect(container.querySelector("code")?.textContent).toBe("inlineCode")

  await renderReply(`${markdown}\n\n后续内容`, true)
  expect(container.querySelector("[data-sd-animate]")).not.toBeNull()
  expect(container.textContent).toContain("后续内容")
  await renderReply(`${markdown}\n\n后续内容\n\n最终内容`, false)
  expect(container.querySelector("[data-sd-animate]")).toBeNull()
  expect(container.textContent).toContain("最终内容")
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
