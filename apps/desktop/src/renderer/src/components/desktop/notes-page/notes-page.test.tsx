// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

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

  // Motion 会在导入时保存动画时钟。先用真实时钟加载，再模拟自动保存计时，
  // 避免后续收纳动画一直等待已经退役的模拟时钟。
  beforeAll(async () => {
    await loadPage()
  })

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    })
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
    // 只模拟自动保存的延时；动画帧和性能时钟保持真实，避免关闭假时钟后
    // Motion 的下一帧被丢弃，连带卡住后续的收纳用例。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
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
    await act(async () => {
      ;(
        container.querySelector(
          'button[aria-label="打开便签：Second thought"]'
        ) as HTMLButtonElement
      ).click()
    })
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
      ;(
        container.querySelector('button[aria-label="打开便签：First thought"]') as HTMLButtonElement
      ).click()
    })

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

  it("shows search results even when the current paper was expanded for reading", async () => {
    await renderPage([first, second])
    await act(async () => {
      ;(
        container.querySelector(
          'button[aria-label="打开便签：Second thought"]'
        ) as HTMLButtonElement
      ).click()
    })
    act(() => {
      ;(container.querySelector('button[aria-label="展开阅读便签"]') as HTMLButtonElement).click()
    })
    act(() =>
      inputValue(
        container.querySelector('input[aria-label="搜索便签"]') as HTMLInputElement,
        "alpha"
      )
    )
    const results = container.querySelector('[aria-label="便签列表"]')
    expect(results).not.toBeNull()
    expect(results?.textContent).toContain("First thought")
    expect(results?.textContent).not.toContain("Second thought")
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(second.content)
  })

  it("saves on folding and preserves the same text when returning to the desk", async () => {
    const api = await renderPage([first])
    const editor = container.querySelector('textarea[aria-label="便签正文"]') as HTMLTextAreaElement
    expect(editor.value).toBe("")
    expect(document.activeElement).toBe(editor)
    act(() => inputValue(editor, "a quick idea"))
    await act(async () => {
      ;(container.querySelector('button[aria-label="收起便签"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('textarea[aria-label="便签正文"]')).toBeNull()
    expect(api.create).toHaveBeenCalledWith({ content: "a quick idea" })
    expect(api.remove).not.toHaveBeenCalled()
    await act(async () => {
      ;(container.querySelector('button[aria-label="桌面形态"]') as HTMLButtonElement).click()
    })
    expect(
      (container.querySelector('textarea[aria-label="便签正文"]') as HTMLTextAreaElement).value
    ).toBe("a quick idea")
  })

  it("keeps a failed save visible and recoverable after folding", async () => {
    await renderPage([], { create: vi.fn().mockRejectedValue(new Error("disk unavailable")) })
    act(() => inputValue(container.querySelector("textarea")!, "keep this idea"))
    await act(async () => {
      ;(container.querySelector('button[aria-label="收起便签"]') as HTMLButtonElement).click()
    })
    expect(container.textContent).toContain("保存失败")
    expect(container.textContent).toContain("disk unavailable")
    expect(localStorage.getItem("vykor.desktop.note-recovery-v1")).toContain("keep this idea")
    await act(async () => {
      ;(container.querySelector('button[aria-label="桌面形态"]') as HTMLButtonElement).click()
    })
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "keep this idea"
    )
  })

  it("opens all papers from the folder rather than limiting the collection to five previews", async () => {
    const records = Array.from({ length: 7 }, (_, index) => ({
      ...first,
      id: `note-${index + 1}`,
      content: `paper ${index + 1}`,
      updatedAt: index + 1,
    }))
    await renderPage(records)
    await act(async () => {
      ;(container.querySelector('button[aria-label="收纳形态"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(container.querySelector('button[aria-label="打开便签收纳夹"]') as HTMLButtonElement).click()
    })
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.querySelectorAll('button[aria-label^="打开便签："]')).toHaveLength(7)
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    const search = dialog.querySelector('input[aria-label="搜索便签"]') as HTMLInputElement
    act(() => {
      search.focus()
      inputValue(search, "paper 1")
    })
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    expect(document.activeElement).toBe(search)
    expect(dialog.querySelectorAll('button[aria-label^="打开便签："]')).toHaveLength(1)
    await act(async () => {
      ;(dialog.querySelector('button[aria-label="打开便签：paper 1"]') as HTMLButtonElement).click()
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("paper 1")
  })

  it("returns keyboard focus to the folder on Escape without deleting or creating a note", async () => {
    const api = await renderPage([first])
    await act(async () => {
      ;(container.querySelector('button[aria-label="收纳形态"]') as HTMLButtonElement).click()
    })
    const folder = container.querySelector(
      'button[aria-label="打开便签收纳夹"]'
    ) as HTMLButtonElement
    await act(async () => {
      folder.click()
    })
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    // 收回过程中纸片仍需存在，才能连续回到夹内；不能先清空再播放遮罩。
    const closing = document.querySelector('[role="dialog"][aria-hidden="true"]')
    expect(closing).not.toBeNull()
    expect(closing!.querySelector('button[aria-label="打开便签：First thought"]')).not.toBeNull()
    // 将真实动画的退出回调也包进 act，避免回调在轮询间隙更新 React。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    await vi.waitFor(
      async () => {
        await act(
          async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        )
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        expect(document.activeElement).toBe(folder)
      },
      { timeout: 1500 }
    )
    expect(api.remove).not.toHaveBeenCalled()
    expect(api.create).not.toHaveBeenCalled()
  })
})
