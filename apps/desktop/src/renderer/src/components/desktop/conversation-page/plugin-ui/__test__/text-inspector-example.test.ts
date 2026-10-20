// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { parsePluginUiConversationRequest, type PluginUiViewSnapshot } from "@vykor/client"
import { snapshot as base } from "./plugin-ui-fixtures.test-support"

const roots = ["examples/plugins/text-inspector", "skills/create-plugin/assets/text-inspector"]
async function mount(root: string, text = "ok  \n\titem\n") {
  const ui = resolve(process.cwd(), "../..", root, "ui")
  const html = new DOMParser().parseFromString(readFileSync(resolve(ui, "panel.template.html"), "utf8"), "text/html")
  document.head.innerHTML = html.head.innerHTML
  document.body.innerHTML = html.body.innerHTML
  let current: PluginUiViewSnapshot = { ...base, surface: "session-sidebar", capabilities: { draft: true, submit: true },
    data: { text, findings: [{ line: 1, code: "trailing-whitespace" }, { line: 2, code: "tab-indentation" }], truncated: false } }
  let notify: (value: PluginUiViewSnapshot) => void = () => {}
  const conversations: unknown[] = []
  const actions: unknown[] = []
  let failure: string | undefined
  const client = {
    getSnapshot: async () => current,
    onSnapshot(listener: typeof notify) { notify = listener; listener(current) },
    requestAction: async (id: string, args: unknown) => { actions.push({ id, args }); return { requestId: "preview" } },
    requestConversation: async (value: unknown) => {
      conversations.push(parsePluginUiConversationRequest(value))
      if (failure) throw Object.assign(new Error(failure), { code: failure })
      return { kind: "conversation", mode: "draft", added: true, revision: current.revision }
    },
    dismiss: async () => {}, dispose() {},
  }
  const source = readFileSync(resolve(ui, "panel.mjs"), "utf8")
    .replace(/^import[^\n]+\n/, "")
    .replace(/^const \{[^\n]+VykorPluginUi;\s*$/m, "")
    .replace(/initialize\(\);\s*$/, "return initialize();")
  await new Function("createPluginUiClient", "applyPluginUiAppearance", source)(async () => client,
    (appearance: PluginUiViewSnapshot["appearance"]) => document.documentElement.style.setProperty("--ohs-background", appearance.colors.background))
  return { conversations, actions, update(value: Partial<PluginUiViewSnapshot>) { current = { ...current, ...value }; notify(current) },
    fail(code: string) { failure = code } }
}
function button(id: string) { return document.querySelector<HTMLButtonElement>("#" + id)! }
function note() { return document.querySelector<HTMLTextAreaElement>("#conversation-text")! }
async function click(id: string) { button(id).click(); await new Promise(resolve => setTimeout(resolve, 0)) }
afterEach(() => { window.dispatchEvent(new Event("pagehide")); document.body.replaceChildren() })

it.each(roots)("%s keeps local selection and note on same-revision appearance/capability updates", async root => {
  const page = await mount(root)
  document.querySelector<HTMLInputElement>("input")!.click()
  note().value = "我的说明"
  page.update({ appearance: { ...base.appearance, colors: { ...base.appearance.colors, background: "#123456" } }, capabilities: { draft: false, submit: true } })
  expect(document.querySelector<HTMLInputElement>("input")!.checked).toBe(true)
  expect(note().value).toBe("我的说明")
  expect(document.documentElement.style.getPropertyValue("--ohs-background")).toBe("#123456")
  expect(button("draft").hidden).toBe(true)
  expect(button("submit").hidden).toBe(false)
  page.update({ revision: 2 })
  expect(document.querySelector<HTMLInputElement>("input")!.checked).toBe(false)
})
it.each(roots)("%s constructs the selected bounded conversation data and preserves Native preview", async root => {
  const page = await mount(root)
  expect(button("draft").disabled).toBe(true)
  document.querySelector<HTMLInputElement>("input")!.click()
  note().value = "请解释所选问题"
  await click("draft")
  expect(page.conversations).toEqual([{ mode: "draft", expectedRevision: 1, text: "请解释所选问题",
    data: { findings: [{ line: 1, code: "trailing-whitespace", text: "ok  " }] } }])
  await click("preview-button")
  expect(page.actions).toEqual([{ id: "preview", args: { text: "ok  \n\titem\n", selected: ["1:trailing-whitespace"] } }])
})
it.each(roots)("%s allows draft handoff from a resolved read-only result", async root => {
  const page = await mount(root)
  page.update({ status: "resolved", readOnly: true, capabilities: { draft: true, submit: false } })
  const input = document.querySelector<HTMLInputElement>("input")!
  expect(input.disabled).toBe(false)
  input.click()
  await click("draft")
  expect(page.conversations).toHaveLength(1)
  expect(button("submit").hidden).toBe(true)
  expect(button("preview-button").disabled).toBe(true)
  expect(button("dismiss").disabled).toBe(true)
})
it.each(roots)("%s reports oversized selected data without sending or clearing local input", async root => {
  const page = await mount(root, "x".repeat(34000) + "  \n\titem\n")
  document.querySelector<HTMLInputElement>("input")!.click()
  note().value = "保留说明"
  await click("submit")
  expect(page.conversations).toEqual([])
  expect(document.querySelector("#status")!.textContent).toContain("32 KiB")
  expect(note().value).toBe("保留说明")
  expect(document.querySelector<HTMLInputElement>("input")!.checked).toBe(true)
})
it.each(roots)("%s keeps local note/selection after cancellation and resets on a new mount", async root => {
  const page = await mount(root)
  document.querySelector<HTMLInputElement>("input")!.click()
  note().value = "取消后保留"
  page.fail("plugin_ui_user_cancelled")
  await click("submit")
  expect(note().value).toBe("取消后保留")
  expect(document.querySelector<HTMLInputElement>("input")!.checked).toBe(true)
  window.dispatchEvent(new Event("pagehide"))
  await mount(root)
  expect(note().value).not.toBe("取消后保留")
  expect(document.querySelector<HTMLInputElement>("input")!.checked).toBe(false)
})
