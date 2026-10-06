// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { ExpandableActionBar } from "../expandable-action-bar"

const host = document.createElement("div")
document.body.append(host)
const root = createRoot(host)
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
afterEach(() => {
  act(() => root.render(null))
})

it("keeps actions labelled, exposes the selected tool and preserves keyboard focus on activation", async () => {
  const click = vi.fn()
  await act(async () =>
    root.render(
      <ExpandableActionBar
        expanded
        expandOnHover={false}
        expandOnFocus={false}
        items={[
          { id: "pick", label: "添加批注", icon: <span />, active: true, onClick: click },
          { id: "undo", label: "撤销", icon: <span />, disabled: true },
        ]}
      />
    )
  )
  const button = host.querySelector<HTMLButtonElement>('[aria-label="添加批注"]')!
  expect(button.getAttribute("aria-pressed")).toBe("true")
  await act(async () => {
    button.focus()
    button.click()
  })
  expect(click).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(button)
  expect(host.querySelector<HTMLButtonElement>('[aria-label="撤销"]')!.disabled).toBe(true)
})
