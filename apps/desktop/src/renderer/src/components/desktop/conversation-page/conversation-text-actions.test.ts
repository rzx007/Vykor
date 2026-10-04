// @vitest-environment jsdom
import type { MouseEvent as ReactMouseEvent } from "react"
import { afterEach, beforeEach, expect, it } from "vitest"
import { openComposerTextMenu, openConversationTextMenu } from "./conversation-text-actions"

let viewport: HTMLDivElement
let clipboardText: string
let requests: { editable: boolean; hasSelection: boolean }[]
let menuAction: "copy" | "select-all" | null

beforeEach(() => {
  clipboardText = ""
  requests = []
  menuAction = null
  viewport = document.createElement("div")
  viewport.innerHTML = "<p>  中文第一行\nsecond line  </p><p>第二条消息</p>"
  document.body.append(viewport)
  Object.assign(window, {
    desktop: {
      clipboard: {
        writeText: async (text: string) => {
          clipboardText = text
        },
        showTextMenu: async (input: { editable: boolean; hasSelection: boolean }) => {
          requests.push(input)
          // 模拟菜单打开后选区不再可读，复制必须使用右键时的快照。
          window.getSelection()?.removeAllRanges()
          return menuAction
        },
      },
    },
  })
})
afterEach(() => {
  viewport.remove()
  window.getSelection()?.removeAllRanges()
  Reflect.deleteProperty(window, "desktop")
})
function select(node: Node) {
  const range = document.createRange()
  range.selectNodeContents(node)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
}
function event(target: HTMLElement = viewport): ReactMouseEvent<HTMLElement> {
  return {
    target,
    currentTarget: viewport,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  } as unknown as ReactMouseEvent<HTMLElement>
}

it("copies exactly the selected message text, including whitespace, after native menu focus changes", async () => {
  select(viewport.firstChild!)
  menuAction = "copy"
  await openConversationTextMenu(event())
  expect(requests).toEqual([{ editable: false, hasSelection: true }])
  expect(clipboardText).toBe("  中文第一行\nsecond line  ")
})
it("selects only this conversation, not the sidebar or the rest of the document", async () => {
  const sidebar = document.createElement("p")
  sidebar.textContent = "侧栏不能被全选"
  document.body.append(sidebar)
  menuAction = "select-all"
  await openConversationTextMenu(event())
  expect(window.getSelection()?.toString()).toContain("第二条消息")
  expect(window.getSelection()?.toString()).not.toContain("侧栏不能被全选")
  sidebar.remove()
})
it("does not enable copying a selection from another pane", async () => {
  const outside = document.createElement("p")
  outside.textContent = "另一个聊天的选区"
  document.body.append(outside)
  select(outside)
  await openConversationTextMenu(event())
  expect(requests).toEqual([{ editable: false, hasSelection: false }])
  outside.remove()
})
it("does not open the message menu for an inline editor", async () => {
  const editor = document.createElement("div")
  editor.contentEditable = "true"
  editor.setAttribute("contenteditable", "true")
  viewport.append(editor)
  await openConversationTextMenu(event(editor))
  expect(requests).toEqual([])
})
it("delegates editing to the native menu rather than replacing the composer with plain text", async () => {
  viewport.setAttribute("contenteditable", "true")
  select(viewport.firstChild!)
  await openComposerTextMenu(event(), false)
  expect(requests).toEqual([{ editable: true, hasSelection: true }])
  expect(clipboardText).toBe("")
  expect(viewport.textContent).toContain("第二条消息")
})
it("does not offer destructive editing for a disabled composer", async () => {
  await openComposerTextMenu(event(), true)
  expect(requests).toEqual([])
})
it("does not borrow a selected range from another pane for composer cut or copy", async () => {
  const outside = document.createElement("p")
  outside.textContent = "外部选区"
  document.body.append(outside)
  select(outside)
  await openComposerTextMenu(event(), false)
  expect(requests).toEqual([{ editable: true, hasSelection: false }])
  outside.remove()
})
