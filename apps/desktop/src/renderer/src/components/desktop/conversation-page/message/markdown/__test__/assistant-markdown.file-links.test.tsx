// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

// 文件链接测试不需要加载代码高亮和图表；保留真实 Markdown 解析、过滤和链接按钮。
vi.mock("@renderer/components/ui/code-block", () => ({ CodeBlock: () => null }))
vi.mock("../mermaid-diagram", () => ({ MermaidDiagram: () => null }))

import { AssistantMarkdown } from "../assistant-markdown"

let root: Root
let container: HTMLDivElement
let opened: Array<[string, number | undefined]>

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  opened = []
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})

async function render(text: string, fileLinkMode: "open" | "text" = "open") {
  await act(async () =>
    root.render(
      <AssistantMarkdown
        text={text}
        streaming={false}
        animateInitialText={false}
        fileLinkMode={fileLinkMode}
        onOpenFile={(path, line) => {
          opened.push([path, line])
        }}
      />
    )
  )
}

it.each([
  { href: "文档/说明.md", path: "文档/说明.md", line: undefined },
  { href: "README.md", path: "README.md", line: undefined },
  { href: "src/main.ts:42:3", path: "src/main.ts", line: 42 },
  { href: "文档/更新%20%231%2520.md", path: "文档/更新 #1%20.md", line: undefined },
])(
  "opens a bare project-relative file without changing its identity: $href",
  async ({ href, path, line }) => {
    await render(`[项目文件](${href})`)
    const button = container.querySelector<HTMLButtonElement>(".assistant-file-link")
    expect(button, container.innerHTML).not.toBeNull()
    act(() => button!.click())
    expect(opened).toEqual([[path, line]])
  }
)

it.each([
  "javascript:alert(1)/note.md",
  "JaVaScRiPt:alert(1)/note.md",
  "jav&#x61;script:alert(1)/note.md",
  "javascript%3Aalert(1)/note.md",
  "java%0ascript:alert(1)/note.md",
  "data:text/html,evil/note.md",
  "vbscript:evil/note.md",
  "file:///C:/Windows/system.ini",
  "%2f%2fserver/share/note.md",
  "docs/../../private.md",
  "docs/%2e%2e/%2e%2e/private.md",
])("does not turn an unsafe or disguised link into an active file link: %s", async (href) => {
  await render(`[危险链接](${href})`)
  expect(container.querySelector(".assistant-file-link")).toBeNull()
  expect(container.querySelector("a[href]")).toBeNull()
})

it.each(["https://example.com/guide.md", "mailto:test@example.com", "#details"])(
  "keeps an ordinary web, mail or fragment link unchanged: %s",
  async (href) => {
    await render(`[普通链接](${href})`)
    expect(container.querySelector(".assistant-file-link")).toBeNull()
    expect(container.querySelector("a")?.getAttribute("href")).toBe(href)
  }
)

it("keeps relative file references noninteractive in read-only text mode", async () => {
  await render("[项目文件](文档/说明.md)", "text")
  expect(container.querySelector(".assistant-file-link")).toBeNull()
  expect(container.querySelector('[title="文档/说明.md"]')?.textContent).toBe("项目文件")
  expect(container.textContent).not.toContain("[blocked]")
})
