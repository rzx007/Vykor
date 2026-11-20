// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it } from "vitest"
import { $createTextNode, $getRoot, $isElementNode, getNearestEditorFromDOMNode } from "lexical"
import { RichPromptInput } from "../rich-prompt-input"

let container: HTMLDivElement
let root: Root
const rangeBounds = Range.prototype.getBoundingClientRect
beforeEach(() => {
  if (!rangeBounds)
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    })
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  if (!rangeBounds) Reflect.deleteProperty(Range.prototype, "getBoundingClientRect")
})

it("keeps the composer usable after opening and navigating the @ picker", async () => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView")
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => Promise.resolve(),
  })
  try {
    await act(async () =>
      root.render(
        createElement(RichPromptInput, {
          id: "at-picker",
          value: { version: 1, items: [] },
          rows: 2,
          placeholder: "",
          disabled: false,
          contextItems: [
            {
              id: "files",
              label: "文件",
              description: "选择文件",
              group: "添加",
              action: { kind: "files" },
            },
            {
              id: "goal",
              label: "目标",
              description: "设置目标",
              group: "添加",
              action: { kind: "goal" },
            },
          ],
          onChange: () => {},
          onSubmit: () => {},
        })
      )
    )
    const textbox = container.querySelector<HTMLElement>('[role="textbox"]')!
    const editor = getNearestEditorFromDOMNode(textbox)!
    await act(async () =>
      editor.update(
        () => {
          const paragraph = $getRoot().getFirstChild()
          const text = $createTextNode("@")
          if ($isElementNode(paragraph)) paragraph.append(text)
          text.selectEnd()
        },
        { discrete: true }
      )
    )
    expect(container.querySelector('[aria-label="添加上下文"]')).not.toBeNull()
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    )
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain("目标")
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    )
    expect(container.querySelector('[aria-label="添加上下文"]')).toBeNull()
    expect(textbox.textContent).toBe("@")
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original)
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView")
  }
})
