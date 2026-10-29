// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { TooltipProvider } from "@renderer/components/ui/tooltip"
import { SettingsRow } from "../settings-group"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it("reveals optional help on keyboard focus while keeping scope and the control label visible", async () => {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <SettingsRow
          title="示例偏好"
          description="仅新会话生效。"
          help="两种模式采用不同的回复频率。"
          labelFor="example-preference"
          control={<input id="example-preference" type="checkbox" />}
        />
      </TooltipProvider>
    )
  )

  const control = container.querySelector<HTMLInputElement>("input")!
  expect(control.labels?.[0]?.textContent).toBe("示例偏好")
  expect(container.textContent).toContain("仅新会话生效。")
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  const help = container.querySelector<HTMLButtonElement>('button[aria-label="示例偏好说明"]')
  expect(help).not.toBeNull()

  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }))
    help!.focus()
  })

  const tooltip = document.querySelector('[role="tooltip"]')
  expect(document.activeElement).toBe(help)
  expect(tooltip?.textContent).toContain("两种模式采用不同的回复频率。")
  expect(help!.getAttribute("aria-describedby")).toBe(tooltip?.id)
  expect(container.textContent).toContain("仅新会话生效。")
  expect(control.checked).toBe(false)
})

it("does not add a help button when the row needs no extra explanation", () => {
  act(() => root.render(<SettingsRow title="示例开关" control={<input type="checkbox" />} />))

  expect(container.querySelector("button")).toBeNull()
  expect(container.querySelector("h3")?.textContent).toBe("示例开关")
  expect(container.querySelector("input")).not.toBeNull()
})
