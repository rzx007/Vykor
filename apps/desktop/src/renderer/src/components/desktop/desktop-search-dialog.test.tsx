// @vitest-environment jsdom
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type {
  DesktopSessionRecord,
  DesktopSessionSearchResult,
  SearchSessionsOptions,
} from "@shared/session-types"
import { useDesktopShortcuts } from "./use-desktop-shortcuts"
import { setShortcutBinding } from "./desktop-shortcuts"
import { DesktopSearchDialog } from "./desktop-search-dialog"

let root: Root, host: HTMLDivElement
const onOpenConversation = vi.fn(),
  onNewConversation = vi.fn(),
  onChooseProject = vi.fn(),
  onSearchFiles = vi.fn(),
  onOpenSettings = vi.fn()
const searchSessions =
  vi.fn<(input: SearchSessionsOptions) => Promise<DesktopSessionSearchResult[]>>()
const session = (
  id: string,
  title: string,
  updatedAt: number,
  overrides: Partial<DesktopSessionRecord> = {}
): DesktopSessionRecord => ({
  id,
  title,
  updatedAt,
  createdAt: 1,
  cwd: "D:/projects/OpenHarness-ts",
  projectId: "p1",
  workspaceMode: "project",
  model: "m",
  status: "idle",
  metadata: {},
  ...overrides,
})
function Harness({ initiallyOpen = true }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  useDesktopShortcuts({ searchChats: () => setOpen((value) => !value) })
  return (
    <>
      <input aria-label="聊天输入" />
      <button onClick={() => setOpen(true)}>打开搜索</button>
      <DesktopSearchDialog
        open={open}
        onOpenChange={setOpen}
        onOpenConversation={onOpenConversation}
        onNewConversation={onNewConversation}
        onChooseProject={onChooseProject}
        onSearchFiles={onSearchFiles}
        onOpenSettings={onOpenSettings}
      />
    </>
  )
}
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
async function type(query: string) {
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, query)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
async function key(key: string, extra: KeyboardEventInit = {}) {
  await act(async () => {
    ;(document.querySelector('[role="combobox"]') ?? window).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra })
    )
  })
}
async function render(open = true) {
  await act(async () => root.render(<Harness initiallyOpen={open} />))
}
beforeEach(() => {
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { sessions: { search: searchSessions } },
  })
  searchSessions.mockReset().mockResolvedValue([])
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }))
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  useDesktopSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "OpenHarness-ts",
        path: "D:/projects/OpenHarness-ts",
        lastOpenedAt: 1,
        available: true,
      },
    ],
    sessions: [session("a", "调研 DeepSeek Harness", 3), session("b", "优化搜索界面", 2)],
    archivedSessions: [session("old", "旧搜索方案", 1, { status: "archived" })],
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("desktop chat search", () => {
  it("shows content snippets even when the title does not match and opens the chat", async () => {
    searchSessions.mockResolvedValueOnce([
      {
        session: session("older", "网络调试", 1, { status: "archived" }),
        messageId: "message-1",
        snippet: "这里遇到了 ECONNRESET 连接错误",
      },
    ])
    await render()
    await type("ECONNRESET")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    expect(options()).toHaveLength(1)
    expect(options()[0].textContent).toContain("网络调试")
    expect(options()[0].textContent).toContain("ECONNRESET 连接错误")
    await key("Enter")
    expect(onOpenConversation).toHaveBeenCalledWith("older")
  })
  it("ignores an older response after the query changes", async () => {
    let resolveOld!: (results: DesktopSessionSearchResult[]) => void
    searchSessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    searchSessions.mockResolvedValueOnce([
      {
        session: session("latest", "新结果", 2),
        messageId: "new-message",
        snippet: "最新关键词",
      },
    ])
    await render()
    await type("旧关键词")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    await type("最新关键词")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    await act(async () =>
      resolveOld([
        {
          session: session("old-response", "旧结果", 1),
          messageId: "old-message",
          snippet: "旧关键词",
        },
      ])
    )
    expect(options()).toHaveLength(1)
    expect(options()[0].textContent).toContain("新结果")
    expect(options()[0].textContent).not.toContain("旧结果")
  })
  it("keeps title search available when content search fails and can retry", async () => {
    searchSessions.mockRejectedValueOnce(new Error("daemon unavailable"))
    await render()
    await type("优化")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    expect(options()[0].textContent).toContain("优化搜索界面")
    expect(document.querySelector('[role="status"]')?.textContent).toContain("搜索失败")
    await type("找不到")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    expect(document.querySelector('[role="status"]')?.textContent).toContain("没有找到")
  })
  it("starts a fresh content search after reopening", async () => {
    searchSessions.mockResolvedValueOnce([
      {
        session: session("previous", "上次的结果", 1),
        messageId: "m",
        snippet: "同一个关键词",
      },
    ])
    await render()
    await type("同一个关键词")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    await key("Escape")
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click())
    await type("同一个关键词")
    expect(options()).toHaveLength(0)
    expect(document.querySelector('[role="status"]')?.textContent).toContain("正在搜索")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    expect(options()).toHaveLength(0)
  })
  it("shows recent chats with their projects and only implemented settings", async () => {
    await render()
    expect(options()[0].textContent).toContain("调研 DeepSeek Harness")
    expect(options()[0].textContent).toContain("OpenHarness-ts")
    expect(options()[0].textContent).toContain("Alt+1")
    expect(options().some((item) => item.textContent?.includes("使用情况和计费"))).toBe(false)
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
  })
  it("matches Chinese and case-insensitive title/project words together", async () => {
    await render()
    await type("deepseek openharness")
    expect(options()).toHaveLength(1)
    expect(options()[0].textContent).toContain("调研 DeepSeek Harness")
    await type("优化 搜索")
    expect(options()).toHaveLength(1)
    expect(options()[0].textContent).toContain("优化搜索界面")
  })
  it("finds archived chats and navigates without changing their archived state", async () => {
    await render()
    await type("旧搜索方案")
    expect(options()).toHaveLength(1)
    await act(async () => options()[0].click())
    expect(onOpenConversation).toHaveBeenCalledWith("old")
    expect(useDesktopSessionStore.getState().archivedSessions[0].status).toBe("archived")
  })
  it("limits initial chats to nine but searches older records when a query is entered", async () => {
    useDesktopSessionStore.setState({
      sessions: Array.from({ length: 15 }, (_, i) =>
        session("s" + i, i === 0 ? "最早的独立对话" : "历史会话 " + i, i)
      ),
    })
    await render()
    expect(options().filter((item) => item.textContent?.includes("历史会话"))).toHaveLength(9)
    await type("最早的独立对话")
    expect(options()).toHaveLength(1)
    await key("Enter")
    expect(onOpenConversation).toHaveBeenCalledWith("s0")
  })
  it("never exposes child agents or memory-only chats", async () => {
    useDesktopSessionStore.setState({
      sessions: [
        session("child", "私有子任务", 10, { parentId: "a" }),
        session("memory", "临时内存会话", 11, { storage: "memory" }),
        session("root", "普通对话", 2),
      ],
    })
    await render()
    await type("私有子任务")
    expect(options()).toHaveLength(0)
    await type("临时内存会话")
    expect(options()).toHaveLength(0)
    await type("普通对话")
    expect(options()).toHaveLength(1)
  })
  it("uses arrows and Enter to open the highlighted filtered chat", async () => {
    await render()
    await type("搜索")
    await key("ArrowDown")
    await key("Enter")
    expect(onOpenConversation).toHaveBeenCalledWith("old")
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
  it("makes Alt+1 select the first filtered chat, not the first original chat", async () => {
    await render()
    await type("优化搜索界面")
    expect(options()[0].textContent).toContain("Alt+1")
    await key("1", { altKey: true, code: "Digit1" })
    expect(onOpenConversation).toHaveBeenCalledWith("b")
  })
  it("does not select a chat when Enter confirms IME composition", async () => {
    await render()
    await type("调研")
    await key("Enter", { isComposing: true })
    expect(onOpenConversation).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
  })
  it("opens once with Ctrl+K and closes with Escape while the composer is focused", async () => {
    await render(false)
    const composer = host.querySelector<HTMLInputElement>('[aria-label="聊天输入"]')!
    composer.focus()
    await act(async () =>
      composer.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "k",
          code: "KeyK",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      )
    )
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
    await key("Escape")
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
  it("runs quick actions and navigates directly to a selected settings page", async () => {
    await render()
    await type("外观")
    await act(async () => options()[0].click())
    expect(onOpenSettings).toHaveBeenCalledWith("appearance")
    await act(async () => host.querySelector("button")!.click())
    await type("新对话")
    await act(async () => options()[0].click())
    expect(onNewConversation).toHaveBeenCalledOnce()
    await act(async () => host.querySelector("button")!.click())
    await type("打开文件夹")
    await act(async () => options()[0].click())
    expect(onChooseProject).toHaveBeenCalledOnce()
    await act(async () => host.querySelector("button")!.click())
    await type("搜索文件")
    await act(async () => options()[0].click())
    expect(onSearchFiles).toHaveBeenCalledOnce()
  })
  it("shows a useful empty result state and resets its query when reopened", async () => {
    await render()
    await type("zzzz不存在的聊天")
    expect(options()).toHaveLength(0)
    expect(document.body.textContent).toContain("正在搜索")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    expect(document.body.textContent).toContain("没有找到")
    await key("Escape")
    await act(async () => host.querySelector("button")!.click())
    expect(document.querySelector<HTMLInputElement>('[role="combobox"]')?.value).toBe("")
    expect(options()[0].textContent).toContain("调研 DeepSeek Harness")
  })

  it("uses an edited search shortcut without leaving the original Ctrl+K listener active", async () => {
    await render(false)
    try {
      await act(async () => {
        setShortcutBinding("searchChats", "$mod+Shift+KeyF", "Shift+F")
      })
      await key("k", { code: "KeyK", ctrlKey: true })
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      await key("F", { code: "KeyF", ctrlKey: true, shiftKey: true })
      expect(document.querySelector('[role="dialog"]')).toBeTruthy()
    } finally {
      await act(async () => {
        setShortcutBinding("searchChats", "$mod+k", "K")
      })
    }
  })

  it("updates action shortcut hints when keyboard settings change", async () => {
    await render()
    expect(options().find((item) => item.textContent?.includes("新对话"))?.textContent).toContain(
      "Ctrl+N"
    )
    try {
      await act(async () => {
        setShortcutBinding("newConversation", "$mod+Shift+KeyY", "Shift+Y")
      })
      expect(options().find((item) => item.textContent?.includes("新对话"))?.textContent).toContain(
        "Ctrl+Shift+Y"
      )
    } finally {
      await act(async () => {
        setShortcutBinding("newConversation", "$mod+n", "N")
      })
    }
  })
})
