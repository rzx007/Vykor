// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { AppearanceProvider } from "@renderer/components/appearance/appearance-provider"
import { CodeHighlightTestWorker } from "../../../../../ui/code-highlight-worker.test-support"
import { AssistantMarkdown } from "../assistant-markdown"
import { ConversationTranscript } from "../../../transcript/transcript"
import type { DesktopSessionPart } from "@shared/session-types"

vi.mock("@pierre/diffs/worker/worker.js?worker", async () => ({
  default: (await import("../../../../../ui/code-highlight-worker.test-support")).CodeHighlightTestWorker,
}))

let root: Root
let container: HTMLDivElement
const onOpenFile = () => {}
const clipboard = vi.fn<(value: string) => Promise<void>>(async () => {})
async function render(text: string, streaming = true, openFile = onOpenFile) {
  await act(async () =>
    root.render(
      <AppearanceProvider>
        <AssistantMarkdown
          text={text}
          streaming={streaming}
          animateInitialText={false}
          onOpenFile={openFile}
        />
      </AppearanceProvider>
    )
  )
}
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("Worker", CodeHighlightTestWorker)
  CodeHighlightTestWorker.requests = []
  CodeHighlightTestWorker.hold = false
  CodeHighlightTestWorker.held = []
  clipboard.mockClear()
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboard },
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

it("preserves code nodes and colors when the parent supplies a fresh file handler during streaming", async () => {
  let markdown = "```ts\nconst first = 1;\n```\n\n```ts\nconst next = 1;"
  await render(markdown, true, () => {})
  await vi.waitFor(() => expect(container.querySelector("pre code span[style]")).not.toBeNull(), {
    timeout: 10_000,
  })
  const firstPre = container.querySelector("pre")!
  for (let index = 0; index < 10; index++) {
    markdown += `\nconst next${index} = 2;`
    await render(markdown, true, () => {})
    expect(container.querySelector("pre")).toBe(firstPre)
    expect(firstPre.isConnected).toBe(true)
    expect(firstPre.querySelector("span[style]")).not.toBeNull()
  }
  expect(
    CodeHighlightTestWorker.requests.filter(
      (request) => request.type === "file" && request.file.contents === "const first = 1;"
    )
  ).toHaveLength(1)
  expect(CodeHighlightTestWorker.instances.size).toBe(1)
})

it("uses the latest file handler even when Markdown text has not changed", async () => {
  const original = vi.fn()
  const latest = vi.fn()
  const markdown = "[源码](/src/example.ts)\n\n```ts\nconst first = 1;\n```"
  await render(markdown, true, original)
  const link = container.querySelector<HTMLButtonElement>('button[title="打开 /src/example.ts"]')!
  await render(markdown, true, latest)
  act(() => link.click())
  expect(original).not.toHaveBeenCalled()
  expect(latest).toHaveBeenCalledWith("/src/example.ts", undefined)
})

it("keeps completed code mounted and colored when streaming finishes and resumes", async () => {
  const markdown = "```ts\nconst first = 1;\n```\n\n```ts\nconst second = 2;\n```"
  await render(markdown)
  await vi.waitFor(() => expect(container.querySelector("pre code span[style]")).not.toBeNull(), {
    timeout: 10_000,
  })
  const firstPre = container.querySelector("pre")!
  await render(markdown, false)
  expect(container.querySelector("pre")).toBe(firstPre)
  expect(firstPre.querySelector("span[style]")).not.toBeNull()
  await render(`${markdown}\n\n\`\`\`python\nprint('resumed')`)
  expect(container.querySelector("pre")).toBe(firstPre)
  expect(firstPre.querySelector("span[style]")).not.toBeNull()
  expect(container.querySelectorAll("pre code")[2]?.textContent).toBe("print('resumed')")
})

it.each([
  "[源码][source]\n\n```ts\nconst first = 1;\n```\n\n[source]: /src/example.ts",
  "[源码][source]\n\n```ts\nconst first = 1;\n```\n\n> [source]: /src/example.ts",
  "[源码][source label]\n\n```ts\nconst first = 1;\n```\n\n[source\nlabel]: /src/example.ts",
  "脚注[^note]\n\n```ts\nconst first = 1;\n```\n\n[^note]: 最终注释",
  "[源码][source]\n\n```ts\nconst first = 1;\n```\n\n脚注[^note]\n\n[source]: /src/example.ts\n\n[^note]: 最终注释",
])(
  "matches historical rendering for document-wide syntax after completion: %s",
  async (markdown) => {
    const check = () => {
      if (markdown.includes("[源码]")) {
        expect(container.querySelector('button[title="打开 /src/example.ts"]')).not.toBeNull()
      }
      if (markdown.includes("[^note]:")) {
        const ref = container.querySelector<HTMLAnchorElement>("[data-footnote-ref]")!
        expect(ref).not.toBeNull()
        expect(container.querySelector("[data-footnotes] li")?.textContent).toContain("最终注释")
      }
      expect(container.querySelector("pre code")?.textContent).toBe("const first = 1;")
    }
    await render(markdown)
    await render(markdown, false)
    check()
    const links = () =>
      [
        ...container.querySelectorAll(
          "[data-footnote-ref], [data-footnotes] [id], [data-footnote-backref]"
        ),
      ].map((element) => ({ id: element.id, href: element.getAttribute("href") }))
    const completed = links()
    act(() => root.unmount())
    root = createRoot(container)
    await render(markdown, false)
    check()
    expect(links()).toEqual(completed)
  }
)

