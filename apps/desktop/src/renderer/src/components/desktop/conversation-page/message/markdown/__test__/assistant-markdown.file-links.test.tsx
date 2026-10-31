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

async function render(text: string, fileLinkMode: "open" | "text" = "open", messageLinks = false) {
  await act(async () =>
    root.render(
      <AssistantMarkdown
        text={text}
        streaming={false}
        animateInitialText={false}
        fileLinkMode={fileLinkMode}
        messageLinks={messageLinks}
        onOpenFile={(path, line) => {
          opened.push([path, line])
        }}
      />
    )
  )
}

it("only enables browser selection for actual messages, leaving workflow results unchanged", async () => {
  await render("[网页](https://example.com/docs)")
  expect(container.querySelector('[data-message-web-links="true"] a')).toBeNull()
  await render("[网页](https://example.com/docs)", "open", true)
  expect(container.querySelector('[data-message-web-links="true"] a')?.getAttribute("href")).toBe("https://example.com/docs")
})

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

it("keeps link and inline-code markup without exposing parser nodes as DOM attributes", async () => {
  await render('[帮助](https://example.com/docs "文档") 和 `const value = 1`')
  expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/docs")
  expect(container.querySelector("a")?.getAttribute("title")).toBe("文档")
  expect(container.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer")
  expect(container.querySelector("a")?.getAttribute("target")).toBe("_blank")
  expect(container.querySelector("a")?.textContent).toBe("帮助")
  expect(container.querySelector("a svg")).not.toBeNull()
  expect(container.querySelector("code")?.textContent).toBe("const value = 1")
  expect(container.querySelector("[node]")).toBeNull()

  const records: MutationRecord[] = []
  const observer = new MutationObserver((mutations) => records.push(...mutations))
  observer.observe(container, { attributes: true, subtree: true })
  await render('[帮助](https://example.com/docs "文档") 和 `const value = 1` 追加文字')
  records.push(...observer.takeRecords())
  observer.disconnect()
  expect(records.filter((record) => record.attributeName === "node")).toHaveLength(0)
  expect(container.querySelector("[node]")).toBeNull()
})

it("does not parse wildcard link prefixes as URLs while rendering repeated web links", async () => {
  const attempts: unknown[] = []
  const OriginalURL = globalThis.URL
  vi.stubGlobal(
    "URL",
    new Proxy(OriginalURL, {
      construct(target, args, newTarget) {
        attempts.push(args[0])
        return Reflect.construct(target, args, newTarget)
      },
    })
  )
  try {
    await render(
      Array.from({ length: 25 }, (_, i) => `${i + 1}. [帮助](https://example.com/docs)`).join("\n")
    )
    expect(container.querySelectorAll('a[href="https://example.com/docs"]')).toHaveLength(25)
    expect(attempts).toContain("https://example.com/docs")
    expect(attempts).not.toContain("*")
  } finally {
    vi.unstubAllGlobals()
  }
})

it("still sanitizes raw HTML links and removes executable HTML", async () => {
  await render(
    '<a href="https://example.com/docs" title="文档" onclick="alert(1)">帮助</a> <a href="javascript:alert(1)">危险</a><script>alert(1)</script>'
  )
  expect(container.querySelector('a[href="https://example.com/docs"]')?.textContent).toBe("帮助")
  expect(container.querySelector("[onclick], script")).toBeNull()
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
})
