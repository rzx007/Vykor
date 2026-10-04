// @vitest-environment jsdom
import { act, useRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { MainLayoutContext } from "../layout/main-layout/main-layout-context"
import { SideChatSelectionActions } from "./side-chat-selection-actions"

let root: Root
let container: HTMLDivElement
let copied: string
let opened: string[]
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        return undefined
      }
      unobserve() {
        return undefined
      }
      disconnect() {
        return undefined
      }
    }
  )
  Range.prototype.getBoundingClientRect = () => new DOMRect(20, 40, 80, 20)
  copied = ""
  opened = []
  Object.assign(window, {
    desktop: {
      clipboard: {
        writeText: async (text: string) => {
          copied = text
        },
      },
    },
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.getSelection()?.removeAllRanges()
  Reflect.deleteProperty(window, "desktop")
  vi.unstubAllGlobals()
})
function Workspace() {
  const viewportRef = useRef<HTMLDivElement>(null)
  return (
    <MainLayoutContext.Provider
      value={{
        conversationWorkspace: null,
        startNewConversation: () => undefined,
        openSideChat: (_source, text) => {
          opened.push(text ?? "")
        },
      }}
    >
      <div ref={viewportRef}>
        <p>{"  中文选区\nsecond line  "}</p>
      </div>
      <SideChatSelectionActions sourceId="main" viewportRef={viewportRef} />
    </MainLayoutContext.Provider>
  )
}
async function mountSelection() {
  await act(async () => root.render(<Workspace />))
  await act(async () => {
    const range = document.createRange()
    range.selectNodeContents(container.querySelector("p")!)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    document.dispatchEvent(new Event("selectionchange"))
  })
}
function copyButton() {
  return document.querySelector<HTMLButtonElement>('button[aria-label="复制选中内容"]')
}

it("copies the same exact selection from the left action without opening a side chat", async () => {
  await mountSelection()
  const copy = copyButton()!
  const ask = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "在侧边聊天中提问"
  )!
  expect(copy.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await act(async () => {
    copy.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    copy.click()
  })
  expect(copied).toBe("  中文选区\nsecond line  ")
  expect(opened).toEqual([])
  expect(copyButton()).toBeNull()
})
it("keeps the action available when writing the clipboard fails", async () => {
  await mountSelection()
  window.desktop.clipboard.writeText = async () => {
    throw new Error("clipboard busy")
  }
  await act(async () => copyButton()!.click())
  expect(copied).toBe("")
  expect(copyButton()).not.toBeNull()
})
it("dismisses the floating actions when opening a native context menu", async () => {
  await mountSelection()
  expect(copyButton()).not.toBeNull()
  await act(async () =>
    container.querySelector("p")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }))
  )
  expect(copyButton()).toBeNull()
  expect(window.getSelection()?.toString()).toBe("  中文选区\nsecond line  ")
})