it("keeps source and copy current in the next block while its worker result is delayed", async () => {
  const first = "```ts\nconst first = 1;\n```"
  await render(first)
  await vi.waitFor(() => expect(container.querySelector("pre code span[style]")).not.toBeNull(), {
    timeout: 10_000,
  })
  const firstPre = container.querySelector("pre")!
  CodeHighlightTestWorker.hold = true
  let code = ""
  for (let index = 0; index < 15; index++) {
    code += `const live${index} = "中文😀";\n`
    await render(`${first}\n\n\`\`\`ts\n${code}`, true, () => {})
    expect(container.querySelector("pre")).toBe(firstPre)
    expect(firstPre.querySelector("span[style]")).not.toBeNull()
    expect(container.querySelectorAll("pre code")[1]?.textContent).toBe(code.trimEnd())
    await act(async () =>
      container.querySelectorAll<HTMLButtonElement>('[aria-label="Copy code"]')[1]!.click()
    )
    expect(clipboard).toHaveBeenLastCalledWith(code.trimEnd())
  }
  await vi.waitFor(() => expect(CodeHighlightTestWorker.held.length).toBeGreaterThan(0), {
    timeout: 10_000,
  })
  await act(async () => {
    CodeHighlightTestWorker.held.splice(0).forEach((deliver) => deliver())
  })
  expect(container.querySelectorAll("pre code")[1]?.textContent).toBe(code.trimEnd())
})
afterEach(() => {
  act(() => root.unmount())
  for (const worker of CodeHighlightTestWorker.instances) worker.terminate()
  container.remove()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})

it("keeps an earlier colored block mounted while subsequent fences stream and cross the long-reply threshold", async () => {
  const first = 'const first = "中文😀";'
  let markdown = `\`\`\`ts\n${first}`
  await render(markdown)
  await vi.waitFor(() => expect(container.querySelector("pre code span[style]")).not.toBeNull(), {
    timeout: 10_000,
  })
  const firstPre = container.querySelector("pre")!
  markdown += "\n```\n\n第二个代码块：\n\n```ts\n"
  await render(markdown)
  const secondPre = container.querySelectorAll("pre")[1]!
  for (let index = 0; index < 180; index++) {
    markdown += `const next${index} = "持续输出的代码内容";\n`
    await render(markdown)
    expect(container.querySelectorAll("pre")[0]).toBe(firstPre)
    expect(firstPre.querySelector("code")?.textContent).toBe(first)
    expect(firstPre.querySelector("span[style]")).not.toBeNull()
    expect(container.querySelectorAll("pre")[1]).toBe(secondPre)
    expect(secondPre.textContent).toContain(`const next${index}`)
  }
  markdown += "```\n\n```python\nprint('third')"
  await render(markdown)
  expect(container.querySelectorAll("pre")).toHaveLength(3)
  expect(container.querySelector("pre")).toBe(firstPre)
  expect(firstPre.querySelector("span[style]")).not.toBeNull()
  await render(markdown + "\n```", false)
  expect(container.querySelectorAll("pre code")[2]?.textContent).toBe("print('third')")
})

it("keeps code mounted through real transcript cache updates and adjacent text parts", async () => {
  const part: DesktopSessionPart = {
    id: "first-part",
    sessionId: "chat",
    messageId: "assistant",
    seq: 1,
    type: "text",
    text: "```ts\nconst first = 1;\n```\n\n",
    status: "completed",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
  const message = {
    id: "assistant",
    sessionId: "chat",
    seq: 1,
    role: "assistant" as const,
    inputId: "input",
    runId: "run",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
  const run = {
    id: "run",
    sessionId: "chat",
    inputId: "input",
    status: "running" as const,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
  let tail: DesktopSessionPart = {
    ...part,
    id: "next-part",
    seq: 2,
    status: "running",
    text: "```ts\nconst second = 1;",
  }
  const update = async () => {
    await act(async () =>
      root.render(
        <AppearanceProvider>
          <ConversationTranscript
            messages={[message]}
            parts={[part, tail]}
            runs={[run]}
            running
            canEditLastUserMessage={false}
            onEditLastUserMessage={() => {}}
            onCopyAssistantMessage={() => {}}
            onOpenFile={onOpenFile}
            canOpenReview={false}
            onOpenReview={() => {}}
            onOpenTerminal={() => {}}
          />
        </AppearanceProvider>
      )
    )
  }
  await update()
  await vi.waitFor(() => expect(container.querySelector("pre code span[style]")).not.toBeNull(), {
    timeout: 10_000,
  })
  const firstPre = container.querySelector("pre")!
  for (let index = 0; index < 100; index++) {
    tail = { ...tail, text: `${tail.text}\nconst delta${index} = "append";`, updatedAt: index + 2 }
    if (index % 3 === 0) tail = { ...tail, metadata: {} }
    await update()
    expect(container.querySelector("pre")).toBe(firstPre)
    expect(firstPre.querySelector("span[style]")).not.toBeNull()
    expect(container.querySelectorAll("pre code")[1]?.textContent).toContain(`const delta${index}`)
  }
})
