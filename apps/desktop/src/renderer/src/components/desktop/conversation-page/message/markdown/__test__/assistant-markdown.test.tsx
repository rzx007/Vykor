// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { AssistantMessage } from "../../assistant-message"
import { AppearanceProvider } from "@renderer/components/appearance/appearance-provider"
import type { DesktopSessionPart } from "@shared/session-types"
import { prepareFileOpenRequest } from "@renderer/components/desktop/layout/main-layout/utility-panel/file-open-request"

let root: Root
let container: HTMLDivElement
const prefix = "超长回复中的已有文字。".repeat(1500)
const callbacks = {
  onOpenFile: () => {},
  canOpenReview: false,
  onOpenReview: () => {},
  onOpenTerminal: () => {},
}
function render(
  text: string,
  streaming = true,
  onOpenFile: (path: string, line?: number) => void = callbacks.onOpenFile
) {
  const part: DesktopSessionPart = {
    id: "reply",
    sessionId: "chat",
    messageId: "assistant",
    seq: 1,
    type: "text",
    text,
    status: streaming ? "running" : "completed",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
  root.render(
    <AppearanceProvider>
      <AssistantMessage
        {...callbacks}
        onOpenFile={onOpenFile}
        parts={[part]}
        streaming={streaming}
      />
    </AppearanceProvider>
  )
}
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets = new Set<Element>()
      observe(target: Element) {
        this.targets.add(target)
      }
      unobserve(target: Element) {
        this.targets.delete(target)
      }
      disconnect() {
        this.targets.clear()
      }
    }
  )
})

it("keeps live code source and copy current before deferred coloring, including fence closure", async () => {
  vi.useFakeTimers()
  const code = "const item = 42;\n".repeat(400)
  await act(async () => render(`\`\`\`typescript\n${code}`))
  expect(container.querySelector("pre > code")?.textContent).toBe(code.trimEnd())
  await act(async () => render(`\`\`\`typescript\n${code}const tail = 1;`))
  expect(container.querySelector("pre > code")?.textContent).toBe(`${code}const tail = 1;`)
  await act(async () => render(`\`\`\`typescript\n${code}const tail = 1;\n\`\`\``))
  await act(async () => vi.advanceTimersByTimeAsync(100))
  expect(container.querySelector("pre > code")?.textContent).toBe(`${code}const tail = 1;`)
})

it("shows a same-length correction immediately instead of reusing stale Markdown nodes", async () => {
  vi.useFakeTimers()
  await act(async () => render("A".repeat(5000)))
  await act(async () => render("B".repeat(5000)))
  expect(container.textContent === "B".repeat(5000)).toBe(true)
  await act(async () => vi.advanceTimersByTimeAsync(200))
  expect(container.textContent === "B".repeat(5000)).toBe(true)
  await act(async () => render(`${"B".repeat(5000)} pending`))
  const corrected = `${"B".repeat(2000)}X${"B".repeat(2999)} pending`
  await act(async () => render(corrected))
  expect(container.textContent === corrected).toBe(true)
  await act(async () => vi.advanceTimersByTimeAsync(200))
  expect(container.textContent === corrected).toBe(true)
})

it("keeps code fences, tables, file links and final footnotes intact in a long reply", async () => {
  const opened: Array<[string, number | undefined]> = []
  const onOpenFile = (path: string, line?: number) => {
    opened.push([path, line])
  }
  const source = `${prefix}\n\n\`\`\`ts\nconst answer = 42\n\`\`\`\n\n| 名称 | 数值 |\n| --- | --- |\n| answer | 42 |\n\n[源码](/src/example.ts) 和脚注[^note]\n\n[^note]: 最终注释`
  await act(async () => render(source, false, onOpenFile))
  expect(container.querySelector('[data-streamdown="code-block"]')).not.toBeNull()
  expect(container.querySelector("table")?.textContent).toContain("answer")
  expect(container.textContent).toContain("最终注释")
  const file = container.querySelector<HTMLButtonElement>('button[title="打开 /src/example.ts"]')!
  expect(file).not.toBeNull()
  act(() => file.click())
  expect(opened).toEqual([["/src/example.ts", undefined]])
})

