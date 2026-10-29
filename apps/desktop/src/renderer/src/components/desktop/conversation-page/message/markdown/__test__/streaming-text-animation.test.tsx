// @vitest-environment jsdom
import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, afterEach, it, expect, vi } from "vitest"
import { AssistantMarkdown } from "../assistant-markdown"

let root: Root
let container: HTMLDivElement
const openFile = () => {}
async function render(text: string, streaming = true, initial = false) {
  await act(async () =>
    root.render(
      <AssistantMarkdown
        text={text}
        streaming={streaming}
        animateInitialText={initial}
        onOpenFile={openFile}
      />
    )
  )
}
async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms))
}
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  vi.useFakeTimers()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})

it("animates only the appended tail of a huge paragraph and retires its character nodes", async () => {
  const prefix = "已有正文。".repeat(5000)
  await render(prefix)
  const paragraph = container.querySelector("p")
  expect(container.querySelectorAll("[data-sd-animate]")).toHaveLength(0)
  await render(prefix + "新增👨‍👩‍👧‍👦文字")
  await advance(70)
  const nodes = [...container.querySelectorAll<HTMLElement>("[data-sd-animate]")]
  expect(nodes.map((n) => n.textContent)).toEqual(["新", "增", "👨‍👩‍👧‍👦", "文", "字"])
  expect(container.querySelector("p")).toBe(paragraph)
  expect(container.textContent).toBe(prefix + "新增👨‍👩‍👧‍👦文字")
  await advance(180)
  expect(container.querySelectorAll("[data-sd-animate]")).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

it("keeps in-flight nodes and their duration when more text arrives", async () => {
  await render("前文")
  await render("前文新增")
  const first = container.querySelector<HTMLElement>("[data-sd-animate]")!
  await advance(30)
  await render("前文新增后续")
  expect(container.querySelector("[data-sd-animate]")).toBe(first)
  expect(first.style.getPropertyValue("--sd-duration")).toBe("150ms")
  await advance(180)
  expect(container.querySelectorAll("[data-sd-animate]")).toHaveLength(0)
})

it("keeps split emoji additions in a single settled text run", async () => {
  await render("已有")
  await render("已有👨")
  await render("已有👨‍👩‍👧‍👦")
  expect(container.textContent).toBe("已有👨‍👩‍👧‍👦")
  expect(container.querySelectorAll("[data-sd-animate]")).toHaveLength(0)
})

it("keeps its restored baseline through StrictMode effect replay and cleans up on unmount", async () => {
  const update = async (text: string) =>
    act(async () =>
      root.render(
        <StrictMode>
          <AssistantMarkdown
            text={text}
            streaming
            animateInitialText={false}
            onOpenFile={openFile}
          />
        </StrictMode>
      )
    )
  await update("历史正文")
  await update("历史正文新增文字")
  expect(
    [...container.querySelectorAll("[data-sd-animate]")].map((node) => node.textContent).join("")
  ).toBe("新增文字")
  act(() => root.unmount())
  expect(vi.getTimerCount()).toBe(0)
  root = createRoot(container)
})

it("bounds animated nodes across blocks, leaves settled blocks mounted, and cancels on completion", async () => {
  let source = "开头\n\n"
  await render(source)
  const first = container.querySelector("p")
  for (let i = 0; i < 8; i++) {
    source += `段落${i}${"新文字".repeat(200)}\n\n`
    await render(source)
    await advance(70)
    expect(container.querySelectorAll("[data-sd-animate]").length).toBeLessThanOrEqual(512)
    expect(container.querySelector("p")).toBe(first)
  }
  await render(source, false)
  expect(container.querySelectorAll("[data-sd-animate]")).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

it("settles corrections and preserves Markdown semantics and source text", async () => {
  await render("已有正文")
  await render("已有正文 **强调** 与 [链接](https://example.com) 和 `inline`", true)
  expect(container.querySelector("strong")?.textContent).toBe("强调")
  expect(container.querySelector("a")?.textContent).toContain("链接")
  expect(container.querySelector("code")?.textContent).toBe("inline")
  await render("替换后的正文")
  expect(container.textContent).toBe("替换后的正文")
  expect(container.querySelectorAll("[data-sd-animate]")).toHaveLength(0)
  act(() => root.unmount())
  expect(vi.getTimerCount()).toBe(0)
  root = createRoot(container)
})

it("keeps history DOM compact and bounds timers and nodes through continuous long-text output", async () => {
  let source = Array.from(
    { length: 250 },
    (_, index) => `历史段落${index}，` + "正文。".repeat(50)
  ).join("\n\n")
  await render(source)
  const first = container.querySelector("p")
  expect(container.querySelectorAll("[data-sd-animate]")).toHaveLength(0)
  expect(container.querySelectorAll("span").length).toBeLessThan(10)
  for (let index = 0; index < 24; index++) {
    source += "连续追加正文。"
    await render(source)
    await advance(70)
    expect(container.textContent).toContain("连续追加正文。".repeat(index + 1))
    expect(container.querySelectorAll("[data-sd-animate]").length).toBeLessThanOrEqual(512)
    // 原有长正文刷新任务 + 回复共用的动画清理任务，不随块数、字符数增长。
    expect(vi.getTimerCount()).toBeLessThanOrEqual(2)
    expect(container.querySelector("p")).toBe(first)
  }
  await advance(200)
  expect(container.querySelectorAll("[data-sd-animate]")).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})
