// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { $getRoot, COPY_COMMAND, PASTE_COMMAND, getNearestEditorFromDOMNode } from "lexical"
import { Composer } from "../composer"
import { ScopedOperationError } from "../../session/scoped-operation-errors"
import { composerDocumentFromLexical, restoreComposerDocument } from "../composer-lexical-document"
import type { ComposerDocument } from "@renderer/stores/desktop-session/composer-document"

let container: HTMLDivElement
let root: Root
const plugin = { pluginId: "dev.quality", displayName: "Quality", description: "检查代码质量", version: "1.0.0", scope: "user" as const, origin: "native" as const, capabilities: ["skills" as const] }
const reference = { type: "capability" as const, kind: "plugin" as const, pluginId: "dev.quality", displayName: "Quality" }
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("ClipboardEvent", Event)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})
async function render(draft: ComposerDocument = { version: 1, items: [] }, enabled?: boolean, id = "plugin-test") {
  await act(async () => root.render(createElement(Composer, {
    id, draft, sending: false, models: [], selectedModel: null, selectedProvider: null, effort: null,
    modelLabel: "Model", permissionMode: "default", plugins: [plugin], pluginMentionsEnabled: enabled,
    onDraftChange: () => {}, onSubmit: () => {}, onSelectModel: () => {}, onSelectPermissionMode: () => {},
    onSelectEffort: () => {},
  })))
}
const editor = () => getNearestEditorFromDOMNode(container.querySelector('[role="textbox"]')!)!
const plus = () => container.querySelector<HTMLButtonElement>('button[aria-label="添加上下文"]')!
const pluginOption = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((node) => node.textContent?.includes("Quality"))
it("shows plugin selection in a default build", async () => {
  await render()
  await act(async () => plus().click())
  expect(pluginOption()?.textContent).toContain("检查代码质量")
})
it("keeps plugin entries hidden when the flag is disabled", async () => {
  await render(undefined, false)
  await act(async () => plus().click())
  expect(pluginOption()).toBeUndefined()
})
it.each(["plus", "at"])("selects a structured plugin through %s", async (entry) => {
  await render({ version: 1, items: entry === "at" ? [{ type: "text", text: "@Qua" }] : [] }, true)
  if (entry === "plus") await act(async () => plus().click())
  expect(pluginOption()?.textContent).toContain("检查代码质量")
  expect(container.querySelector('[role="listbox"]')?.textContent).toContain("插件")
  await act(async () => pluginOption()!.click())
  expect(editor().getEditorState().read(composerDocumentFromLexical).items).toEqual([reference, { type: "text", text: " " }])
  expect(container.querySelector('[role="textbox"]')?.textContent).toBe("@Quality ")
  expect(container.querySelector('[role="listbox"]')).toBeNull()
})
it.each(["escape", "outside", "plus"])("closes on %s and reopens on the next plus click", async (dismissal) => {
  await render(undefined, true)
  await act(async () => plus().click())
  await act(async () => {
    if (dismissal === "escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    else if (dismissal === "outside") document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    else plus().click()
  })
  expect(container.querySelector('[role="listbox"]')).toBeNull()
  await act(async () => plus().click())
  expect(pluginOption()).toBeDefined()
})
it("round-trips plugin references through JSON and structured clipboard without internal fields", async () => {
  await render({ version: 1, items: [reference, { type: "text", text: " review" }] }, true)
  const data = new Map<string, string>()
  const event = new Event("copy", { cancelable: true })
  Object.defineProperty(event, "clipboardData", { value: { files: [], getData: (type: string) => data.get(type) ?? "", setData: (type: string, value: string) => data.set(type, value) } })
  await act(async () => {
    editor().setEditorState(editor().parseEditorState(editor().getEditorState().toJSON()))
    editor().update(() => $getRoot().select(0, $getRoot().getChildrenSize()), { discrete: true })
    editor().dispatchCommand(COPY_COMMAND, event as ClipboardEvent)
  })
  expect(data.get("text/plain")).toBe("@Quality review")
  await act(async () => editor().dispatchCommand(PASTE_COMMAND, event as ClipboardEvent))
  expect(editor().getEditorState().read(composerDocumentFromLexical).items).toEqual([reference, { type: "text", text: " review" }])
})
it("remounts the editor for another session so undo cannot restore the previous plugin draft", async () => {
  await render({ version: 1, items: [reference] }, true, "session-a")
  const previous = editor()
  await render({ version: 1, items: [{ type: "text", text: "other" }] }, true, "session-b")
  expect(editor()).not.toBe(previous)
  expect(editor().getEditorState().read(composerDocumentFromLexical).items).toEqual([{ type: "text", text: "other" }])
})
it("lets users close a preparation error", async () => {
  await act(async () => root.render(createElement(ScopedOperationError, { error: "插件暂时不可用" })))
  const dismiss = [...container.querySelectorAll("button")].find((button) => button.textContent === "关闭")
  expect(dismiss).toBeDefined()
  await act(async () => dismiss!.click())
  expect(container.textContent).not.toContain("插件暂时不可用")
})
it("opens a dismissed @ trigger again after deleting and retyping it", async () => {
  await render({ version: 1, items: [{ type: "text", text: "@Qua" }] }, true)
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
  expect(container.querySelector('[role="listbox"]')).toBeNull()
  await act(async () => editor().update(() => restoreComposerDocument({ version: 1, items: [] }), { discrete: true }))
  await act(async () => editor().update(() => restoreComposerDocument({ version: 1, items: [{ type: "text", text: "@Qua" }] }), { discrete: true }))
  expect(pluginOption()).toBeDefined()
})
