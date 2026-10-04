// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopNote } from "@shared/note-types"

vi.mock("@renderer/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

async function loadPage(): Promise<React.ComponentType> {
  const path = "./notes-page"
  const module = (await import(/* @vite-ignore */ path).catch(() => null)) as null | {
    NotesPage: React.ComponentType
  }
  expect(module).not.toBeNull()
  return module!.NotesPage
}

function inputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value)
  element.dispatchEvent(new Event("input", { bubbles: true }))
}

const first: DesktopNote = {
  id: "n1",
  content: "First thought\nalpha",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
}
const second: DesktopNote = {
  id: "n2",
  content: "Second thought\nbeta",
  revision: 1,
  createdAt: 2,
  updatedAt: 2,
}

describe("NotesPage", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function renderPage(
    notes: DesktopNote[],
    overrides: Record<string, unknown> = {}
  ): Promise<Record<string, ReturnType<typeof vi.fn>>> {
    const api = {
      list: vi.fn(async () => notes),
      create: vi.fn(async ({ content }: { content: string }) => ({
        id: "created",
        content,
        revision: 1,
        createdAt: 3,
        updatedAt: 3,
      })),
      update: vi.fn(async (id: string, input: { content: string; expectedRevision: number }) => ({
        ...(notes.find((note) => note.id === id) ?? first),
        id,
        content: input.content,
        revision: input.expectedRevision + 1,
        updatedAt: 4,
      })),
      remove: vi.fn(async () => undefined),
      ...overrides,
    }
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        clipboard: { writeText: vi.fn(async () => undefined) },
        notes: api,
      },
    })
    const NotesPage = await loadPage()
    await act(async () => {
      root.render(<NotesPage />)
      await Promise.resolve()
      await Promise.resolve()
    })
    return api as Record<string, ReturnType<typeof vi.fn>>
  }

  it("focuses an empty editor and saves after the first nonblank input", async () => {
    vi.useFakeTimers()
    const create = vi.fn(async ({ content }: { content: string }) => ({
      id: "created",
      content,
      revision: 1,
      createdAt: 3,
      updatedAt: 3,
    }))
    await renderPage([], { create })
    const editor = container.querySelector('textarea[aria-label="便签正文"]') as HTMLTextAreaElement
    expect(document.activeElement).toBe(editor)
    expect(container.querySelector('[aria-label="便签列表"]')?.textContent).not.toContain(
      "无标题便签"
    )

    act(() => {
      inputValue(editor, "idea")
    })
    await act(async () => vi.advanceTimersByTimeAsync(300))
    await act(async () => Promise.resolve())

    expect(create).toHaveBeenCalledWith({ content: "idea" })
    expect(container.textContent).toContain("已保存")
  })

  it("filters only the note list while preserving the selected editor", async () => {
    await renderPage([first, second])
    const search = container.querySelector('input[aria-label="搜索便签"]') as HTMLInputElement
    const list = container.querySelector('[aria-label="便签列表"]')!
    expect(list.textContent).toContain("First thought")
    expect(list.textContent).toContain("Second thought")

    act(() => {
      inputValue(search, "alpha")
    })

    expect(list.textContent).toContain("First thought")
    expect(list.textContent).not.toContain("Second thought")
    expect(
      (container.querySelector('textarea[aria-label="便签正文"]') as HTMLTextAreaElement).value
    ).toBe("Second thought\nbeta")
  })

  it("requires confirmation before removing a note", async () => {
    const remove = vi.fn(async () => undefined)
    await renderPage([first], { remove })

    await act(async () => {
      ;(container.querySelector('button[aria-label="便签操作"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    const deleteItem = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((item) =>
      item.textContent?.includes("删除便签")
    )
    expect(deleteItem).toBeTruthy()
    await act(async () => {
      deleteItem!.click()
      await Promise.resolve()
    })
    expect(remove).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain("删除后无法恢复")

    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "删除"
    )
    expect(confirm).toBeTruthy()
    await act(async () => {
      confirm!.click()
      await Promise.resolve()
    })
    expect(remove).toHaveBeenCalledWith(first.id)
  })
})
