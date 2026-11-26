// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { AssistantMarkdown } from "../assistant-markdown"

vi.mock("@renderer/components/ui/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

const program = 'root = FilterableTable("结果", ["名称", "分数"], [["甲", 10], ["乙", 2]])'

it("renders an enabled valid table and preserves the readable Markdown fallback", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const render = (showInteractiveUi: boolean, streaming = false, code = program, close = true) =>
    act(async () => {
      root.render(
        <AssistantMarkdown
          text={`两项结果。\n\n\`\`\`vykor-ui-v1\n${code}${close ? "\n```" : ""}`}
          showInteractiveUi={showInteractiveUi}
          streaming={streaming}
          animateInitialText={false}
          onOpenFile={() => {}}
        />
      )
    })

  try {
    await render(false)
    expect(container.querySelector("table")).toBeNull()
    await render(true, true, 'root = FilterableTable("结果", ["名称", "分数"', false)
    expect(container.querySelector("table")).toBeNull()
    await render(true)
    await act(async () => {
      await import("../../interactive-ui/interactive-ui-block")
    })
    expect(container.querySelector("table")).not.toBeNull()
    const scrollRegion = container.querySelector<HTMLElement>(
      '[role="region"][aria-label="滚动查看结果"]'
    )
    expect(scrollRegion?.tabIndex).toBe(0)
    expect(scrollRegion?.querySelector("table")).toBe(container.querySelector("table"))
    const rows = () => Array.from(container.querySelectorAll("tbody tr"), (row) => row.textContent)
    expect(rows()).toEqual(["甲10", "乙2"])
    await act(async () =>
      container.querySelector<HTMLButtonElement>("th:nth-child(2) button")!.click()
    )
    expect(rows()).toEqual(["乙2", "甲10"])
    const input = container.querySelector<HTMLInputElement>('input[aria-label="筛选表格"]')!
    expect(input.closest('[data-slot="input-group"]')?.getAttribute("data-shape")).toBe("pill")
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "甲")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(rows()).toEqual(["甲10"])
    expect(container.textContent).toContain("1 / 2 行")
    const clear = container.querySelector<HTMLButtonElement>('button[aria-label="清除筛选"]')!
    clear.focus()
    await act(async () => clear.click())
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe("")
    expect(rows()).toEqual(["乙2", "甲10"])
    await render(false)
    expect(container.querySelector("table")).toBeNull()
    expect(container.textContent).toContain("两项结果。")
    await render(true, false, program, false)
    expect(container.querySelector("table")).toBeNull()
    await render(true, false, 'root = FilterableTable("结果", ["名称"], [[1, 2]])')
    expect(container.querySelector("table")).toBeNull()
    await render(true, false, 'root = FilterableTable("结果", ["名称", "分数"], [[+1]])')
    expect(container.querySelector("table")).toBeNull()
    expect(container.textContent).toContain("两项结果。")
  } finally {
    await act(async () => root.unmount())
    container.remove()
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  }
})
