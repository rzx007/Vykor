// @vitest-environment jsdom
import { act, type ComponentProps } from "react"
import { createRoot } from "react-dom/client"
import { MotionConfig } from "motion/react"
import { expect, it, vi } from "vitest"
import { AssistantMarkdown } from "../assistant-markdown"

const checked = vi.hoisted(() => ({ inputs: [] as Array<{ source: string; matches: boolean }> }))
// Instrument the real boundary AFTER Streamdown's remend pass; keep parsing and rendering real.
vi.mock("streamdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("streamdown")>()
  const { createElement } = await import("react")
  return {
    ...actual,
    Streamdown: (props: ComponentProps<typeof actual.Streamdown>) =>
      createElement(actual.Streamdown, {
        ...props,
        parseMarkdownIntoBlocksFn: (source: string) => {
          const result = props.parseMarkdownIntoBlocksFn!(source)
          checked.inputs.push({
            source,
            matches:
              JSON.stringify(result) === JSON.stringify(actual.parseMarkdownIntoBlocks(source)),
          })
          return result
        },
      }),
  }
})

it("matches full parsing after real incomplete-Markdown repair changes the previous suffix", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const onOpenFile = () => {}
  const source = "首段\n\n第二段\n\n**尚未闭合"
  try {
    for (let end = 1; end <= source.length; end++) {
      await act(async () =>
        root.render(
          <MotionConfig reducedMotion="always">
            <AssistantMarkdown
              text={source.slice(0, end)}
              streaming
              animateInitialText={false}
              onOpenFile={onOpenFile}
            />
          </MotionConfig>
        )
      )
    }
    await act(async () =>
      root.render(
        <MotionConfig reducedMotion="always">
          <AssistantMarkdown
            text={`${source}，继续追加**\n\n最终一段`}
            streaming
            animateInitialText={false}
            onOpenFile={onOpenFile}
          />
        </MotionConfig>
      )
    )
    expect(checked.inputs.some((input) => input.source === `${source}**`)).toBe(true)
    expect(checked.inputs.every((input) => input.matches)).toBe(true)
    expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe(
      "尚未闭合，继续追加"
    )
  } finally {
    act(() => root.unmount())
    container.remove()
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  }
})
