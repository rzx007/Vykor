// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { MessageLinkOpening } from "../message-link-opening"

let root: Root
let host: HTMLDivElement
let mode = "ask"
const openBrowser = vi.fn()
const openExternal = vi.fn(async () => {})
const getLinkOpeningMode = vi.fn(async () => mode)
const updateLinkOpeningMode = vi.fn(async (input: { linkOpeningMode: string }) => {
  mode = input.linkOpeningMode
  return mode
})

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
  mode = "ask"
  getLinkOpeningMode.mockImplementation(async () => mode)
  updateLinkOpeningMode.mockImplementation(async (input) => {
    mode = input.linkOpeningMode
    return mode
  })
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      window: { openExternal },
      settings: { getLinkOpeningMode, updateLinkOpeningMode },
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

async function render(scopeId = "session:a", url = "https://example.com/docs?q=1#section") {
  await act(async () =>
    root.render(
      <MessageLinkOpening scopeId={scopeId} onOpenBrowser={openBrowser}>
        <div data-message-web-links="true">
          <a href={url} data-streamdown="link" onClick={(event) => event.preventDefault()}>
            文档
          </a>
        </div>
        <a href="#local" onClick={(event) => event.preventDefault()}>
          普通链接
        </a>
      </MessageLinkOpening>
    )
  )
}

async function clickLink() {
  await act(async () => host.querySelector("a")!.click())
}
async function button(label: string) {
  const control = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label
  )
  expect(control, label).toBeDefined()
  await act(async () => control!.click())
}
async function chooseSystemBrowser() {
  await act(async () => (document.querySelector('[role="combobox"]') as HTMLElement).click())
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
    node.textContent?.includes("系统默认浏览器")
  )
  expect(option).toBeDefined()
  await act(async () => option!.click())
}

it("asks with the builtin browser selected and does nothing on cancel", async () => {
  await render()
  await clickLink()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(document.querySelector('[role="combobox"]')?.textContent).toContain("Vykor 内置浏览器")
  expect(document.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false")
  await button("取消")
  expect(openBrowser).not.toHaveBeenCalled()
  expect(openExternal).not.toHaveBeenCalled()
  expect(updateLinkOpeningMode).not.toHaveBeenCalled()
})

it("opens once without remembering and asks again on the next click", async () => {
  await render()
  await clickLink()
  await button("打开")
  expect(openBrowser).toHaveBeenCalledExactlyOnceWith("https://example.com/docs?q=1#section")
  expect(updateLinkOpeningMode).not.toHaveBeenCalled()
  await clickLink()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})

it("remembers the system browser and opens subsequent links directly", async () => {
  await render()
  await clickLink()
  await chooseSystemBrowser()
  await act(async () => (document.querySelector('[role="checkbox"]') as HTMLElement).click())
  await button("打开")
  expect(updateLinkOpeningMode).toHaveBeenCalledExactlyOnceWith({ linkOpeningMode: "system" })
  expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/docs?q=1#section")
  await clickLink()
  expect(openExternal).toHaveBeenCalledTimes(2)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it.each(["builtin", "system"])("uses the saved %s choice immediately", async (saved) => {
  mode = saved
  await render()
  await clickLink()
  expect(saved === "builtin" ? openBrowser : openExternal).toHaveBeenCalledExactlyOnceWith(
    "https://example.com/docs?q=1#section"
  )
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it("keeps the dialog open and reports a failed remember operation", async () => {
  updateLinkOpeningMode.mockRejectedValueOnce(new Error("保存失败"))
  await render()
  await clickLink()
  await act(async () => (document.querySelector('[role="checkbox"]') as HTMLElement).click())
  await button("打开")
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("保存失败")
  expect(openBrowser).not.toHaveBeenCalled()
  expect(openExternal).not.toHaveBeenCalled()
})

it("ignores an earlier settings read after switching conversations", async () => {
  let finish!: (value: string) => void
  getLinkOpeningMode.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  await render()
  await clickLink()
  await render("session:b")
  await act(async () => finish("builtin"))
  expect(openBrowser).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it("does not route unsafe schemes or unmarked links into either browser", async () => {
  await render("session:a", "javascript:alert(1)")
  await clickLink()
  await act(async () => host.querySelectorAll("a")[1]!.click())
  expect(getLinkOpeningMode).not.toHaveBeenCalled()
  expect(openBrowser).not.toHaveBeenCalled()
  expect(openExternal).not.toHaveBeenCalled()
})

it("lets the user choose a browser when reading preferences fails", async () => {
  getLinkOpeningMode.mockRejectedValueOnce(new Error("读取失败"))
  await render()
  await clickLink()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("读取失败")
  await button("打开")
  expect(openBrowser).toHaveBeenCalledExactlyOnceWith("https://example.com/docs?q=1#section")
})

it("offers the builtin browser after opening the saved system browser fails", async () => {
  mode = "system"
  openExternal.mockRejectedValueOnce(new Error("浏览器未启动"))
  await render()
  await clickLink()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("浏览器未启动")
  await button("打开")
  expect(openBrowser).toHaveBeenCalledExactlyOnceWith("https://example.com/docs?q=1#section")
})

it("does not open in the next conversation when saving a remembered choice finishes late", async () => {
  let finish!: (value: string) => void
  updateLinkOpeningMode.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  await render()
  await clickLink()
  await act(async () => (document.querySelector('[role="checkbox"]') as HTMLElement).click())
  await button("打开")
  await render("session:b")
  await act(async () => finish("builtin"))
  expect(openBrowser).not.toHaveBeenCalled()
  expect(openExternal).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it("uses the same choice dialog for a middle click and suppresses native navigation", async () => {
  await render()
  const event = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true })
  await act(async () => {
    host.querySelector("a")!.dispatchEvent(event)
  })
  expect(event.defaultPrevented).toBe(true)
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(getLinkOpeningMode).toHaveBeenCalledOnce()
  expect(openExternal).not.toHaveBeenCalled()
})
