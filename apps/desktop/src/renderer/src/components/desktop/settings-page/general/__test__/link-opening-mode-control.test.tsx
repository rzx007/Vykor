// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { LinkOpeningModeControl } from "../general-display-controls"

let root: Root
let host: HTMLDivElement
const snapshot = vi.fn(async () => "system")
const update = vi.fn(async (input: { linkOpeningMode: string }) => input.linkOpeningMode)

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      settings: {
        getLinkOpeningMode: snapshot,
        updateLinkOpeningMode: update,
      },
    },
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

async function choose(label: string) {
  await act(async () => host.querySelector<HTMLButtonElement>('[role="combobox"]')!.click())
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (node) => node.textContent === label
  )
  expect(option).toBeDefined()
  await act(async () => option!.click())
}

it("loads the saved choice and lets the user restore asking on every click", async () => {
  await act(async () => root.render(<LinkOpeningModeControl />))
  expect(host.textContent).toContain("系统默认浏览器")
  await choose("每次询问")
  expect(update).toHaveBeenCalledExactlyOnceWith({ linkOpeningMode: "ask" })
  expect(host.querySelector('[data-slot="select-value"]')?.textContent).toBe("每次询问")
})

it("restores the previous choice and reports a failed save", async () => {
  update.mockRejectedValueOnce(new Error("写入失败"))
  await act(async () => root.render(<LinkOpeningModeControl />))
  await choose("Vykor 内置浏览器")
  expect(host.querySelector('[data-slot="select-value"]')?.textContent).toBe("系统默认浏览器")
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("写入失败")
})
