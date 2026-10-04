// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, expect, it } from "vitest"

const example = resolve(process.cwd(), "../../examples/plugins/text-inspector/ui")
const template = readFileSync(resolve(example, "panel.template.html"), "utf8")
const source = readFileSync(resolve(example, "panel.mjs"), "utf8")

// Run the real browser entry against its SDK boundary, without a model or daemon.
async function mount(surface: "tool-result" | "session-sidebar") {
  const html = new DOMParser().parseFromString(template, "text/html")
  document.head.innerHTML = html.head.innerHTML
  document.body.innerHTML = html.body.innerHTML
  const snapshot = {
    revision: 1,
    status: "open",
    readOnly: false,
    theme: "light",
    surface,
    data: {
      text: "ok  \n\titem\n",
      findings: [
        { line: 1, code: "trailing-whitespace" },
        { line: 2, code: "tab-indentation" },
      ],
      truncated: false,
    },
  }
  const client = {
    onSnapshot: (listener: (value: typeof snapshot) => void) => listener(snapshot),
    resize: async (height: number) => {
      expect(height).toBe(520)
      if (surface !== "tool-result")
        throw Object.assign(new Error("card only"), { code: "plugin_ui_surface_not_supported" })
    },
    dispose() {},
  }
  const entry = source
    .replace(/^import[^\n]+\n/, "")
    .replace(/initialize\(\);\s*$/, "return initialize();")
  await new Function("createPluginUiClient", entry)(async () => client)
  await Promise.resolve()
}
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"))
  document.body.replaceChildren()
})

it("loads a sidebar without an invalid sizing error or a redundant sidebar action", async () => {
  await mount("session-sidebar")
  expect(document.querySelector("#status")!.textContent).toBe("发现 2 个问题。")
  expect(getComputedStyle(document.querySelector("#sidebar")!).display).toBe("none")
})
it("keeps the card sidebar action and enables preview only after a real selection", async () => {
  await mount("tool-result")
  const button = document.querySelector<HTMLButtonElement>("#preview-button")!
  expect(button.disabled).toBe(true)
  expect(getComputedStyle(document.querySelector("#sidebar")!).display).not.toBe("none")
  document.querySelector<HTMLInputElement>("input")!.click()
  expect(button.disabled).toBe(false)
})