it.each([
  {
    href: "/C:/Users/ruanz/.answer-me-with-html/pages/Vykor-更新流程-20261021-222914.html",
    path: "C:/Users/ruanz/.answer-me-with-html/pages/Vykor-更新流程-20261021-222914.html",
    url: "file:///C:/Users/ruanz/.answer-me-with-html/pages/Vykor-%E6%9B%B4%E6%96%B0%E6%B5%81%E7%A8%8B-20261021-222914.html",
  },
  {
    href: "/C:/reports/%E6%9B%B4%E6%96%B0.html:42",
    path: "C:/reports/更新.html",
    url: "file:///C:/reports/%E6%9B%B4%E6%96%B0.html",
  },
  {
    href: "/C:/reports/report%2520%20%231%25.html",
    path: "C:/reports/report%20 #1%.html",
    url: "file:///C:/reports/report%2520%20%231%25.html",
  },
])("decodes Markdown file links once before opening the browser: $href", async ({ href, path, url }) => {
  const opened: string[] = []
  await act(async () => render(`[查看报告](${href})`, false, (filePath) => opened.push(filePath)))
  const file = container.querySelector<HTMLButtonElement>(".assistant-file-link")!
  expect(file).not.toBeNull()
  act(() => file.click())
  expect(opened).toEqual([path])
  expect(prepareFileOpenRequest(opened[0]!, "D:/repo").browserUrl).toBe(url)
})

it("cancels a pending refresh when its virtual row unmounts", async () => {
  vi.useFakeTimers()
  await act(async () => render(prefix))
  await act(async () => render(`${prefix} pending`))
  expect(vi.getTimerCount()).toBeGreaterThan(0)
  act(() => root.unmount())
  expect(vi.getTimerCount()).toBe(0)
  root = createRoot(container)
  await act(async () => render("另一个会话"))
  await act(async () => vi.advanceTimersByTimeAsync(200))
  expect(container.textContent).toBe("另一个会话")
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})

it("bounds animation nodes for a single very long streaming reply while keeping Markdown", async () => {
  await act(async () => render(`${prefix}\n\n- **重要项目**\n- \`inline\``))
  expect(container.textContent).toContain(prefix)
  expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe("重要项目")
  expect(container.querySelector("code")?.textContent).toBe("inline")
  expect(container.querySelectorAll("[data-sd-animate]").length).toBeLessThan(512)
})

it("coalesces continuous long-text deltas without starving visible updates", async () => {
  vi.useFakeTimers()
  await act(async () => render(prefix))
  for (let index = 1; index <= 5; index++) {
    await act(async () => render(`${prefix}${"新增".repeat(index)}`))
    await act(async () => vi.advanceTimersByTimeAsync(10))
  }
  expect(container.textContent?.slice(prefix.length)).not.toBe("新增".repeat(5))
  await act(async () => vi.advanceTimersByTimeAsync(50))
  expect(container.textContent?.slice(prefix.length)).toBe("新增".repeat(5))
  for (let index = 6; index <= 15; index++) {
    await act(async () => render(`${prefix}${"新增".repeat(index)}`))
    await act(async () => vi.advanceTimersByTimeAsync(10))
  }
  expect(container.textContent?.slice(prefix.length).length).toBeGreaterThanOrEqual(12)
  await act(async () => vi.advanceTimersByTimeAsync(100))
  expect(container.textContent?.slice(prefix.length)).toBe("新增".repeat(15))
})

it("coalesces long prose again after a code fence has closed", async () => {
  vi.useFakeTimers()
  const source = `\`\`\`ts\nconst ready = 1;\n\`\`\`\n\n${prefix}`
  await act(async () => render("```ts\nconst ready = 1;"))
  await act(async () => render(source))
  await act(async () => render(`${source} pending prose`))
  expect(container.textContent).not.toContain("pending prose")
  await act(async () => vi.advanceTimersByTimeAsync(100))
  expect(container.textContent).toContain("pending prose")
})

it("reveals a new split fence immediately after previously coalesced prose", async () => {
  vi.useFakeTimers()
  await act(async () => render(prefix))
  await act(async () => render(`${prefix}\n\n\`\``))
  await act(async () => render(`${prefix}\n\n\`\`\`typescript\nconst fresh = 1;`))
  expect(container.querySelector("pre code")?.textContent).toBe("const fresh = 1;")
  await act(async () => render(`${prefix}\n\n\`\`\`typescript\nconst fresh = 12;`))
  expect(container.querySelector("pre code")?.textContent).toBe("const fresh = 12;")
})

it("flushes completion and a replacement immediately and never restores an old pending delta", async () => {
  vi.useFakeTimers()
  await act(async () => render(prefix))
  await act(async () => render(`${prefix} pending`))
  await act(async () => render(`${prefix}\n\n**最终结果**`, false))
  expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe("最终结果")
  await act(async () => vi.advanceTimersByTimeAsync(200))
  expect(container.textContent).not.toContain("pending")
  await act(async () => render(`${prefix} next`))
  await act(async () => render("服务端修正后的完整内容"))
  expect(container.textContent).toBe("服务端修正后的完整内容")
  await act(async () => vi.advanceTimersByTimeAsync(200))
  expect(container.textContent).toBe("服务端修正后的完整内容")
})
