// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { CodeBlock } from "./code-block"
import {
  AppearanceProvider,
  useAppearance,
} from "@renderer/components/appearance/appearance-provider"
import { CodeHighlightTestWorker } from "./code-highlight-worker.test-support"

vi.mock("@pierre/diffs/worker/worker.js?worker", async () => ({
  default: (await import("./code-highlight-worker.test-support")).CodeHighlightTestWorker,
}))
let root: Root
let container: HTMLDivElement
const clipboard = vi.fn<(value: string) => Promise<void>>(async () => {})
function render(code: string, streaming = true, language = "typescript") {
  root.render(
    <AppearanceProvider>
      <CodeBlock variant="conversation" code={code} streaming={streaming} language={language} />
    </AppearanceProvider>
  )
}
function source() {
  return container.querySelector("pre code")?.textContent
}
function colored() {
  return container.querySelector('pre code span[style*="color"]')
}
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("Worker", CodeHighlightTestWorker)
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboard },
  })
  CodeHighlightTestWorker.requests = []
  CodeHighlightTestWorker.hold = false
  CodeHighlightTestWorker.held = []
  clipboard.mockClear()
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

it("colors an open fence in a real worker while source and copy follow every append", async () => {
  const initial = 'const answer = "中文😀";'
  await act(async () => render(initial))
  expect(source()).toBe(initial)
  await vi.waitFor(
    async () => {
      await act(async () => {})
      expect(colored()).not.toBeNull()
    },
    { timeout: 10_000 }
  )
  expect(CodeHighlightTestWorker.requests.some((request) => request.type === "file")).toBe(true)
  const latest = initial + "\nconst next = 2;"
  await act(async () => render(latest))
  expect(source()).toBe(latest)
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!.click()
  )
  expect(clipboard).toHaveBeenLastCalledWith(latest)
  expect(colored()).not.toBeNull()
})

it("rejects a late result after same-length correction, truncation and language change", async () => {
  CodeHighlightTestWorker.hold = true
  await act(async () => render("const original = 1;"))
  await vi.waitFor(() => expect(CodeHighlightTestWorker.held.length).toBeGreaterThan(0), {
    timeout: 10_000,
  })
  await act(async () => render("const corrected= 2;"))
  await act(async () => {
    CodeHighlightTestWorker.held.splice(0).forEach((deliver) => deliver())
  })
  expect(source()).toBe("const corrected= 2;")
  expect(colored()).toBeNull()
  await act(async () => render("x", true, "python"))
  CodeHighlightTestWorker.hold = false
  await act(async () => {
    CodeHighlightTestWorker.held.splice(0).forEach((deliver) => deliver())
  })
  expect(source()).toBe("x")
  expect(container.textContent).not.toContain("original")
})

it("shares one worker between blocks and releases its resources on unmount", async () => {
  await act(async () =>
    root.render(
      <AppearanceProvider>
        {["a", "b"].map((name) => (
          <CodeBlock
            key={name}
            variant="conversation"
            code={`const ${name} = 1;`}
            streaming
            language="ts"
          />
        ))}
      </AppearanceProvider>
    )
  )
  await vi.waitFor(
    async () => {
      await act(async () => {})
      expect(container.querySelectorAll('pre code span[style*="color"]').length).toBeGreaterThan(1)
    },
    { timeout: 10_000 }
  )
  expect(CodeHighlightTestWorker.instances.size).toBe(1)
  act(() => root.unmount())
  expect(CodeHighlightTestWorker.instances.size).toBe(0)
  root = createRoot(container)
})

it("preserves CRLF, blank lines, Unicode and literal markup after final highlighting", async () => {
  const code = 'const markup = "<script>alert(1)</script>";\r\n\r\n// 中文😀\r\n'
  await act(async () => render(code, false))
  await vi.waitFor(() => expect(colored()).not.toBeNull(), { timeout: 10_000 })
  expect(source()).toBe(code)
  expect(container.querySelector("script")).toBeNull()
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!.click()
  )
  expect(clipboard).toHaveBeenLastCalledWith(code)
})

function ThemeButton() {
  const { setPreference, resolvedTheme } = useAppearance()
  return (
    <button
      data-theme-toggle
      onClick={() => setPreference("theme", resolvedTheme === "dark" ? "light" : "dark")}
    >
      theme
    </button>
  )
}
it("changes colors immediately with the theme without submitting the code again", async () => {
  const code = "const theme = 1;"
  await act(async () =>
    root.render(
      <AppearanceProvider>
        <CodeBlock variant="conversation" code={code} language="typescript" streaming />
        <ThemeButton />
      </AppearanceProvider>
    )
  )
  await vi.waitFor(() => expect(colored()).not.toBeNull(), { timeout: 10_000 })
  const previousColor = colored()?.getAttribute("style")
  const requests = CodeHighlightTestWorker.requests.filter(
    (request) => request.type === "file"
  ).length
  act(() => container.querySelector<HTMLButtonElement>("[data-theme-toggle]")!.click())
  expect(colored()?.getAttribute("style")).not.toBe(previousColor)
  expect(source()).toBe(code)
  expect(
    CodeHighlightTestWorker.requests.filter((request) => request.type === "file")
  ).toHaveLength(requests)
})

it("keeps source and copy usable when workers are unavailable", async () => {
  vi.stubGlobal("Worker", undefined)
  const code = "const fallback = 1;"
  await act(async () => render(code))
  expect(source()).toBe(code)
  expect(colored()).toBeNull()
  expect(CodeHighlightTestWorker.requests).toEqual([])
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!.click()
  )
  expect(clipboard).toHaveBeenLastCalledWith(code)
})

it("retains colors on earlier lines after a multiline worker result replaces the prefix", async () => {
  await act(async () => render("const first = 1;"))
  await vi.waitFor(() => expect(colored()).not.toBeNull(), { timeout: 10_000 })
  const latest = "const first = 1;\nconst second = 2;\nconst third = 3;"
  await act(async () => render(latest, false))
  await vi.waitFor(
    () => {
      const highlighted = [...container.querySelectorAll('pre code span[style*="color"]')]
        .map((element) => element.textContent)
        .join("")
      expect(highlighted).toContain("first")
      expect(highlighted).toContain("second")
      expect(highlighted).toContain("third")
    },
    { timeout: 10_000 }
  )
  expect(source()).toBe(latest)
})
