// @vitest-environment jsdom

import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import type { BrowserAnnotationRecord } from "@shared/browser-annotation"
import { ComposerBrowserAnnotations } from "../composer-browser-annotations"

const annotations: BrowserAnnotationRecord[] = [
  {
    id: "a-1",
    pageUrl: "https://example.test",
    target: "提交订单",
    selector: "#submit-order",
    locatorKind: "unique-id",
    tagName: "button",
    role: "button",
    name: "提交订单",
    comment: "增加按钮间距",
  },
  {
    id: "a-2",
    pageUrl: "https://example.test",
    target: "订单标题",
    selector: "#order-title",
    locatorKind: "unique-id",
    tagName: "h1",
    role: "heading",
    name: "订单标题",
    comment: "标题再清晰一些",
  },
]

let container: HTMLDivElement
let root: Root
let submits: number

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        return undefined
      }
      unobserve() {
        return undefined
      }
      disconnect() {
        return undefined
      }
    }
  )
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  submits = 0
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(initial = annotations, disabled = false) {
  function Harness() {
    const [records, setRecords] = useState(initial)
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submits++
        }}
      >
        <ComposerBrowserAnnotations
          annotations={records}
          disabled={disabled}
          onUpdateComment={(id, comment) =>
            setRecords((current) =>
              current.map((item) => (item.id === id ? { ...item, comment } : item))
            )
          }
          onRemove={(id) => setRecords((current) => current.filter((item) => item.id !== id))}
          onClear={() => setRecords([])}
        />
      </form>
    )
  }
  await act(async () => root.render(<Harness />))
}

function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label
  )
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}

async function click(label: string) {
  await act(async () => button(label).click())
}

async function press(target: Element, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options })
  await act(async () => {
    target.dispatchEvent(event)
  })
  return event
}

async function type(value: string) {
  const textarea = document.querySelector("textarea")!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      value
    )
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
  })
  return textarea
}

it("hides an empty package and shows readable annotation details when opened", async () => {
  await render([])
  expect(container.querySelector("button")).toBeNull()
  await render()
  await click("2 条批注")
  const popup = document.querySelector('[role="dialog"]')!
  expect(popup.textContent).toContain("button")
  expect(popup.textContent).toContain("提交订单")
  expect(popup.textContent).toContain("增加按钮间距")
  expect(popup.textContent).not.toContain("#submit-order")
  expect(popup.textContent).not.toContain("https://example.test")
})

it("opens on focus and returns focus to the chip when Escape closes the list", async () => {
  await render()
  const trigger = button("2 条批注")
  await act(async () => trigger.focus())
  expect(trigger.getAttribute("aria-expanded")).toBe("true")
  await act(async () => button("编辑批注 1").focus())
  await press(document.activeElement!, "Escape")
  expect(trigger.getAttribute("aria-expanded")).toBe("false")
  expect(document.activeElement).toBe(trigger)
})

it("opens on hover and keeps the list open while the pointer enters it", async () => {
  await render()
  const trigger = button("2 条批注")
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, clientX: 5, clientY: 5 }))
    trigger.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 5, clientY: 5 }))
    await new Promise((resolve) => setTimeout(resolve, 350))
  })
  expect(trigger.getAttribute("aria-expanded")).toBe("true")
  const popup = document.querySelector('[role="dialog"]')!
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true, relatedTarget: popup }))
    popup.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, relatedTarget: trigger }))
    await new Promise((resolve) => setTimeout(resolve, 200))
  })
  expect(trigger.getAttribute("aria-expanded")).toBe("true")
})

