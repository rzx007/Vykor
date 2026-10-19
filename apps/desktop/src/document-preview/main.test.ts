// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { URL as NodeURL } from "node:url"
import type { PreviewContext } from "@open-file-viewer/core"
const styles = readFileSync(new NodeURL("./style.css", import.meta.url), "utf8")

const state = vi.hoisted(() => ({ supported: true, zoom: 1, loaded: false }))
vi.mock("@open-file-viewer/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@open-file-viewer/core")>()
  return {
    ...actual,
    officePlugin: () => ({
      name: "test-office",
      match: () => true,
      render: (ctx: PreviewContext) => {
        state.loaded = true
        ctx.toolbar?.setZoom(state.zoom)
        return {
          canCommand: () => state.supported,
          command: (command: string) => {
            state.zoom =
              command === "zoom-in"
                ? state.zoom + 0.1
                : command === "zoom-out"
                  ? state.zoom - 0.1
                  : 1
            ctx.toolbar?.setZoom(state.zoom)
            return true
          },
          destroy() {},
        }
      },
    }),
  }
})

beforeAll(async () => {
  await import("./main")
})
beforeEach(() => {
  document.body.innerHTML = '<div id="viewer"></div>'
  const sheet = document.createElement("style")
  sheet.textContent = styles
  document.head.append(sheet)
  Object.assign(state, { supported: true, zoom: 1, loaded: false })
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: vi.fn(() => "blob:local-preview") },
    revokeObjectURL: { configurable: true, value: vi.fn() },
  })
})
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"))
  document.querySelectorAll("style").forEach((sheet) => sheet.remove())
  vi.restoreAllMocks()
})

async function openDocument(supported = true): Promise<HTMLElement> {
  state.supported = supported
  window.dispatchEvent(
    new MessageEvent("message", {
      source: window,
      data: { type: "document:open", name: "slides.pptx", bytes: new ArrayBuffer(4) },
    })
  )
  await vi.waitFor(() => expect(state.loaded).toBe(true))
  return document.querySelector<HTMLElement>('[role="toolbar"]')!
}

it("shows working zoom controls and updates the displayed ratio", async () => {
  const toolbar = await openDocument()
  const buttons = toolbar.querySelectorAll("button")
  expect(buttons).toHaveLength(3)
  expect(getComputedStyle(toolbar).display).not.toBe("none")
  expect(buttons[1]!.textContent).toBe("100%")
  buttons[2]!.click()
  expect(buttons[1]!.textContent).toBe("110%")
  buttons[0]!.click()
  expect(buttons[1]!.textContent).toBe("100%")
  buttons[2]!.click()
  buttons[1]!.click()
  expect(buttons[1]!.textContent).toBe("100%")
})

it("hides the toolbar when the document has no supported commands", async () => {
  const toolbar = await openDocument(false)
  expect(getComputedStyle(toolbar).display).toBe("none")
})

it.each(["", "<button disabled>缩放</button>", "<button hidden>缩放</button>"])(
  "collapses a toolbar without usable controls: %s",
  (markup) => {
    const toolbar = document.createElement("div")
    toolbar.className = "ofv-toolbar"
    toolbar.innerHTML = markup
    document.querySelector("#viewer")!.append(toolbar)
    expect(getComputedStyle(toolbar).display).toBe("none")
  }
)
