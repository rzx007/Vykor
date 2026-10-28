// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MotionConfig } from "motion/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { AppearanceProvider } from "@renderer/components/appearance/appearance-provider"
import { CodeHighlightTestWorker } from "../../../../../ui/code-highlight-worker.test-support"
import { AssistantMarkdown } from "../assistant-markdown"

vi.mock("@pierre/diffs/worker/worker.js?worker", async () => ({
  default: (await import("../../../../../ui/code-highlight-worker.test-support"))
    .CodeHighlightTestWorker,
}))

let root: Root
let container: HTMLDivElement
const onOpenFile = () => {}
const clipboard = vi.fn<(value: string) => Promise<void>>(async () => {})
const chineseEmphasis = () =>
  [...container.querySelectorAll('[data-cjk-emphasis="true"]')].map((node) => node.textContent)

async function render(text: string, streaming = false) {
  await act(async () =>
    root.render(
      <MotionConfig reducedMotion="always">
        <AppearanceProvider>
          <AssistantMarkdown
            text={text}
            streaming={streaming}
            animateInitialText={false}
            onOpenFile={onOpenFile}
          />
        </AppearanceProvider>
      </MotionConfig>
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

afterEach(() => {
  act(() => root.unmount())
  for (const worker of CodeHighlightTestWorker.instances) worker.terminate()
  container.remove()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})

it("keeps semantic emphasis while separating Chinese from Latin text without changing characters", async () => {
  await render("*中文（提示） English API123，继续* / *English only*")

  const emphasis = container.querySelectorAll("em")
  expect(emphasis).toHaveLength(2)
  expect(emphasis[0]?.textContent).toBe("中文（提示） English API123，继续")
  expect(chineseEmphasis()).toEqual(["中文（提示）", "，继续"])
  expect(emphasis[1]?.textContent).toBe("English only")
  expect(emphasis[1]?.querySelector("span")).toBeNull()
  expect(emphasis[0]?.childNodes[1]?.textContent).toBe(" English API123")
})

it("preserves nested strong text, links and inline code inside emphasis", async () => {
  await render(
    '*中文 **重点 API** [中文帮助](https://example.com/docs) `const 值 = "A*B"` English*'
  )

  expect(container.querySelector("em strong")?.textContent).toBe("重点 API")
  expect(container.querySelector("em a")?.getAttribute("href")).toBe("https://example.com/docs")
  expect(container.querySelector("em a")?.textContent).toBe("中文帮助")
  expect(chineseEmphasis()).toEqual(["中文", "重点", "中文帮助"])
  expect(container.querySelector("em code")?.textContent).toBe('const 值 = "A*B"')
  expect(container.querySelector("code [data-cjk-emphasis]")).toBeNull()
})

it("keeps ordinary Chinese, strong-only text and escaped delimiters unchanged", async () => {
  await render("普通中文 API\n\n**中文粗体**\n\n\\*不是强调\\*")

  expect(container.querySelector("em")).toBeNull()
  expect(container.querySelector("strong")?.textContent).toBe("中文粗体")
  expect(container.textContent).toContain("*不是强调*")
  expect(chineseEmphasis()).toEqual([])
})

it("keeps supplementary Han characters and variation selectors together", async () => {
  await render("*汉\u{E0100} API e\u0301 𠮷*")

  expect(chineseEmphasis()).toEqual(["汉\u{E0100}", "𠮷"])
  expect(container.querySelector("em")?.textContent).toBe("汉\u{E0100} API e\u0301 𠮷")
})

it("keeps emphasis text consistent when a plain-text stream finishes and resumes", async () => {
  await render("*生成中文 English", true)
  expect(container.querySelector("em")?.textContent).toBe("生成中文 English")
  expect(chineseEmphasis()).toEqual(["生成中文"])

  await render("*生成中文 English*", false)
  expect(container.querySelector("em")?.textContent).toBe("生成中文 English")
  expect(chineseEmphasis()).toEqual(["生成中文"])

  await render("*生成中文 English*\n\n*继续 API", true)
  await render("*生成中文 English*\n\n*继续 API*", false)
  expect([...container.querySelectorAll("em")].map((node) => node.textContent)).toEqual([
    "生成中文 English",
    "继续 API",
  ])
  expect(chineseEmphasis()).toEqual(["生成中文", "继续"])
})

it("keeps completed emphasis and code mounted while new mixed-script emphasis streams", async () => {
  const code = 'const label = "*中文 API*";'
  const prefix = `*已有中文 API*\n\n\`\`\`ts\n${code}\n\`\`\`\n\n`
  await render(`${prefix}*正在`, true)
  const firstEmphasis = container.querySelector("em")!
  const firstPre = container.querySelector("pre")!

  for (const tail of ["*正在生成 English", "*正在生成 English，继续", "*正在生成 English，继续*"]) {
    await render(`${prefix}${tail}`, true)
    expect(container.querySelector("em")).toBe(firstEmphasis)
    expect(container.querySelector("pre")).toBe(firstPre)
    expect(firstPre.querySelector("code")?.textContent).toBe(code)
    expect(firstPre.querySelector("[data-cjk-emphasis]")).toBeNull()
  }

  await render(`${prefix}*正在生成 English，继续*`, false)
  expect(container.querySelector("em")).toBe(firstEmphasis)
  expect(container.querySelector("pre")).toBe(firstPre)
  expect(chineseEmphasis()).toEqual(["已有中文", "正在生成", "，继续"])
  expect([...container.querySelectorAll("em")].map((node) => node.textContent)).toEqual([
    "已有中文 API",
    "正在生成 English，继续",
  ])
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!.click()
  )
  expect(clipboard).toHaveBeenLastCalledWith(code)
})
