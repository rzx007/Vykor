// @vitest-environment jsdom
import { act, useRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { MainLayoutContext } from "../layout/main-layout/main-layout-context"
import { SideChatSelectionActions } from "./side-chat-selection-actions"
import { setToastDispatcher } from "@renderer/lib/toast"
import type { DesktopNote } from "@shared/note-types"

let root: Root
let container: HTMLDivElement
let copied: string
let opened: string[]
let saved: DesktopNote[]
let feedback: string[]
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
  saved = []
  feedback = []
  setToastDispatcher({
    showToast: ({ status }) => {
      feedback.push(status ?? "neutral")
      return "feedback"
    },
    updateToast: () => undefined,
    dismissToast: () => undefined,
  })
  Object.assign(window, {
    desktop: {
      notes: {
        create: async ({ content }: { content: string }) => {
          const note = {
            id: `note-${saved.length}`,
            content,
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
          }
          saved.push(note)
          return note
        },
      },
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
  setToastDispatcher(null)
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
function noteButton() {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "添加到便签"
  )
}

it("saves the exact selection as a new note and dismisses the menu after success", async () => {
  await mountSelection()
  expect(noteButton()).toBeDefined()
  await act(async () => noteButton()!.click())
  expect(saved.map((note) => note.content)).toEqual(["  中文选区\nsecond line  "])
  expect(feedback).toEqual(["success"])
  expect(copyButton()).toBeNull()
  expect(opened).toEqual([])
})

it("keeps the selection available to retry after saving a note fails", async () => {
  await mountSelection()
  expect(noteButton()).toBeDefined()
  const create = window.desktop.notes.create
  window.desktop.notes.create = async () => {
    throw new Error("database unavailable")
  }
  await act(async () => noteButton()!.click())
  expect(saved).toEqual([])
  expect(feedback).toEqual(["error"])
  expect(noteButton()?.disabled).toBe(false)
  window.desktop.notes.create = create
  await act(async () => noteButton()!.click())
  expect(saved).toHaveLength(1)
  expect(copyButton()).toBeNull()
})

it("prevents repeated clicks from creating duplicate notes while saving", async () => {
  await mountSelection()
  expect(noteButton()).toBeDefined()
  const create = window.desktop.notes.create
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  window.desktop.notes.create = async (input) => {
    await pending
    return create(input)
  }
  const button = noteButton()!
  await act(async () => {
    button.click()
    button.click()
  })
  expect(button.disabled).toBe(true)
  expect(saved).toEqual([])
  await act(async () => finish())
  expect(saved).toHaveLength(1)
  expect(copyButton()).toBeNull()
})

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
