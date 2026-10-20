// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { beforeAll, bench, describe, vi } from "vitest"
import { Streamdown, type StreamdownProps } from "streamdown"
import { CodeBlock } from "@renderer/components/ui/code-block"
import { AppearanceProvider } from "@renderer/components/appearance/appearance-provider"
import { AssistantMarkdown } from "../assistant-markdown"
import { createStreamdownComponents } from "../streamdown-components"
import { streamdownPlugins } from "../streamdown-plugins"

const onOpenFile = () => {}
const components = createStreamdownComponents({ onOpenFile, codeBlockVariant: "conversation" })
// Reproduce the previous incomplete-fence path, which entered the highlighted renderer every time.
const previousComponents: NonNullable<StreamdownProps["components"]> = {
  ...components,
  code: ({ className, children }) => {
    const language = className?.match(/language-([^\s]+)/)?.[1] ?? "text"
    return (
      <CodeBlock
        variant="default"
        className="my-4"
        code={String(children).replace(/\n$/, "")}
        language={language}
        filename={language}
        showLineNumbers={false}
      />
    )
  },
}
const animation = {
  animation: "fadeIn",
  duration: 150,
  easing: "ease-out",
  sep: "char",
  stagger: 0,
} as const
const fixtures = [
  ["single long paragraph", "超长回复中的连续文字。".repeat(750)],
  ["unfinished long code fence", "```typescript\n" + "const item = 42;\n".repeat(400)],
  [
    "1000 short paragraphs",
    Array.from({ length: 1000 }, (_, index) => `第 ${index} 段：已经显示的 **内容**。\n\n`).join(
      ""
    ),
  ],
] as const

class LayoutSubscriptions {
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

// Validate and warm the actual asynchronous highlighted renderer outside the timed loop.
beforeAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("ResizeObserver", LayoutSubscriptions)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <AppearanceProvider>
          <Streamdown plugins={streamdownPlugins} components={previousComponents}>
            {"```typescript\nconst benchmark = 42;\n```"}
          </Streamdown>
        </AppearanceProvider>
      )
    )
    await vi.waitFor(
      () => {
        if (
          !container
            .querySelector("diffs-container")
            ?.shadowRoot?.textContent?.includes("const benchmark = 42;")
        )
          throw new Error("Highlighted code has not rendered its source")
      },
      { timeout: 10_000 }
    )
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  }
})

// Includes real remend, lexer, unified, React commits and DOM updates; jsdom does not measure paint/layout.
async function renderSequence(initial: string, optimized: boolean) {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  vi.stubGlobal("ResizeObserver", LayoutSubscriptions)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  let text = initial
  const render = () =>
    root.render(
      <AppearanceProvider>
        {optimized ? (
          <AssistantMarkdown
            text={text}
            streaming
            animateInitialText={false}
            onOpenFile={onOpenFile}
          />
        ) : (
          <Streamdown
            className="desktop-streamdown space-y-0"
            animated={animation}
            isAnimating
            mode="streaming"
            controls
            lineNumbers={false}
            parseIncompleteMarkdown
            plugins={streamdownPlugins}
            components={previousComponents}
          >
            {text}
          </Streamdown>
        )}
      </AppearanceProvider>
    )
  try {
    await act(async () => render())
    for (let index = 0; index < 16; index++) {
      text += "新增"
      await act(async () => render())
      await act(async () => vi.advanceTimersByTimeAsync(2))
    }
    await act(async () => vi.advanceTimersByTimeAsync(100))
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  }
}

describe.each(fixtures)("real Markdown rendering: %s / 16 deltas at 2ms", (_name, initial) => {
  const options = { time: 1, iterations: 3, warmupTime: 1, warmupIterations: 1 }
  bench("previous rendering path", async () => renderSequence(initial, false), options)
  bench("optimized rendering path", async () => renderSequence(initial, true), options)
})