it("replaces the list with the selected annotation editor and restores it on cancel", async () => {
  await render()
  await click("2 条批注")
  await click("编辑批注 1")
  const popup = document.querySelector('[role="dialog"]')!
  expect(popup.querySelector("h2")?.textContent).toBe("编辑批注")
  expect(popup.textContent).toContain("button")
  expect(popup.textContent).toContain("提交订单")
  expect(popup.textContent).not.toContain("订单标题")
  expect(popup.querySelector("li")).toBeNull()
  expect(popup.querySelector('button[aria-label^="编辑批注"]')).toBeNull()
  expect(popup.querySelector('button[aria-label^="删除批注"]')).toBeNull()
  expect(popup.querySelector("textarea")?.value).toBe("增加按钮间距")

  await type("尚未保存")
  await click("取消")
  expect(document.querySelector("textarea")).toBeNull()
  expect(popup.textContent).toContain("增加按钮间距")
  expect(popup.textContent).toContain("订单标题")
  await click("编辑批注 1")
  expect(document.querySelector("textarea")?.value).toBe("增加按钮间距")
  expect(submits).toBe(0)
})

it("blocks empty and oversized comments without leaving the editor", async () => {
  await render()
  await click("2 条批注")
  await click("编辑批注 1")
  for (const value of ["   ", "a".repeat(2001)]) {
    const textarea = await type(value)
    expect(button("保存").disabled).toBe(true)
    await press(textarea, "Enter", { ctrlKey: true })
    expect(document.querySelector("textarea")).toBe(textarea)
  }
  await type("  调整后的意见  ")
  await click("保存")
  expect(document.querySelector("textarea")).toBeNull()
  expect(document.body.textContent).toContain("调整后的意见")
  expect(document.body.textContent).toContain("订单标题")
  expect(submits).toBe(0)
})

it.each([{ ctrlKey: true }, { metaKey: true }])(
  "saves edits with the platform shortcut without submitting the composer: %j",
  async (modifier) => {
    await render()
    await click("2 条批注")
    await click("编辑批注 1")
    const textarea = await type("调整后的意见")
    expect(textarea.maxLength).toBe(2000)
    await press(textarea, "Enter", modifier)
    expect(document.querySelector("textarea")).toBeNull()
    expect(document.body.textContent).toContain("调整后的意见")
    expect(submits).toBe(0)
    expect(document.querySelectorAll("form")).toHaveLength(1)
  }
)

it("cancels an unfinished edit with Escape and keeps the original comment", async () => {
  await render()
  await click("2 条批注")
  await click("编辑批注 1")
  const textarea = await type("尚未保存")
  await press(textarea, "Escape")
  expect(document.querySelector("textarea")).toBeNull()
  expect(document.body.textContent).toContain("增加按钮间距")
  expect(document.body.textContent).not.toContain("尚未保存")
  expect(button("2 条批注").getAttribute("aria-expanded")).toBe("true")
  expect(document.activeElement).toBe(button("2 条批注"))
})

it("discards an unfinished edit when the popover is closed", async () => {
  await render()
  await click("2 条批注")
  await click("编辑批注 1")
  await type("尚未保存")
  await act(async () => {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
    document.body.click()
  })
  expect(button("2 条批注").getAttribute("aria-expanded")).toBe("false")
  await click("2 条批注")
  expect(document.querySelector("textarea")).toBeNull()
  expect(document.body.textContent).toContain("增加按钮间距")
  expect(document.body.textContent).not.toContain("尚未保存")
})

it("removes individual annotations and hides the package after the last one", async () => {
  await render()
  await click("2 条批注")
  await click("删除批注 1")
  expect(button("1 条批注")).toBeDefined()
  expect(document.body.textContent).not.toContain("增加按钮间距")
  await click("删除批注 1")
  expect(container.querySelector("button")).toBeNull()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(submits).toBe(0)
})

it("clears the package from the chip without submitting a message", async () => {
  await render()
  await click("移除全部批注")
  expect(container.querySelector("button")).toBeNull()
  expect(submits).toBe(0)
})

it("keeps package mutations disabled while the composer is disabled", async () => {
  await render(annotations, true)
  await click("2 条批注")
  expect(button("编辑批注 1").disabled).toBe(true)
  expect(button("删除批注 1").disabled).toBe(true)
  expect(button("移除全部批注").disabled).toBe(true)
  await click("删除批注 1")
  await click("移除全部批注")
  expect(button("2 条批注")).toBeDefined()
})
